import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { blindIndex, decryptedField, encryptedField, maskRegisterNo } from '@los/database';
import {
  BorrowerCandidate, BorrowerListResponse, BorrowerMutationResponse, BorrowerWarning, BorrowersChanged, StepKey,
  type BorrowerRole,
} from '@los/contracts';
import { DomainEvents } from '../../shared/domain-events';
import { createTestApp, OutboxRelayService, TestApp } from '../../test-utils/test-app';
import { actors, createApplication, createBorrower, createCustomer, hasTestDb, ORG, resetDb } from '../../test-utils/factories';
import { BorrowerModule } from './borrower.module';

// Stream B — хамтран зээлдэгч ба батлан даагч. HTTP түвшний integration тест (supertest + бодит Postgres).
describe.skipIf(!hasTestDb)('borrower API (DB)', () => {
  let t: TestApp;
  const officer = actors.officer();

  let baseUrl: string;
  beforeAll(async () => {
    t = await createTestApp([BorrowerModule]);
    // supertest өөрөө сервер асаах/унтраах нь зэрэгцээ хүсэлтэд эвгүй тул нэг удаа ephemeral порт дээр асаана.
    await t.app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => { await t.close(); });
  beforeEach(async () => { await resetDb(t.prisma); vi.restoreAllMocks(); });

  // ── туслахууд ─────────────────────────────────────────────────────────────────────────
  const http = () => request(baseUrl);
  const url = (appId: string, ...rest: string[]) => ['/api/applications', appId, 'borrowers', ...rest].join('/');
  const newApp = (o: Parameters<typeof createApplication>[1] = {}) => createApplication(t.prisma, o);
  const cust = (o: Parameters<typeof createCustomer>[1] = {}) => createCustomer(t.prisma, o);
  const add = (appId: string, body: Record<string, unknown>, actor: Record<string, string> = officer) => http().post(url(appId)).set(actor).send(body);
  const list = (appId: string, actor: Record<string, string> = officer) => http().get(url(appId)).set(actor);

  /** Нэмээд 201-ийг баталгаажуулж, хариуг DTO-оор parse хийнэ. */
  async function addOk(appId: string, customerId: string, role: BorrowerRole, extra: Record<string, unknown> = {}) {
    const res = await add(appId, { customerId, role, ...extra });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return BorrowerMutationResponse.parse(res.body);
  }
  async function listOk(appId: string, actor: Record<string, string> = officer) {
    const res = await list(appId, actor);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return BorrowerListResponse.parse(res.body);
  }
  const rowsOf = (appId: string) => t.prisma.loanApplicationBorrower.findMany({ where: { applicationId: appId }, orderBy: { createdAt: 'asc' } });
  const events = async () => (await t.prisma.outbox.findMany({ orderBy: { createdAt: 'asc' } })).filter((r) => r.type === 'BorrowersChanged').map((r) => BorrowersChanged.parse(r.payload));

  async function seedSteps(appId: string, status: Partial<Record<StepKey, string>> = {}, fallback = 'PENDING') {
    await t.prisma.loanApplicationStep.createMany({
      data: StepKey.map((stepKey) => ({ orgId: ORG, applicationId: appId, stepKey, status: status[stepKey] ?? fallback, ...((status[stepKey] ?? fallback) === 'COMPLETED' ? { completedAt: new Date('2026-10-01T00:00:00Z') } : {}) })),
    });
  }
  const step = (appId: string, key: StepKey) => t.prisma.loanApplicationStep.findUniqueOrThrow({ where: { applicationId_stepKey: { applicationId: appId, stepKey: key } } });

  /** Өгөгдлийн сангийн инвариантууд: ≤1 PRIMARY, isPrimary ⇔ role=PRIMARY, (app, customer, role) давхардалгүй. */
  async function expectInvariants(appId: string) {
    const rows = await rowsOf(appId);
    expect(rows.filter((r) => r.role === 'PRIMARY').length).toBeLessThanOrEqual(1);
    for (const r of rows) expect(r.isPrimary, `${r.role}`).toBe(r.role === 'PRIMARY');
    expect(new Set(rows.map((r) => `${r.customerId}|${r.role}`)).size).toBe(rows.length);
    expect(rows.filter((r) => r.isPrimary).length).toBe(rows.filter((r) => r.role === 'PRIMARY').length);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('эрх (NFR-3, 13)', () => {
    const endpoints = (appId: string, borrowerId = 'b1') => [
      ['GET', url(appId)], ['GET', url(appId, 'candidates') + '?registerNo=УБ12345678'], ['POST', url(appId)], ['PATCH', url(appId, borrowerId)],
      ['DELETE', url(appId, borrowerId)], ['POST', url(appId, borrowerId, 'make-primary')], ['POST', url(appId, borrowerId, 'consent')],
    ] as const;
    const send = (method: string, path: string, headers: Record<string, string>): request.Test => {
      const agent = http();
      switch (method) {
        case 'GET': return agent.get(path).set(headers);
        case 'DELETE': return agent.delete(path).set(headers);
        case 'PATCH': return agent.patch(path).set(headers).send({});
        default: return agent.post(path).set(headers).send({});
      }
    };

    it('нэвтрээгүй → 401 UNAUTHENTICATED (бүх endpoint)', async () => {
      const app = await newApp();
      for (const [m, p] of endpoints(app.id)) {
        const res = await send(m, p, actors.anonymous());
        expect([m, p, res.status]).toEqual([m, p, 401]);
        expect(res.body.code).toBe('UNAUTHENTICATED');
      }
    });

    it('CUSTOMER дүр → 403 FORBIDDEN (бүх endpoint)', async () => {
      const app = await newApp();
      const c = await cust(); await createBorrower(t.prisma, app.id, c.id, 'PRIMARY');
      for (const [m, p] of endpoints(app.id)) {
        const res = await send(m, p, actors.customer(c.id));
        expect([m, p, res.status]).toEqual([m, p, 403]);
      }
    });

    it('BRANCH_MANAGER ба APPROVER бичихгүй (мутаци + хайлт → 403), хэн ч мэдээлэл өөрчлөөгүй', async () => {
      const app = await newApp();
      const c = await cust();
      for (const actor of [actors.branchManager(), actors.approver()]) {
        expect((await add(app.id, { customerId: c.id, role: 'PRIMARY' }, actor)).status).toBe(403);
        expect((await http().get(url(app.id, 'candidates')).query({ registerNo: 'УБ1' }).set(actor)).status).toBe(403);
        expect((await http().patch(url(app.id, 'x')).set(actor).send({ note: 'a' })).status).toBe(403);
        expect((await http().delete(url(app.id, 'x')).set(actor)).status).toBe(403);
      }
      expect(await rowsOf(app.id)).toHaveLength(0);
    });

    it('унших: өөрийн ЗЭЗ, өөрийн салбарын захирал, батлагч, админ → 200; бусад ЗЭЗ / өөр салбар → 403', async () => {
      const app = await newApp({ officerId: 'officer-1', branchId: 'branch-1' });
      for (const actor of [actors.officer('officer-1'), actors.branchManager('bm', 'branch-1'), actors.approver(), actors.admin()]) expect((await list(app.id, actor)).status).toBe(200);
      for (const actor of [actors.officer('officer-2'), actors.branchManager('bm', 'branch-2')]) {
        const res = await list(app.id, actor);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('FORBIDDEN');
      }
    });

    it('бичих: өөр ЗЭЗ → 403 (мөр нэмэгдэхгүй), өөрийн ЗЭЗ ба ADMIN → 201', async () => {
      const app = await newApp({ officerId: 'officer-1' });
      const [a, b, c] = [await cust(), await cust(), await cust()];
      const denied = await add(app.id, { customerId: a.id, role: 'PRIMARY' }, actors.officer('officer-2'));
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe('FORBIDDEN');
      expect(await rowsOf(app.id)).toHaveLength(0);
      expect((await add(app.id, { customerId: a.id, role: 'PRIMARY' })).status).toBe(201);
      expect((await add(app.id, { customerId: b.id, role: 'GUARANTOR' }, actors.admin())).status).toBe(201);
      expect((await add(app.id, { customerId: c.id, role: 'PLEDGOR' }, actors.officer('officer-2'))).status).toBe(403);
    });

    it('хүсэлт олдохгүй / өөр байгууллагын хүсэлт → 404 APPLICATION_NOT_FOUND', async () => {
      const c = await cust();
      for (const res of [await list('missing'), await add('missing', { customerId: c.id, role: 'PRIMARY' })]) {
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('APPLICATION_NOT_FOUND');
      }
      const app = await newApp();
      expect((await list(app.id, { ...officer, 'x-org-id': 'other-org' })).status).toBe(404);
    });

    it('өөр хүсэлтийн borrowerId-тэй PATCH/DELETE/make-primary/consent → 404 BORROWER_NOT_FOUND', async () => {
      const a1 = await newApp(); const a2 = await newApp();
      const c = await cust();
      const { borrower } = await addOk(a1.id, c.id, 'PRIMARY');
      const attempts = [
        http().patch(url(a2.id, borrower.id)).set(officer).send({ note: 'x' }), http().delete(url(a2.id, borrower.id)).set(officer),
        http().post(url(a2.id, borrower.id, 'make-primary')).set(officer), http().post(url(a2.id, borrower.id, 'consent')).set(officer).send({ fileId: 'f', signedAt: '2026-10-27T00:00:00Z' }),
        http().patch(url(a1.id, 'missing')).set(officer).send({ note: 'x' }),
      ];
      for (const r of attempts) {
        const res = await r;
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('BORROWER_NOT_FOUND');
      }
      expect(await rowsOf(a1.id)).toHaveLength(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('оролтын шалгалт (400 VALIDATION_FAILED)', () => {
    it.each([
      ['дүр буруу', { role: 'BOSS' }],
      ['customerId байхгүй', { customerId: undefined }],
      ['хувь 0', { role: 'CO_BORROWER', liabilityShare: 0 }],
      ['хувь 1-ээс их', { role: 'CO_BORROWER', liabilityShare: 1.01 }],
      ['хувь 4 оронгоос бага (0.00001)', { role: 'CO_BORROWER', liabilityShare: 0.00001 }],
      ['liabilityShare батлан даагчид', { role: 'GUARANTOR', liabilityShare: 0.5 }],
      ['liabilityShare үндсэнд', { role: 'PRIMARY', liabilityShare: 0.5 }],
      ['guaranteeType хамтран зээлдэгчид', { role: 'CO_BORROWER', guaranteeType: 'JOINT_AND_SEVERAL' }],
      ['guaranteeAmount барьцаалагчид', { role: 'PLEDGOR', guaranteeType: 'LIMITED', guaranteeAmount: 1000 }],
      ['LIMITED дүнгүй', { role: 'GUARANTOR', guaranteeType: 'LIMITED' }],
      ['JOINT_AND_SEVERAL дүнтэй', { role: 'GUARANTOR', guaranteeType: 'JOINT_AND_SEVERAL', guaranteeAmount: 1000 }],
      ['дүн төрөлгүй', { role: 'GUARANTOR', guaranteeAmount: 1000 }],
      ['дүн сөрөг', { role: 'GUARANTOR', guaranteeType: 'LIMITED', guaranteeAmount: -5 }],
      ['relationToPrimary үндсэнд', { role: 'PRIMARY', relationToPrimary: 'SPOUSE' }],
      ['relationToPrimary утга буруу', { role: 'CO_BORROWER', relationToPrimary: 'ENEMY' }],
      ['incomeIncluded boolean биш', { role: 'CO_BORROWER', incomeIncluded: 'yes' }],
      ['note хэт урт', { role: 'PLEDGOR', note: 'a'.repeat(1001) }],
    ])('нэмэх: %s → 400', async (_name, patch) => {
      const app = await newApp(); const c = await cust();
      const res = await add(app.id, { customerId: c.id, role: 'PRIMARY', ...patch });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.any(String) });
      expect(res.body.details.length).toBeGreaterThan(0);
      expect(await rowsOf(app.id)).toHaveLength(0);
    });

    it('PATCH: хоосон биет, буруу утга → 400; consent: буруу огноо / fileId байхгүй → 400', async () => {
      const app = await newApp(); const c = await cust();
      const { borrower } = await addOk(app.id, c.id, 'PRIMARY');
      expect((await http().patch(url(app.id, borrower.id)).set(officer).send({})).status).toBe(400);
      expect((await http().patch(url(app.id, borrower.id)).set(officer).send({ incomeIncluded: null })).status).toBe(400);
      expect((await http().patch(url(app.id, borrower.id)).set(officer).send({ liabilityShare: 2 })).status).toBe(400);
      for (const body of [{ fileId: 'f', signedAt: 'өчигдөр' }, { fileId: 'f', signedAt: '2026-10-27' }, { signedAt: '2026-10-27T00:00:00Z' }, { fileId: '', signedAt: '2026-10-27T00:00:00Z' }])
        expect((await http().post(url(app.id, borrower.id, 'consent')).set(officer).send(body)).status).toBe(400);
    });

    // JSON.stringify нь Infinity-г null болгодог тул raw JSON мөрийг шууд илгээнэ: `1e999` → JSON.parse → Infinity.
    const rawJson = (method: 'post' | 'patch', path: string, body: string) => http()[method](path).set(officer).set('Content-Type', 'application/json').send(body);

    it.each(['1e999', '-1e999', '1e16', '1e17', '1e300', '10000000000000', '9999999999999.995'])('нэмэх: guaranteeAmount=%s (Infinity / numeric(18,2) overflow) → 400 VALIDATION_FAILED, мөр үүсэхгүй', async (amount) => {
      const app = await newApp(); const c = await cust();
      const res = await rawJson('post', url(app.id), `{"customerId":"${c.id}","role":"GUARANTOR","guaranteeType":"LIMITED","guaranteeAmount":${amount}}`);
      expect([amount, res.status, res.body.code]).toEqual([amount, 400, 'VALIDATION_FAILED']);
      expect(res.body.details.map((i: { path: string }) => i.path)).toContain('guaranteeAmount');
      expect(await rowsOf(app.id)).toHaveLength(0);
      expect(await events()).toHaveLength(0);
    });

    it('нэмэх: баталгааны дээд хязгаар (9,999,999,999,999.99) яг хадгалагдана; LIMITED ба дүн DB-д алдагдахгүй', async () => {
      const app = await newApp(); const c = await cust();
      const res = await rawJson('post', url(app.id), `{"customerId":"${c.id}","role":"GUARANTOR","guaranteeType":"LIMITED","guaranteeAmount":9999999999999.99}`);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.borrower).toMatchObject({ guaranteeType: 'LIMITED', guaranteeAmount: 9_999_999_999_999.99 });
      const [row] = await rowsOf(app.id);
      expect(row.guaranteeType).toBe('LIMITED');
      expect(Number(row.guaranteeAmount)).toBe(9_999_999_999_999.99);
    });

    it.each(['1e999', '1e16', '1e17'])('PATCH: guaranteeAmount=%s → 400 VALIDATION_FAILED, өмнөх баталгаа өөрчлөгдөхгүй', async (amount) => {
      const app = await newApp();
      const g = await addOk(app.id, (await cust()).id, 'GUARANTOR', { guaranteeType: 'LIMITED', guaranteeAmount: 5_000_000 });
      const res = await rawJson('patch', url(app.id, g.borrower.id), `{"guaranteeAmount":${amount}}`);
      expect([amount, res.status, res.body.code]).toEqual([amount, 400, 'VALIDATION_FAILED']);
      const [row] = await rowsOf(app.id);
      expect([row.guaranteeType, Number(row.guaranteeAmount)]).toEqual(['LIMITED', 5_000_000]);
      expect(await events()).toHaveLength(1); // зөвхөн ADDED
    });

    it('candidates: registerNo байхгүй / хоосон / хэт урт → 400', async () => {
      const app = await newApp();
      for (const q of ['', '?registerNo=', '?registerNo=%20%20', `?registerNo=${'A'.repeat(33)}`, '?registerNo=a&registerNo=b']) {
        const res = await http().get(url(app.id, 'candidates') + q).set(officer);
        expect([q, res.status]).toEqual([q, 400]);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('1. төлөв: зөвхөн DRAFT / RETURNED үед засна (FR-10.4)', () => {
    it.each(['SUBMITTED', 'IN_APPROVAL', 'APPROVED', 'DISBURSING', 'ACTIVE', 'CLOSED', 'MIGRATED'])('%s: нэмэх → 409 APPLICATION_NOT_EDITABLE, мөр/event/алхам өөрчлөгдөхгүй', async (status) => {
      const app = await newApp({ status });
      await seedSteps(app.id, { client: 'COMPLETED' });
      const c = await cust();
      const res = await add(app.id, { customerId: c.id, role: 'PRIMARY' });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'APPLICATION_NOT_EDITABLE', details: { status } });
      expect(await rowsOf(app.id)).toHaveLength(0);
      expect(await t.prisma.outbox.count()).toBe(0);
      expect((await step(app.id, 'client')).status).toBe('COMPLETED');
    });

    it('SUBMITTED: PATCH / DELETE / make-primary / consent бүгд 409; унших нь 200 (editable=false)', async () => {
      const app = await newApp({ status: 'DRAFT' });
      const [p, co] = [await cust(), await cust()];
      const a = await addOk(app.id, p.id, 'PRIMARY'); const b = await addOk(app.id, co.id, 'CO_BORROWER');
      await t.prisma.loanApplication.update({ where: { id: app.id }, data: { status: 'SUBMITTED' } });
      const evBefore = await t.prisma.outbox.count();
      const results = [
        await http().patch(url(app.id, a.borrower.id)).set(officer).send({ note: 'x' }), await http().delete(url(app.id, b.borrower.id)).set(officer),
        await http().post(url(app.id, b.borrower.id, 'make-primary')).set(officer), await http().post(url(app.id, b.borrower.id, 'consent')).set(officer).send({ fileId: 'f', signedAt: '2026-10-27T00:00:00Z' }),
      ];
      for (const r of results) { expect(r.status).toBe(409); expect(r.body.code).toBe('APPLICATION_NOT_EDITABLE'); }
      expect(await rowsOf(app.id)).toHaveLength(2);
      expect(await t.prisma.outbox.count()).toBe(evBefore);
      const view = await listOk(app.id);
      expect(view.items).toHaveLength(2);
      expect(view.summary.editable).toBe(false);
    });

    it('DRAFT ба RETURNED: editable=true, нэмэх 201', async () => {
      for (const status of ['DRAFT', 'RETURNED']) {
        const app = await newApp({ status });
        const c = await cust();
        const res = await addOk(app.id, c.id, 'PRIMARY');
        expect(res.summary.editable).toBe(true);
      }
    });

    it('хүсэлтийн төлөв шалгалтын дараа өөрчлөгдвөл (түгжээ авсны дараа дахин уншина) 409', async () => {
      const app = await newApp({ status: 'DRAFT' });
      const c = await cust();
      // Түгжээг гаднаас барьж байгаад хүсэлтийг SUBMITTED болгоод суллана: нэмэх хүсэлт түгжээ хүлээгээд, суллагдсаны дараа шинэ төлвийг харна.
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const holder = t.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM origination.loan_application WHERE id = ${app.id} FOR UPDATE`;
        await tx.loanApplication.update({ where: { id: app.id }, data: { status: 'SUBMITTED' } });
        await gate;
      });
      await new Promise((r) => setTimeout(r, 150));
      const pending = add(app.id, { customerId: c.id, role: 'PRIMARY' }).then((r) => r);
      await new Promise((r) => setTimeout(r, 300));
      release();
      await holder;
      const res = await pending;
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('APPLICATION_NOT_EDITABLE');
      expect(await rowsOf(app.id)).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('2. үндсэн зээлдэгч', () => {
    it('эхний нэмэлт PRIMARY байх албагүй; дараа нь PRIMARY нэмж болно; isPrimary тохирно', async () => {
      const app = await newApp();
      const [g, p] = [await cust(), await cust()];
      const first = await addOk(app.id, g.id, 'GUARANTOR');
      expect(first.summary).toMatchObject({ primaryCount: 0, clientStepComplete: false, guarantorCount: 1 });
      expect(first.borrower).toMatchObject({ role: 'GUARANTOR', isPrimary: false });
      const second = await addOk(app.id, p.id, 'PRIMARY');
      expect(second.borrower).toMatchObject({ role: 'PRIMARY', isPrimary: true });
      expect(second.summary).toMatchObject({ primaryCount: 1, clientStepComplete: true });
      await expectInvariants(app.id);
    });

    it('хоёр дахь PRIMARY → 409 PRIMARY_EXISTS', async () => {
      const app = await newApp();
      const [a, b] = [await cust(), await cust()];
      await addOk(app.id, a.id, 'PRIMARY');
      const res = await add(app.id, { customerId: b.id, role: 'PRIMARY' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PRIMARY_EXISTS');
      expect(await rowsOf(app.id)).toHaveLength(1);
      expect(await events()).toHaveLength(1);
    });

    it('PRIMARY-г хасах: бусад оролцогч байвал 409 PRIMARY_REQUIRED (бүх дүрээр)', async () => {
      for (const other of ['CO_BORROWER', 'GUARANTOR', 'PLEDGOR'] as const) {
        const app = await newApp();
        const [p, o] = [await cust(), await cust()];
        const a = await addOk(app.id, p.id, 'PRIMARY'); await addOk(app.id, o.id, other);
        const res = await http().delete(url(app.id, a.borrower.id)).set(officer);
        expect([other, res.status, res.body.code]).toEqual([other, 409, 'PRIMARY_REQUIRED']);
        expect(await rowsOf(app.id)).toHaveLength(2);
      }
    });

    it('эхлээд make-primary хийвэл хуучин үндсэнг хасаж болно', async () => {
      const app = await newApp();
      const [p, co] = [await cust(), await cust()];
      const a = await addOk(app.id, p.id, 'PRIMARY'); const b = await addOk(app.id, co.id, 'CO_BORROWER');
      expect((await http().post(url(app.id, b.borrower.id, 'make-primary')).set(officer)).status).toBe(200);
      // a одоо CO_BORROWER
      const del = await http().delete(url(app.id, a.borrower.id)).set(officer);
      expect(del.status).toBe(204);
      expect(del.text).toBe('');
      const view = await listOk(app.id);
      expect(view.items.map((i) => [i.customerId, i.role])).toEqual([[co.id, 'PRIMARY']]);
      await expectInvariants(app.id);
    });

    it('ганц үлдсэн PRIMARY-г хасаж болно → client алхам PENDING', async () => {
      const app = await newApp();
      await seedSteps(app.id);
      const c = await cust();
      const a = await addOk(app.id, c.id, 'PRIMARY');
      expect((await step(app.id, 'client')).status).toBe('COMPLETED');
      expect((await http().delete(url(app.id, a.borrower.id)).set(officer)).status).toBe(204);
      expect(await rowsOf(app.id)).toHaveLength(0);
      const client = await step(app.id, 'client');
      expect(client).toMatchObject({ status: 'PENDING', completedAt: null });
      expect((await listOk(app.id)).summary).toMatchObject({ primaryCount: 0, clientStepComplete: false });
    });

    describe('make-primary', () => {
      it('CO_BORROWER → PRIMARY, одоогийн үндсэн → CO_BORROWER; хариуд шинэ үндсэн', async () => {
        const app = await newApp();
        const [p, co] = [await cust(), await cust()];
        const a = await addOk(app.id, p.id, 'PRIMARY', { incomeIncluded: true });
        const b = await addOk(app.id, co.id, 'CO_BORROWER', { relationToPrimary: 'SPOUSE', liabilityShare: 0.4 });
        const res = await http().post(url(app.id, b.borrower.id, 'make-primary')).set(officer);
        expect(res.status).toBe(200);
        const body = BorrowerMutationResponse.parse(res.body);
        expect(body.borrower).toMatchObject({ id: b.borrower.id, customerId: co.id, role: 'PRIMARY', isPrimary: true, relationToPrimary: null, liabilityShare: null });
        expect(body.summary).toMatchObject({ primaryCount: 1, coBorrowerCount: 1 });
        const rows = await rowsOf(app.id);
        expect(rows.find((r) => r.id === a.borrower.id)).toMatchObject({ role: 'CO_BORROWER', isPrimary: false, customerId: p.id });
        expect(rows.find((r) => r.id === b.borrower.id)).toMatchObject({ role: 'PRIMARY', isPrimary: true });
        await expectInvariants(app.id);
      });

      it('хувь тогтоосон бол хуваарь хадгалагдана: үндсэн 60% / хамтран 40% → солигдоход үндсэн 40% / хамтран 60%', async () => {
        const app = await newApp();
        const [p, co] = [await cust(), await cust()];
        const a = await addOk(app.id, p.id, 'PRIMARY');
        const b = await addOk(app.id, co.id, 'CO_BORROWER', { liabilityShare: 0.4 });
        expect(b.summary.primaryLiabilityShare).toBe(0.6);
        const res = BorrowerMutationResponse.parse((await http().post(url(app.id, b.borrower.id, 'make-primary')).set(officer)).body);
        expect(res.summary.primaryLiabilityShare).toBe(0.4);
        const view = await listOk(app.id);
        expect(view.items.find((i) => i.id === a.borrower.id)).toMatchObject({ role: 'CO_BORROWER', liabilityShare: 0.6 });
      });

      it('event: PRIMARY_CHANGED (шинэ үндсэн), borrowers[] шинэ дүрүүдтэй', async () => {
        const app = await newApp();
        const [p, co] = [await cust(), await cust()];
        await addOk(app.id, p.id, 'PRIMARY'); const b = await addOk(app.id, co.id, 'CO_BORROWER');
        await http().post(url(app.id, b.borrower.id, 'make-primary')).set(officer);
        const evs = await events();
        expect(evs).toHaveLength(3);
        expect(evs[2]).toMatchObject({ change: 'PRIMARY_CHANGED', customerId: co.id, role: 'PRIMARY', applicationId: app.id });
        expect(evs[2].borrowers).toEqual(expect.arrayContaining([{ customerId: co.id, role: 'PRIMARY', incomeIncluded: true }, { customerId: p.id, role: 'CO_BORROWER', incomeIncluded: true }]));
      });

      it('давтан дуудахад noop 200 (event нэмэгдэхгүй)', async () => {
        const app = await newApp();
        const [p, co] = [await cust(), await cust()];
        await addOk(app.id, p.id, 'PRIMARY'); const b = await addOk(app.id, co.id, 'CO_BORROWER');
        const first = await http().post(url(app.id, b.borrower.id, 'make-primary')).set(officer);
        const second = await http().post(url(app.id, b.borrower.id, 'make-primary')).set(officer);
        expect([first.status, second.status]).toEqual([200, 200]);
        expect(second.body.borrower.role).toBe('PRIMARY');
        expect(await events()).toHaveLength(3);
        await expectInvariants(app.id);
      });

      it('GUARANTOR / PLEDGOR-г үндсэн болгож болохгүй → 409 NOT_CO_BORROWER', async () => {
        const app = await newApp();
        const [p, g, pl] = [await cust(), await cust(), await cust()];
        await addOk(app.id, p.id, 'PRIMARY'); const gb = await addOk(app.id, g.id, 'GUARANTOR'); const plb = await addOk(app.id, pl.id, 'PLEDGOR');
        for (const b of [gb, plb]) {
          const res = await http().post(url(app.id, b.borrower.id, 'make-primary')).set(officer);
          expect([res.status, res.body.code]).toEqual([409, 'NOT_CO_BORROWER']);
        }
        await expectInvariants(app.id);
      });

      it('үндсэн нь хуулийн этгээд бол хамтран зээлдэгч болж чадахгүй → 422 ENTITY_CANNOT_CO_BORROW, өөрчлөлтгүй', async () => {
        const app = await newApp();
        const [ent, person] = [await cust({ customerType: 'LEGAL_ENTITY' }), await cust()];
        const a = await addOk(app.id, ent.id, 'PRIMARY'); const b = await addOk(app.id, person.id, 'CO_BORROWER');
        const res = await http().post(url(app.id, b.borrower.id, 'make-primary')).set(officer);
        expect([res.status, res.body.code]).toEqual([422, 'ENTITY_CANNOT_CO_BORROW']);
        const rows = await rowsOf(app.id);
        expect(rows.find((r) => r.id === a.borrower.id)?.role).toBe('PRIMARY');
        expect(rows.find((r) => r.id === b.borrower.id)?.role).toBe('CO_BORROWER');
      });

      it('үндсэн байхгүй үед хамтран зээлдэгчийг шууд үндсэн болгоно', async () => {
        const app = await newApp();
        const co = await cust();
        const b = await addOk(app.id, co.id, 'CO_BORROWER');
        const res = BorrowerMutationResponse.parse((await http().post(url(app.id, b.borrower.id, 'make-primary')).set(officer)).body);
        expect(res.borrower.role).toBe('PRIMARY');
        expect(res.summary.clientStepComplete).toBe(true);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('3. давхардал ба дүрийн хослол', () => {
    it.each(['PRIMARY', 'CO_BORROWER', 'GUARANTOR', 'PLEDGOR'] as const)('ижил харилцагч ижил %s дүр → 409 BORROWER_DUPLICATE', async (role) => {
      const app = await newApp(); const c = await cust();
      await addOk(app.id, c.id, role);
      const res = await add(app.id, { customerId: c.id, role });
      expect([res.status, res.body.code]).toEqual([409, 'BORROWER_DUPLICATE']);
      expect(await rowsOf(app.id)).toHaveLength(1);
      expect(await events()).toHaveLength(1);
    });

    it.each([
      ['PRIMARY', 'CO_BORROWER'], ['PRIMARY', 'GUARANTOR'], ['CO_BORROWER', 'GUARANTOR'],
      ['CO_BORROWER', 'PRIMARY'], ['GUARANTOR', 'PRIMARY'], ['GUARANTOR', 'CO_BORROWER'],
    ] as const)('нэг харилцагч %s + %s → 409 ROLE_CONFLICT', async (first, second) => {
      const app = await newApp(); const c = await cust();
      await addOk(app.id, c.id, first);
      const res = await add(app.id, { customerId: c.id, role: second });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ROLE_CONFLICT');
      expect(await rowsOf(app.id)).toHaveLength(1);
    });

    it.each([
      ['PRIMARY', 'PLEDGOR'], ['PLEDGOR', 'PRIMARY'], ['CO_BORROWER', 'PLEDGOR'], ['PLEDGOR', 'CO_BORROWER'], ['GUARANTOR', 'PLEDGOR'], ['PLEDGOR', 'GUARANTOR'],
    ] as const)('нэг харилцагч %s + %s → зөвшөөрнө (PLEDGOR хослол)', async (first, second) => {
      const app = await newApp(); const c = await cust();
      await addOk(app.id, c.id, first);
      await addOk(app.id, c.id, second);
      expect(await rowsOf(app.id)).toHaveLength(2);
      await expectInvariants(app.id);
    });

    it('PRIMARY+PLEDGOR харилцагчийг CO_BORROWER болгож нэмэх → ROLE_CONFLICT; нэг харилцагч өөр хүсэлтэд өөр дүртэй байж болно', async () => {
      const app = await newApp(); const other = await newApp(); const c = await cust();
      await addOk(app.id, c.id, 'PRIMARY'); await addOk(app.id, c.id, 'PLEDGOR');
      expect((await add(app.id, { customerId: c.id, role: 'CO_BORROWER' })).body.code).toBe('ROLE_CONFLICT');
      expect((await add(other.id, { customerId: c.id, role: 'GUARANTOR' })).status).toBe(201);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('4. тоо хязгаар (setting)', () => {
    it('анхдагч 3 хамтран, 3 батлан даагч; 4-р нь 409 LIMIT_EXCEEDED; барьцаалагч хязгааргүй', async () => {
      const app = await newApp();
      await addOk(app.id, (await cust()).id, 'PRIMARY');
      for (let i = 0; i < 3; i++) await addOk(app.id, (await cust()).id, 'CO_BORROWER');
      for (let i = 0; i < 3; i++) await addOk(app.id, (await cust()).id, 'GUARANTOR');
      const co = await add(app.id, { customerId: (await cust()).id, role: 'CO_BORROWER' });
      expect(co.status).toBe(409);
      expect(co.body).toMatchObject({ code: 'LIMIT_EXCEEDED', details: { role: 'CO_BORROWER', limit: 3 } });
      const g = await add(app.id, { customerId: (await cust()).id, role: 'GUARANTOR' });
      expect([g.status, g.body.code, g.body.details.limit]).toEqual([409, 'LIMIT_EXCEEDED', 3]);
      let last;
      for (let i = 0; i < 6; i++) last = await addOk(app.id, (await cust()).id, 'PLEDGOR');
      expect(last?.summary).toMatchObject({ coBorrowerCount: 3, guarantorCount: 3, pledgorCount: 6, limits: { maxCoBorrowers: 3, maxGuarantors: 3 } });
    });

    it('setting-ээр тохируулна: max_co_borrowers=1, max_guarantors=0', async () => {
      await t.prisma.setting.createMany({ data: [{ orgId: ORG, key: 'borrower.max_co_borrowers', valueJson: 1 }, { orgId: ORG, key: 'borrower.max_guarantors', valueJson: 0 }] });
      const app = await newApp();
      await addOk(app.id, (await cust()).id, 'PRIMARY');
      const first = await addOk(app.id, (await cust()).id, 'CO_BORROWER');
      expect(first.summary.limits).toEqual({ maxCoBorrowers: 1, maxGuarantors: 0 });
      expect((await add(app.id, { customerId: (await cust()).id, role: 'CO_BORROWER' })).body.code).toBe('LIMIT_EXCEEDED');
      expect((await add(app.id, { customerId: (await cust()).id, role: 'GUARANTOR' })).body.code).toBe('LIMIT_EXCEEDED');
      expect((await add(app.id, { customerId: (await cust()).id, role: 'PLEDGOR' })).status).toBe(201);
    });

    it('хязгаарыг бууруулсан ч байгаа мөр хөндөгдөхгүй; хасвал дахин нэмэх боломжтой', async () => {
      const app = await newApp();
      const bs = [];
      for (let i = 0; i < 3; i++) bs.push(await addOk(app.id, (await cust()).id, 'GUARANTOR'));
      await t.prisma.setting.create({ data: { orgId: ORG, key: 'borrower.max_guarantors', valueJson: 2 } });
      expect((await listOk(app.id)).items).toHaveLength(3);
      expect((await add(app.id, { customerId: (await cust()).id, role: 'GUARANTOR' })).body.code).toBe('LIMIT_EXCEEDED');
      await http().delete(url(app.id, bs[0].borrower.id)).set(officer);
      expect((await add(app.id, { customerId: (await cust()).id, role: 'GUARANTOR' })).body.code).toBe('LIMIT_EXCEEDED'); // 2 үлдсэн, хязгаар 2
      await http().delete(url(app.id, bs[1].borrower.id)).set(officer);
      expect((await add(app.id, { customerId: (await cust()).id, role: 'GUARANTOR' })).status).toBe(201);
    });

    it('setting-ийн утга буруу (тоо биш) бол анхдагч 3-ыг ашиглана', async () => {
      await t.prisma.setting.create({ data: { orgId: ORG, key: 'borrower.max_co_borrowers', valueJson: 'олон' } });
      const app = await newApp();
      const res = await addOk(app.id, (await cust()).id, 'CO_BORROWER');
      expect(res.summary.limits.maxCoBorrowers).toBe(3);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('5. талбарын дүрэм', () => {
    it('incomeIncluded анхдагч: PRIMARY/CO=true, GUARANTOR/PLEDGOR=false; CO дээр false өгч болно', async () => {
      const app = await newApp();
      const r = {
        PRIMARY: await addOk(app.id, (await cust()).id, 'PRIMARY'), CO: await addOk(app.id, (await cust()).id, 'CO_BORROWER'),
        G: await addOk(app.id, (await cust()).id, 'GUARANTOR'), PL: await addOk(app.id, (await cust()).id, 'PLEDGOR'),
        CO2: await addOk(app.id, (await cust()).id, 'CO_BORROWER', { incomeIncluded: false }),
      };
      expect([r.PRIMARY, r.CO, r.G, r.PL, r.CO2].map((x) => x.borrower.incomeIncluded)).toEqual([true, true, false, false, false]);
      expect((await listOk(app.id)).summary.incomeContributorCustomerIds).toEqual([r.PRIMARY.borrower.customerId, r.CO.borrower.customerId]);
    });

    it('GUARANTOR / PLEDGOR дээр incomeIncluded=true → 422 INCOME_NOT_ALLOWED (нэмэх ба засах)', async () => {
      const app = await newApp();
      for (const role of ['GUARANTOR', 'PLEDGOR'] as const) {
        const c = await cust();
        const res = await add(app.id, { customerId: c.id, role, incomeIncluded: true });
        expect([role, res.status, res.body.code]).toEqual([role, 422, 'INCOME_NOT_ALLOWED']);
        const ok = await addOk(app.id, c.id, role, { incomeIncluded: false });
        const patch = await http().patch(url(app.id, ok.borrower.id)).set(officer).send({ incomeIncluded: true });
        expect([patch.status, patch.body.code]).toEqual([422, 'INCOME_NOT_ALLOWED']);
        expect((await http().patch(url(app.id, ok.borrower.id)).set(officer).send({ incomeIncluded: false })).status).toBe(200);
      }
      expect((await rowsOf(app.id)).every((r) => !r.incomeIncluded)).toBe(true);
    });

    it('хамтран зээлдэгчдийн хувийн нийлбэр > 1 → 422 LIABILITY_SHARE_EXCEEDED; = 1 болно', async () => {
      const app = await newApp();
      await addOk(app.id, (await cust()).id, 'PRIMARY');
      await addOk(app.id, (await cust()).id, 'CO_BORROWER', { liabilityShare: 0.6 });
      const over = await add(app.id, { customerId: (await cust()).id, role: 'CO_BORROWER', liabilityShare: 0.5 });
      expect(over.status).toBe(422);
      expect(over.body.code).toBe('LIABILITY_SHARE_EXCEEDED');
      expect(await rowsOf(app.id)).toHaveLength(2);
      const ok = await addOk(app.id, (await cust()).id, 'CO_BORROWER', { liabilityShare: 0.4 });
      expect(ok.summary.primaryLiabilityShare).toBe(0);
      expect(ok.warnings.map((w) => w.code)).not.toContain('LIABILITY_SHARE_INCOMPLETE');
    });

    it('PATCH: хувийг нэмэгдүүлэхэд нийлбэр хэтэрвэл 422, багтвал 200; 0.33333 → 0.3333', async () => {
      const app = await newApp();
      await addOk(app.id, (await cust()).id, 'PRIMARY');
      await addOk(app.id, (await cust()).id, 'CO_BORROWER', { liabilityShare: 0.6 });
      const b = await addOk(app.id, (await cust()).id, 'CO_BORROWER', { liabilityShare: 0.3 });
      const over = await http().patch(url(app.id, b.borrower.id)).set(officer).send({ liabilityShare: 0.5 });
      expect([over.status, over.body.code]).toEqual([422, 'LIABILITY_SHARE_EXCEEDED']);
      expect(Number((await rowsOf(app.id)).find((r) => r.id === b.borrower.id)?.liabilityShare)).toBe(0.3);
      const fit = await http().patch(url(app.id, b.borrower.id)).set(officer).send({ liabilityShare: 0.33333 });
      expect(fit.status).toBe(200);
      expect(fit.body.borrower.liabilityShare).toBe(0.3333);
      const clear = await http().patch(url(app.id, b.borrower.id)).set(officer).send({ liabilityShare: null });
      expect(clear.body.borrower.liabilityShare).toBeNull();
    });

    it('батлан даагч: төрөл/дүн өгөөгүй бол JOINT_AND_SEVERAL; LIMITED дүнтэй', async () => {
      const app = await newApp();
      const a = await addOk(app.id, (await cust()).id, 'GUARANTOR');
      expect(a.borrower).toMatchObject({ guaranteeType: 'JOINT_AND_SEVERAL', guaranteeAmount: null });
      const b = await addOk(app.id, (await cust()).id, 'GUARANTOR', { guaranteeType: 'LIMITED', guaranteeAmount: 5_000_000.456 });
      expect(b.borrower).toMatchObject({ guaranteeType: 'LIMITED', guaranteeAmount: 5_000_000.46 });
    });

    it('PATCH: дүрд хамаарахгүй талбар → 422 FIELD_NOT_ALLOWED_FOR_ROLE', async () => {
      const app = await newApp();
      const p = await addOk(app.id, (await cust()).id, 'PRIMARY');
      const co = await addOk(app.id, (await cust()).id, 'CO_BORROWER');
      const g = await addOk(app.id, (await cust()).id, 'GUARANTOR');
      const pl = await addOk(app.id, (await cust()).id, 'PLEDGOR');
      const cases: Array<[string, Record<string, unknown>]> = [
        [p.borrower.id, { relationToPrimary: 'SPOUSE' }], [p.borrower.id, { liabilityShare: 0.5 }], [g.borrower.id, { liabilityShare: 0.5 }], [pl.borrower.id, { liabilityShare: 0.5 }],
        [co.borrower.id, { guaranteeType: 'JOINT_AND_SEVERAL' }], [co.borrower.id, { guaranteeAmount: 10 }], [pl.borrower.id, { guaranteeType: 'LIMITED', guaranteeAmount: 10 }], [p.borrower.id, { guaranteeAmount: 10 }],
      ];
      for (const [id, body] of cases) {
        const res = await http().patch(url(app.id, id)).set(officer).send(body);
        expect([JSON.stringify(body), res.status, res.body.code]).toEqual([JSON.stringify(body), 422, 'FIELD_NOT_ALLOWED_FOR_ROLE']);
      }
      // null өгөх нь арилгах тул зөвшөөрнө
      expect((await http().patch(url(app.id, g.borrower.id)).set(officer).send({ liabilityShare: null })).status).toBe(200);
    });

    it('PATCH: баталгаа — LIMITED дүнгүй → 422; JOINT болгоход дүн автоматаар арилна; relationToPrimary зөвшөөрнө', async () => {
      const app = await newApp();
      const g = await addOk(app.id, (await cust()).id, 'GUARANTOR');
      const bad = await http().patch(url(app.id, g.borrower.id)).set(officer).send({ guaranteeType: 'LIMITED' });
      expect([bad.status, bad.body.code]).toEqual([422, 'GUARANTEE_INVALID']);
      const lim = await http().patch(url(app.id, g.borrower.id)).set(officer).send({ guaranteeType: 'LIMITED', guaranteeAmount: 2_000_000 });
      expect(lim.body.borrower).toMatchObject({ guaranteeType: 'LIMITED', guaranteeAmount: 2_000_000 });
      const joint = await http().patch(url(app.id, g.borrower.id)).set(officer).send({ guaranteeType: 'JOINT_AND_SEVERAL', relationToPrimary: 'FRIEND', note: '  найз  ' });
      expect(joint.body.borrower).toMatchObject({ guaranteeType: 'JOINT_AND_SEVERAL', guaranteeAmount: null, relationToPrimary: 'FRIEND', note: 'найз' });
      const onlyAmount = await http().patch(url(app.id, g.borrower.id)).set(officer).send({ guaranteeAmount: 3 });
      expect([onlyAmount.status, onlyAmount.body.code]).toEqual([422, 'GUARANTEE_INVALID']);
    });

    it('PATCH: ижил утгыг давтвал өөрчлөлтгүй (200, event нэмэгдэхгүй); note null арилгана', async () => {
      const app = await newApp();
      const co = await addOk(app.id, (await cust()).id, 'CO_BORROWER', { note: 'анхны' });
      const body = { note: 'шинэ', relationToPrimary: 'SPOUSE', liabilityShare: 0.5 };
      const r1 = await http().patch(url(app.id, co.borrower.id)).set(officer).send(body);
      const r2 = await http().patch(url(app.id, co.borrower.id)).set(officer).send(body);
      expect([r1.status, r2.status]).toEqual([200, 200]);
      expect(r2.body.borrower).toMatchObject(body);
      expect(await events()).toHaveLength(2); // ADDED + UPDATED
      const cleared = await http().patch(url(app.id, co.borrower.id)).set(officer).send({ note: null, relationToPrimary: null });
      expect(cleared.body.borrower).toMatchObject({ note: null, relationToPrimary: null, liabilityShare: 0.5 });
    });

    it('дүр өөрчлөгдөхгүй: PATCH-д role талбар үл тооцогдоно', async () => {
      const app = await newApp();
      const g = await addOk(app.id, (await cust()).id, 'GUARANTOR');
      const res = await http().patch(url(app.id, g.borrower.id)).set(officer).send({ role: 'PRIMARY', note: 'x' });
      expect(res.status).toBe(200);
      expect(res.body.borrower.role).toBe('GUARANTOR');
      await expectInvariants(app.id);
    });

    it('барьцаалагч, хамтран зээлдэгч, батлан даагчид relationToPrimary зөвшөөрөгдөнө', async () => {
      const app = await newApp();
      for (const role of ['CO_BORROWER', 'GUARANTOR', 'PLEDGOR'] as const) {
        const r = await addOk(app.id, (await cust()).id, role, { relationToPrimary: 'PARENT' });
        expect(r.borrower.relationToPrimary).toBe('PARENT');
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('6. харилцагч', () => {
    it('олдохгүй → 404 CUSTOMER_NOT_FOUND; өөр байгууллагын харилцагч → 404', async () => {
      const app = await newApp();
      const foreign = await cust({ orgId: 'other-org' });
      for (const customerId of ['missing', foreign.id]) {
        const res = await add(app.id, { customerId, role: 'PRIMARY' });
        expect([res.status, res.body.code]).toEqual([404, 'CUSTOMER_NOT_FOUND']);
      }
      expect(await rowsOf(app.id)).toHaveLength(0);
    });

    it('хуулийн этгээд: PRIMARY / GUARANTOR / PLEDGOR болно; CO_BORROWER → 422 ENTITY_CANNOT_CO_BORROW', async () => {
      const app = await newApp();
      const ent = await cust({ customerType: 'LEGAL_ENTITY', firstName: 'Ухаалаг ХХК', lastName: null });
      const co = await add(app.id, { customerId: ent.id, role: 'CO_BORROWER' });
      expect([co.status, co.body.code]).toEqual([422, 'ENTITY_CANNOT_CO_BORROW']);
      expect(await rowsOf(app.id)).toHaveLength(0);
      const p = await addOk(app.id, ent.id, 'PRIMARY');
      expect(p.borrower.customer).toMatchObject({ customerType: 'LEGAL_ENTITY', displayName: 'Ухаалаг ХХК' });
      const app2 = await newApp();
      await addOk(app2.id, ent.id, 'GUARANTOR'); await addOk(app2.id, ent.id, 'PLEDGOR');
      expect(await rowsOf(app2.id)).toHaveLength(2);
    });

    it('displayName: "Овог Нэр"; хариуд харилцагчийн төлөв (PEP / ББСБ-д хамааралтай) орно', async () => {
      const app = await newApp();
      const c = await cust({ lastName: 'Болд', firstName: 'Бат', isPep: true, isRelatedParty: true, phone: '99112233', email: 'bat@example.mn' });
      const res = await addOk(app.id, c.id, 'PRIMARY');
      expect(res.borrower.customer).toMatchObject({ id: c.id, displayName: 'Болд Бат', customerType: 'INDIVIDUAL', phone: '99112233', email: 'bat@example.mn', isPep: true, isRelatedParty: true });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('7. анхааруулга (BR-9: хориг биш)', () => {
    const blacklist = (registerNo: string, o: Partial<{ isActive: boolean; orgId: string; reasonCode: string; listType: string }> = {}) =>
      t.prisma.blacklist.create({ data: { orgId: o.orgId ?? ORG, registerNoHash: blindIndex(registerNo), registerNoEncrypted: encryptedField(registerNo), customerType: 'INDIVIDUAL', name: 'Хар жагсаалтын нэр', listType: o.listType ?? 'INTERNAL', reasonCode: o.reasonCode ?? 'FRAUD', isActive: o.isActive ?? true } });

    it('BLACKLISTED: хар жагсаалтад байсан ч хадгалагдана (201), анхааруулга details-тэй; GET дээр дахин тооцоолж буцаана', async () => {
      const app = await newApp();
      const c = await cust({ registerNo: 'УБ90001111' });
      await blacklist('УБ90001111', { reasonCode: 'OVERDUE', listType: 'SHARED' });
      const res = await addOk(app.id, c.id, 'PRIMARY');
      expect(res.warnings).toHaveLength(1);
      expect(res.warnings[0]).toMatchObject({ code: 'BLACKLISTED', customerId: c.id, details: { reasonCode: 'OVERDUE', listType: 'SHARED', roles: ['PRIMARY'] } });
      expect(await rowsOf(app.id)).toHaveLength(1);
      expect((await listOk(app.id)).warnings).toEqual(res.warnings);
      // хар жагсаалтаас гарвал анхааруулга алга болно (хадгалагдаагүй, тооцоолсон)
      await t.prisma.blacklist.updateMany({ data: { isActive: false } });
      expect((await listOk(app.id)).warnings).toEqual([]);
    });

    it('BLACKLISTED: идэвхгүй, өөр байгууллага, өөр регистр тохирохгүй; жижиг үсгээр хадгалсан бичлэг тохирно; олон бичлэг тус тусдаа', async () => {
      const app = await newApp();
      const c = await cust({ registerNo: 'УБ90002222' });
      await blacklist('УБ90002222', { isActive: false });
      await blacklist('УБ90002222', { orgId: 'other-org' });
      await blacklist('УБ90002223');
      expect((await addOk(app.id, c.id, 'PRIMARY')).warnings).toEqual([]);
      await blacklist('уб90002222', { reasonCode: 'LOWER' });
      await blacklist('УБ90002222', { reasonCode: 'EXACT', listType: 'SHARED' });
      const w = (await listOk(app.id)).warnings;
      expect(w.map((x) => x.code)).toEqual(['BLACKLISTED', 'BLACKLISTED']);
      expect(w.map((x) => (x.details as { reasonCode: string }).reasonCode).sort()).toEqual(['EXACT', 'LOWER']);
    });

    it('BLACKLISTED: хар жагсаалтад нормчлогдоогүй (холимог үсэг, дотор/захын зай, NBSP, tab) хадгалсан регистр ч алдагдахгүй (BR-9 false negative)', async () => {
      const app = await newApp();
      const stored: Array<[string, string]> = [
        ['УБ99010112', 'Уб99010112'], // холимог үсэг
        ['УБ99010115', 'УБ 99010115'], // дотор зай
        ['УБ99010113', 'УБ99010113'], // яг ижил
        ['УБ99010114', 'уб99010114'], // жижиг үсэг
        ['УБ99010116', ' УБ99010116 '], // захын зай
        ['УБ99010117', 'уБ\u00a099010117'], // NBSP + холимог
        ['УБ99010118', '\tУБ99010118\n'], // tab / шинэ мөр
        ['ӨҮ99010119', 'өү 99010119'], // Ө/Ү кирилл үсэг жижгээр + зай
      ];
      for (const [reg, blackRaw] of stored) {
        const c = await cust({ registerNo: reg });
        await blacklist(blackRaw, { reasonCode: `R-${reg}` });
        await addOk(app.id, c.id, 'PLEDGOR'); // PLEDGOR тоо хязгааргүй
      }
      const w = (await listOk(app.id)).warnings.filter((x) => x.code === 'BLACKLISTED');
      expect(w.map((x) => (x.details as { reasonCode: string }).reasonCode).sort()).toEqual(stored.map(([reg]) => `R-${reg}`).sort());
      expect(new Set(w.map((x) => x.customerId)).size).toBe(stored.length); // харилцагч тутамд яг нэг
    });

    it('BLACKLISTED: харилцагчийн регистр өөрөө жижиг үсэг / зайтай шифрлэгдсэн ч тохирно; идэвхгүй / өөр байгууллага / өөр регистр / өөр үсэгтэй мөрийг тохируулахгүй', async () => {
      const app = await newApp();
      const c = await cust({ registerNo: ' уб 99010120 ' });
      await blacklist('УБ99010120', { isActive: false });
      await blacklist('Уб 99010120', { orgId: 'other-org' });
      await blacklist('УБ99010121'); // өөр дугаар
      await blacklist('УА99010120'); // өөр үсэг
      await blacklist('99010120'); // үсэггүй
      expect((await addOk(app.id, c.id, 'PRIMARY')).warnings).toEqual([]);
      await blacklist('Уб99010120', { reasonCode: 'MIXED', listType: 'SHARED' });
      const w = (await listOk(app.id)).warnings;
      expect(w).toHaveLength(1);
      expect(w[0]).toMatchObject({ code: 'BLACKLISTED', customerId: c.id, details: { reasonCode: 'MIXED', listType: 'SHARED' } });
    });

    it('BLACKLISTED: батлан даагч ба барьцаалагч дээр ч гарна; хоёр дүртэй харилцагчид roles-д хоёулаа', async () => {
      const app = await newApp();
      const g = await cust({ registerNo: 'УБ90003333' }); const pl = await cust({ registerNo: 'УБ90004444' });
      await blacklist('УБ90003333'); await blacklist('УБ90004444');
      await addOk(app.id, g.id, 'GUARANTOR'); await addOk(app.id, pl.id, 'PLEDGOR'); await addOk(app.id, pl.id, 'GUARANTOR');
      const w = (await listOk(app.id)).warnings.filter((x) => x.code === 'BLACKLISTED');
      expect(w.map((x) => x.customerId).sort()).toEqual([g.id, pl.id].sort());
      expect(w.find((x) => x.customerId === pl.id)?.details?.roles).toEqual(['GUARANTOR', 'PLEDGOR']);
    });

    it('PEP ба RELATED_PARTY: харилцагчийн тэмдэглэгээнээс', async () => {
      const app = await newApp();
      const pep = await cust({ isPep: true }); const rel = await cust({ isRelatedParty: true });
      await addOk(app.id, pep.id, 'PRIMARY');
      const res = await addOk(app.id, rel.id, 'PLEDGOR');
      expect(res.warnings.map((w) => [w.code, w.customerId])).toEqual([['PEP', pep.id], ['RELATED_PARTY', rel.id]]);
    });

    it('CONSENT_MISSING: батлан даагч, хамтран зээлдэгчид; үндсэн / барьцаалагчид үгүй; зөвшөөрөл бүртгэмэгц алга болно', async () => {
      const app = await newApp();
      const [p, co, g, pl] = [await cust(), await cust(), await cust(), await cust()];
      await addOk(app.id, p.id, 'PRIMARY'); const cob = await addOk(app.id, co.id, 'CO_BORROWER'); const gb = await addOk(app.id, g.id, 'GUARANTOR'); await addOk(app.id, pl.id, 'PLEDGOR');
      let w = (await listOk(app.id)).warnings.filter((x) => x.code === 'CONSENT_MISSING');
      expect(w.map((x) => x.customerId)).toEqual([co.id, g.id]);
      const consent = await http().post(url(app.id, gb.borrower.id, 'consent')).set(officer).send({ fileId: 'file-1', signedAt: '2026-10-27T09:00:00Z' });
      expect(consent.status).toBe(200);
      w = BorrowerMutationResponse.parse(consent.body).warnings.filter((x) => x.code === 'CONSENT_MISSING');
      expect(w.map((x) => x.customerId)).toEqual([co.id]);
      await http().post(url(app.id, cob.borrower.id, 'consent')).set(officer).send({ fileId: 'file-2', signedAt: '2026-10-27T10:00:00Z' });
      expect((await listOk(app.id)).warnings).toEqual([]);
    });

    it('GUARANTEE_BELOW_LOAN: LIMITED нийлбэр < зээлийн дүн', async () => {
      const app = await newApp({ amount: 10_000_000 });
      const g1 = await addOk(app.id, (await cust()).id, 'GUARANTOR', { guaranteeType: 'LIMITED', guaranteeAmount: 4_000_000 });
      const below = g1.warnings.find((w) => w.code === 'GUARANTEE_BELOW_LOAN');
      expect(below).toMatchObject({ customerId: null, details: { covered: 4_000_000, loanAmount: 10_000_000, shortfall: 6_000_000 } });
      expect(g1.summary.guaranteeCoverageRatio).toBe(0.4);
      const g2 = await addOk(app.id, (await cust()).id, 'GUARANTOR', { guaranteeType: 'LIMITED', guaranteeAmount: 5_999_999.99 });
      expect(g2.warnings.some((w) => w.code === 'GUARANTEE_BELOW_LOAN')).toBe(true);
      const g3 = await addOk(app.id, (await cust()).id, 'GUARANTOR', { guaranteeType: 'LIMITED', guaranteeAmount: 0.01 });
      expect(g3.warnings.some((w) => w.code === 'GUARANTEE_BELOW_LOAN')).toBe(false); // яг 10,000,000 — хангалттай
      expect(g3.summary.guaranteeCoverageRatio).toBe(1);
    });

    it('GUARANTEE_BELOW_LOAN: бүрэн (JOINT_AND_SEVERAL) баталгаа бүтэн дүн; батлан даагчгүй, дүнгүй хүсэлтэд анхааруулга үгүй', async () => {
      const app = await newApp({ amount: 10_000_000 });
      expect((await addOk(app.id, (await cust()).id, 'PRIMARY')).warnings.some((w) => w.code === 'GUARANTEE_BELOW_LOAN')).toBe(false);
      const j = await addOk(app.id, (await cust()).id, 'GUARANTOR');
      expect(j.warnings.some((w) => w.code === 'GUARANTEE_BELOW_LOAN')).toBe(false);
      expect(j.summary.guaranteeCoverageRatio).toBe(1);
      const noAmount = await newApp({ amount: null });
      const g = await addOk(noAmount.id, (await cust()).id, 'GUARANTOR', { guaranteeType: 'LIMITED', guaranteeAmount: 1000 });
      expect(g.warnings.some((w) => w.code === 'GUARANTEE_BELOW_LOAN')).toBe(false);
      expect(g.summary.guaranteeCoverageRatio).toBeNull();
    });

    it('GUARANTEE_BELOW_LOAN: зээлийн дүн өөрчлөгдвөл GET дээр дахин тооцогдоно', async () => {
      const app = await newApp({ amount: 1_000_000 });
      await addOk(app.id, (await cust()).id, 'GUARANTOR', { guaranteeType: 'LIMITED', guaranteeAmount: 1_000_000 });
      expect((await listOk(app.id)).warnings.some((w) => w.code === 'GUARANTEE_BELOW_LOAN')).toBe(false);
      await t.prisma.loanApplication.update({ where: { id: app.id }, data: { amount: 2_000_000 } });
      const view = await listOk(app.id);
      expect(view.warnings.some((w) => w.code === 'GUARANTEE_BELOW_LOAN')).toBe(true);
      expect(view.summary.guaranteeCoverageRatio).toBe(0.5);
    });

    it('LIABILITY_SHARE_INCOMPLETE: хувь тогтоосон хамтран зээлдэгч байх ба өөр хамтран зээлдэгчид хувь байхгүй үед', async () => {
      const app = await newApp();
      await addOk(app.id, (await cust()).id, 'PRIMARY');
      const a = await addOk(app.id, (await cust()).id, 'CO_BORROWER', { liabilityShare: 0.3 });
      expect(a.warnings.some((w) => w.code === 'LIABILITY_SHARE_INCOMPLETE')).toBe(false);
      const b = await addOk(app.id, (await cust()).id, 'CO_BORROWER');
      const w = b.warnings.find((x) => x.code === 'LIABILITY_SHARE_INCOMPLETE');
      expect(w).toMatchObject({ customerId: null, details: { specifiedTotal: 0.3, missingCustomerIds: [b.borrower.customerId] } });
      // тогтоосон хувийг арилгавал хамтын хариуцлага болж анхааруулга алга болно
      const cleared = await http().patch(url(app.id, a.borrower.id)).set(officer).send({ liabilityShare: null });
      expect(BorrowerMutationResponse.parse(cleared.body).warnings.some((x) => x.code === 'LIABILITY_SHARE_INCOMPLETE')).toBe(false);
    });

    it('бүх анхааруулгын код нэгэн зэрэг; хэлбэр нь BorrowerWarning DTO-той тохирно', async () => {
      const app = await newApp({ amount: 10_000_000 });
      const p = await cust({ registerNo: 'УБ90005555', isPep: true, isRelatedParty: true });
      await blacklist('УБ90005555');
      await addOk(app.id, p.id, 'PRIMARY');
      await addOk(app.id, (await cust()).id, 'CO_BORROWER', { liabilityShare: 0.4 });
      await addOk(app.id, (await cust()).id, 'CO_BORROWER');
      await addOk(app.id, (await cust()).id, 'GUARANTOR', { guaranteeType: 'LIMITED', guaranteeAmount: 1_000 });
      const view = await listOk(app.id);
      expect([...new Set(view.warnings.map((w) => w.code))].sort()).toEqual(['BLACKLISTED', 'CONSENT_MISSING', 'GUARANTEE_BELOW_LOAN', 'LIABILITY_SHARE_INCOMPLETE', 'PEP', 'RELATED_PARTY']);
      for (const w of view.warnings) { expect(BorrowerWarning.parse(w)).toEqual(w); expect(w.message.length).toBeGreaterThan(10); }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('8. алхам ба event', () => {
    const STATE = { client: 'PENDING', inquiry: 'COMPLETED', income: 'COMPLETED', loan: 'COMPLETED', score: 'COMPLETED' } as const;
    const snapshot = async (appId: string) => Object.fromEntries(await Promise.all((['client', 'inquiry', 'income', 'loan', 'score'] as const).map(async (k) => [k, (await step(appId, k)).status])));

    it('PRIMARY нэмэх: client→COMPLETED (completedAt), inquiry→PENDING(BORROWER_ADDED), income/score→STALE(BORROWERS_CHANGED), loan хөндөгдөхгүй', async () => {
      const app = await newApp();
      await seedSteps(app.id, STATE);
      await addOk(app.id, (await cust()).id, 'PRIMARY');
      const client = await step(app.id, 'client');
      expect(client.status).toBe('COMPLETED');
      expect(client.completedAt?.toISOString()).toBe('2026-10-28T02:00:00.000Z');
      expect(await step(app.id, 'inquiry')).toMatchObject({ status: 'PENDING', staleReason: 'BORROWER_ADDED', completedAt: null });
      expect(await step(app.id, 'income')).toMatchObject({ status: 'STALE', staleReason: 'BORROWERS_CHANGED' });
      expect(await step(app.id, 'score')).toMatchObject({ status: 'STALE', staleReason: 'BORROWERS_CHANGED' });
      expect((await step(app.id, 'loan')).status).toBe('COMPLETED');
      expect((await step(app.id, 'collateral')).status).toBe('PENDING');
    });

    it('CO_BORROWER нэмэх: inquiry PENDING, income/score STALE', async () => {
      const app = await newApp();
      await addOk(app.id, (await cust()).id, 'PRIMARY');
      await seedSteps(app.id, { ...STATE, client: 'COMPLETED' });
      await addOk(app.id, (await cust()).id, 'CO_BORROWER');
      expect(await snapshot(app.id)).toEqual({ client: 'COMPLETED', inquiry: 'PENDING', income: 'STALE', loan: 'COMPLETED', score: 'STALE' });
    });

    it.each(['GUARANTOR', 'PLEDGOR'] as const)('%s нэмэх: зөвхөн inquiry→PENDING; income/score хөндөгдөхгүй', async (role) => {
      const app = await newApp();
      await addOk(app.id, (await cust()).id, 'PRIMARY');
      await seedSteps(app.id, { ...STATE, client: 'COMPLETED' });
      await addOk(app.id, (await cust()).id, role);
      expect(await snapshot(app.id)).toEqual({ client: 'COMPLETED', inquiry: 'PENDING', income: 'COMPLETED', loan: 'COMPLETED', score: 'COMPLETED' });
      expect((await step(app.id, 'inquiry')).staleReason).toBe('BORROWER_ADDED');
    });

    it('inquiry COMPLETED биш бол өөрчлөхгүй (PENDING/STALE хэвээр, staleReason хэвээр)', async () => {
      const app = await newApp();
      await seedSteps(app.id, { inquiry: 'STALE' });
      await t.prisma.loanApplicationStep.update({ where: { applicationId_stepKey: { applicationId: app.id, stepKey: 'inquiry' } }, data: { staleReason: 'EXPIRED' } });
      await addOk(app.id, (await cust()).id, 'GUARANTOR');
      expect(await step(app.id, 'inquiry')).toMatchObject({ status: 'STALE', staleReason: 'EXPIRED' });
    });

    it('CO_BORROWER хасах: income/score STALE; GUARANTOR хасах: хөндөгдөхгүй', async () => {
      const app = await newApp();
      await addOk(app.id, (await cust()).id, 'PRIMARY');
      const co = await addOk(app.id, (await cust()).id, 'CO_BORROWER'); const g = await addOk(app.id, (await cust()).id, 'GUARANTOR');
      await seedSteps(app.id, { ...STATE, client: 'COMPLETED' });
      await http().delete(url(app.id, g.borrower.id)).set(officer);
      expect(await snapshot(app.id)).toEqual({ client: 'COMPLETED', inquiry: 'COMPLETED', income: 'COMPLETED', loan: 'COMPLETED', score: 'COMPLETED' });
      await http().delete(url(app.id, co.borrower.id)).set(officer);
      expect(await snapshot(app.id)).toEqual({ client: 'COMPLETED', inquiry: 'COMPLETED', income: 'STALE', loan: 'COMPLETED', score: 'STALE' });
    });

    it('PATCH: incomeIncluded / liabilityShare → STALE; note / relation → хөндөгдөхгүй', async () => {
      const app = await newApp();
      await addOk(app.id, (await cust()).id, 'PRIMARY');
      const co = await addOk(app.id, (await cust()).id, 'CO_BORROWER');
      await seedSteps(app.id, { ...STATE, client: 'COMPLETED' });
      await http().patch(url(app.id, co.borrower.id)).set(officer).send({ note: 'тайлбар', relationToPrimary: 'FRIEND' });
      expect(await snapshot(app.id)).toMatchObject({ income: 'COMPLETED', score: 'COMPLETED' });
      await http().patch(url(app.id, co.borrower.id)).set(officer).send({ incomeIncluded: false });
      expect(await snapshot(app.id)).toMatchObject({ income: 'STALE', score: 'STALE', inquiry: 'COMPLETED' });
      await t.prisma.loanApplicationStep.updateMany({ where: { applicationId: app.id, stepKey: { in: ['income', 'score'] } }, data: { status: 'COMPLETED', staleReason: null } });
      await http().patch(url(app.id, co.borrower.id)).set(officer).send({ liabilityShare: 0.5 });
      expect(await snapshot(app.id)).toMatchObject({ income: 'STALE', score: 'STALE' });
    });

    it('make-primary: income/score STALE, inquiry хөндөгдөхгүй', async () => {
      const app = await newApp();
      await addOk(app.id, (await cust()).id, 'PRIMARY');
      const co = await addOk(app.id, (await cust()).id, 'CO_BORROWER');
      await seedSteps(app.id, { ...STATE, client: 'COMPLETED' });
      await http().post(url(app.id, co.borrower.id, 'make-primary')).set(officer);
      expect(await snapshot(app.id)).toEqual({ client: 'COMPLETED', inquiry: 'COMPLETED', income: 'STALE', loan: 'COMPLETED', score: 'STALE' });
    });

    it('consent: алхамд нөлөөлөхгүй', async () => {
      const app = await newApp();
      await addOk(app.id, (await cust()).id, 'PRIMARY');
      const g = await addOk(app.id, (await cust()).id, 'GUARANTOR');
      await seedSteps(app.id, { ...STATE, client: 'COMPLETED' });
      await http().post(url(app.id, g.borrower.id, 'consent')).set(officer).send({ fileId: 'f', signedAt: '2026-10-27T00:00:00Z' });
      expect(await snapshot(app.id)).toEqual({ client: 'COMPLETED', inquiry: 'COMPLETED', income: 'COMPLETED', loan: 'COMPLETED', score: 'COMPLETED' });
    });

    it('LOCKED мөрийг хөндөхгүй; алхамын мөр огт байхгүй үед алдаагүй', async () => {
      const locked = await newApp();
      await seedSteps(locked.id, {}, 'LOCKED');
      await addOk(locked.id, (await cust()).id, 'PRIMARY');
      expect(await snapshot(locked.id)).toEqual({ client: 'LOCKED', inquiry: 'LOCKED', income: 'LOCKED', loan: 'LOCKED', score: 'LOCKED' });
      const bare = await newApp();
      const res = await addOk(bare.id, (await cust()).id, 'PRIMARY');
      expect(res.summary.clientStepComplete).toBe(true);
      expect(await t.prisma.loanApplicationStep.count({ where: { applicationId: bare.id } })).toBe(0);
    });

    it('client алхам: PRIMARY бүртгэмэгц COMPLETED, давтан COMPLETED биш (completedAt хэвээр), PRIMARY алга болмогц PENDING', async () => {
      const app = await newApp();
      await seedSteps(app.id);
      const a = await addOk(app.id, (await cust()).id, 'PRIMARY');
      const first = (await step(app.id, 'client')).completedAt;
      t.clock.set('2026-10-28T08:00:00Z');
      await addOk(app.id, (await cust()).id, 'GUARANTOR');
      expect((await step(app.id, 'client')).completedAt).toEqual(first);
      t.clock.set('2026-10-28T02:00:00Z');
      await http().delete(url(app.id, a.borrower.id)).set(officer); // GUARANTOR үлдсэн тул PRIMARY_REQUIRED
      expect((await step(app.id, 'client')).status).toBe('COMPLETED');
    });

    it('event: ADDED — correlationId, actorId, borrowers[] (incomeIncluded-тэй), DTO-д тохирно', async () => {
      const app = await newApp();
      const [p, g] = [await cust(), await cust()];
      await http().post(url(app.id)).set({ ...officer, 'x-correlation-id': 'corr-42' }).send({ customerId: p.id, role: 'PRIMARY' });
      await http().post(url(app.id)).set(officer).send({ customerId: g.id, role: 'GUARANTOR' });
      const evs = await events();
      expect(evs).toHaveLength(2);
      expect(evs[0]).toMatchObject({ type: 'BorrowersChanged', version: 1, orgId: ORG, actorId: 'officer-1', correlationId: 'corr-42', applicationId: app.id, change: 'ADDED', customerId: p.id, role: 'PRIMARY' });
      expect(evs[0].borrowers).toEqual([{ customerId: p.id, role: 'PRIMARY', incomeIncluded: true }]);
      expect(evs[1]).toMatchObject({ change: 'ADDED', customerId: g.id, role: 'GUARANTOR' });
      expect(evs[1].borrowers).toEqual([{ customerId: p.id, role: 'PRIMARY', incomeIncluded: true }, { customerId: g.id, role: 'GUARANTOR', incomeIncluded: false }]);
    });

    it('event: UPDATED (засах, зөвшөөрөл) ба REMOVED (borrowers[]-д хасагдсан нь байхгүй); outbox relay-аар bus-д гарна', async () => {
      const app = await newApp();
      const [p, g] = [await cust(), await cust()];
      await addOk(app.id, p.id, 'PRIMARY'); const gb = await addOk(app.id, g.id, 'GUARANTOR');
      await http().patch(url(app.id, gb.borrower.id)).set(officer).send({ note: 'x' });
      await http().post(url(app.id, gb.borrower.id, 'consent')).set(officer).send({ fileId: 'f', signedAt: '2026-10-27T00:00:00Z' });
      await http().delete(url(app.id, gb.borrower.id)).set(officer);
      const evs = await events();
      expect(evs.map((e) => e.change)).toEqual(['ADDED', 'ADDED', 'UPDATED', 'UPDATED', 'REMOVED']);
      expect(evs[4]).toMatchObject({ customerId: g.id, role: 'GUARANTOR', borrowers: [{ customerId: p.id, role: 'PRIMARY', incomeIncluded: true }] });
      const publishedBefore = t.bus.published.length;
      expect(await t.app.get(OutboxRelayService).relayOnce()).toBe(5);
      expect(t.bus.published.slice(publishedBefore).map((e) => e.type)).toEqual(Array(5).fill('BorrowersChanged'));
    });

    it('амжилтгүй хүсэлт event үүсгэхгүй, мөр өөрчлөхгүй', async () => {
      const app = await newApp();
      const c = await cust();
      await addOk(app.id, c.id, 'PRIMARY');
      const before = await t.prisma.outbox.count();
      await add(app.id, { customerId: c.id, role: 'PRIMARY' }); // BORROWER_DUPLICATE
      await add(app.id, { customerId: (await cust()).id, role: 'PRIMARY' }); // PRIMARY_EXISTS
      await add(app.id, { customerId: 'nope', role: 'GUARANTOR' }); // 404
      await add(app.id, { customerId: (await cust()).id, role: 'GUARANTOR', incomeIncluded: true }); // 422
      expect(await t.prisma.outbox.count()).toBe(before);
      expect(await rowsOf(app.id)).toHaveLength(1);
    });

    it('нэг транзакц: event бичихэд алдаа гарвал мөр ба алхамын өөрчлөлт буцна', async () => {
      const app = await newApp();
      await seedSteps(app.id, STATE);
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      vi.spyOn(t.app.get(DomainEvents), 'publish').mockRejectedValueOnce(new Error('outbox унав'));
      const res = await add(app.id, { customerId: (await cust()).id, role: 'PRIMARY' });
      expect(res.status).toBe(500);
      expect(await rowsOf(app.id)).toHaveLength(0);
      expect(await snapshot(app.id)).toEqual(STATE);
      expect(await t.prisma.outbox.count()).toBe(0);
      // дараагийн хүсэлт хэвийн
      expect((await add(app.id, { customerId: (await cust()).id, role: 'PRIMARY' })).status).toBe(201);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('9. зэрэгцээ хүсэлт (хүсэлтийн мөрийг FOR UPDATE-ээр сериалчилна)', () => {
    it('зэрэг PRIMARY нэмэхэд яг нэг нь амжина', async () => {
      const app = await newApp();
      const cs = await Promise.all(Array.from({ length: 6 }, () => cust()));
      const results = await Promise.all(cs.map((c) => add(app.id, { customerId: c.id, role: 'PRIMARY' })));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      const losers = results.filter((r) => r.status !== 201);
      expect(losers).toHaveLength(5);
      for (const r of losers) { expect(r.status).toBe(409); expect(r.body.code).toBe('PRIMARY_EXISTS'); }
      expect((await rowsOf(app.id)).filter((r) => r.role === 'PRIMARY')).toHaveLength(1);
      expect(await events()).toHaveLength(1);
      await expectInvariants(app.id);
    });

    it('ижил харилцагчийг ижил дүрээр зэрэг нэмэхэд яг нэг нь амжина (BORROWER_DUPLICATE)', async () => {
      const app = await newApp();
      const c = await cust();
      const results = await Promise.all(Array.from({ length: 5 }, () => add(app.id, { customerId: c.id, role: 'GUARANTOR' })));
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409]);
      for (const r of results.filter((x) => x.status === 409)) expect(r.body.code).toBe('BORROWER_DUPLICATE');
      expect(await rowsOf(app.id)).toHaveLength(1);
    });

    it('нэг харилцагчийг зөрчилтэй дүрүүдээр зэрэг нэмэхэд нэг нь л амжина', async () => {
      const app = await newApp();
      const c = await cust();
      const results = await Promise.all(['PRIMARY', 'CO_BORROWER', 'GUARANTOR'].map((role) => add(app.id, { customerId: c.id, role })));
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
      for (const r of results.filter((x) => x.status === 409)) expect(r.body.code).toBe('ROLE_CONFLICT');
      expect(await rowsOf(app.id)).toHaveLength(1);
    });

    it('хязгаар: max_co_borrowers=2 үед 6 зэрэг хүсэлтээс яг 2 нь амжина', async () => {
      await t.prisma.setting.create({ data: { orgId: ORG, key: 'borrower.max_co_borrowers', valueJson: 2 } });
      const app = await newApp();
      const cs = await Promise.all(Array.from({ length: 6 }, () => cust()));
      const results = await Promise.all(cs.map((c) => add(app.id, { customerId: c.id, role: 'CO_BORROWER' })));
      expect(results.filter((r) => r.status === 201)).toHaveLength(2);
      for (const r of results.filter((x) => x.status !== 201)) expect([r.status, r.body.code]).toEqual([409, 'LIMIT_EXCEEDED']);
      expect(await rowsOf(app.id)).toHaveLength(2);
    });

    it('хувь: 0.6 + 0.6 зэрэг нэмэхэд нэг нь 422', async () => {
      const app = await newApp();
      const [a, b] = [await cust(), await cust()];
      const results = await Promise.all([a, b].map((c) => add(app.id, { customerId: c.id, role: 'CO_BORROWER', liabilityShare: 0.6 })));
      expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
      expect(results.find((r) => r.status === 422)?.body.code).toBe('LIABILITY_SHARE_EXCEEDED');
    });

    it('зэрэг make-primary: хоёулаа дараалан амжиж, төгсгөлд яг нэг PRIMARY', async () => {
      const app = await newApp();
      const [p, c1, c2] = [await cust(), await cust(), await cust()];
      await addOk(app.id, p.id, 'PRIMARY');
      const b1 = await addOk(app.id, c1.id, 'CO_BORROWER'); const b2 = await addOk(app.id, c2.id, 'CO_BORROWER');
      const results = await Promise.all([b1, b2].map((b) => http().post(url(app.id, b.borrower.id, 'make-primary')).set(officer)));
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      const rows = await rowsOf(app.id);
      expect(rows).toHaveLength(3);
      expect(rows.filter((r) => r.role === 'PRIMARY')).toHaveLength(1);
      await expectInvariants(app.id);
    });

    it('зэрэг PRIMARY нэмэх ба устгах: инвариант хадгалагдана', async () => {
      const app = await newApp();
      const a = await cust();
      const first = await addOk(app.id, a.id, 'PRIMARY');
      const others = await Promise.all(Array.from({ length: 3 }, () => cust()));
      await Promise.all([
        http().delete(url(app.id, first.borrower.id)).set(officer),
        ...others.map((c) => add(app.id, { customerId: c.id, role: 'PRIMARY' })),
      ]);
      await expectInvariants(app.id);
    });

    it('зэрэг устгахад нэг нь 204, нөгөө нь 404 BORROWER_NOT_FOUND', async () => {
      const app = await newApp();
      const g = await addOk(app.id, (await cust()).id, 'GUARANTOR');
      const results = await Promise.all([1, 2, 3].map(() => http().delete(url(app.id, g.borrower.id)).set(officer)));
      expect(results.map((r) => r.status).sort()).toEqual([204, 404, 404]);
      expect(await events()).toHaveLength(2); // ADDED + REMOVED
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('10. барьцаа холбоо', () => {
    const collateral = (appId: string, ownerCustomerId: string | null) => t.prisma.collateral.create({ data: { orgId: ORG, applicationId: appId, kind: 'IMMOVABLE', assetType: 'APARTMENT', ownerCustomerId } });

    it('барьцаа өмчилдөг PLEDGOR-г хасахад 409 BORROWER_OWNS_COLLATERAL; барьцааг хассаны дараа 204', async () => {
      const app = await newApp();
      const pl = await cust();
      await addOk(app.id, (await cust()).id, 'PRIMARY'); const b = await addOk(app.id, pl.id, 'PLEDGOR');
      const col = await collateral(app.id, pl.id);
      const res = await http().delete(url(app.id, b.borrower.id)).set(officer);
      expect([res.status, res.body.code]).toEqual([409, 'BORROWER_OWNS_COLLATERAL']);
      expect(await rowsOf(app.id)).toHaveLength(2);
      await t.prisma.collateral.delete({ where: { id: col.id } });
      expect((await http().delete(url(app.id, b.borrower.id)).set(officer)).status).toBe(204);
    });

    it('өмчлөгч биш PLEDGOR, эсвэл өөр хүсэлтийн барьцаа → 204', async () => {
      const app = await newApp(); const other = await newApp();
      const [pl1, pl2] = [await cust(), await cust()];
      await addOk(app.id, (await cust()).id, 'PRIMARY');
      const b1 = await addOk(app.id, pl1.id, 'PLEDGOR'); const b2 = await addOk(app.id, pl2.id, 'PLEDGOR');
      await collateral(app.id, pl1.id); await collateral(other.id, pl2.id); await collateral(app.id, null);
      expect((await http().delete(url(app.id, b2.borrower.id)).set(officer)).status).toBe(204);
      expect((await http().delete(url(app.id, b1.borrower.id)).set(officer)).status).toBe(409);
    });

    it('барьцаа өмчилдөг хамтран зээлдэгчийг мөн хасахгүй (409 BORROWER_OWNS_COLLATERAL); барьцаагүй батлан даагчийг чөлөөтэй хасна', async () => {
      const app = await newApp();
      const c = await cust();
      const g = await cust();
      await addOk(app.id, (await cust()).id, 'PRIMARY');
      const co = await addOk(app.id, c.id, 'CO_BORROWER');
      const guarantor = await addOk(app.id, g.id, 'GUARANTOR');
      await collateral(app.id, c.id);
      const blocked = await http().delete(url(app.id, co.borrower.id)).set(officer);
      expect([blocked.status, blocked.body.code]).toEqual([409, 'BORROWER_OWNS_COLLATERAL']);
      expect((await http().delete(url(app.id, guarantor.borrower.id)).set(officer)).status).toBe(204);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('11. нууцлал (NFR-5)', () => {
    it('бүтэн регистр аль ч хариу / event-д гарахгүй; registerNoMasked нуугдмал', async () => {
      const app = await newApp();
      const registers = ['УБ90007701', 'УБ90007702', 'УБ90007703'];
      const [p, g, pl] = await Promise.all(registers.map((registerNo) => cust({ registerNo })));
      await t.prisma.blacklist.create({ data: { orgId: ORG, registerNoHash: blindIndex('УБ90007701'), registerNoEncrypted: encryptedField('УБ90007701'), customerType: 'INDIVIDUAL', name: 'x', listType: 'INTERNAL', reasonCode: 'FRAUD' } });
      const bodies = [
        (await add(app.id, { customerId: p.id, role: 'PRIMARY' })).body, (await add(app.id, { customerId: g.id, role: 'GUARANTOR' })).body,
        (await add(app.id, { customerId: pl.id, role: 'PLEDGOR' })).body, (await list(app.id)).body,
        (await http().get(url(app.id, 'candidates')).query({ registerNo: 'УБ90007702' }).set(officer)).body,
      ];
      const dump = JSON.stringify(bodies) + JSON.stringify(await t.prisma.outbox.findMany());
      for (const r of registers) expect(dump).not.toContain(r);
      expect(dump).not.toMatch(/registerNo(Encrypted|Hash)/);
      expect(dump).not.toContain('v1.'); // шифрлэгдсэн утга
      const view = BorrowerListResponse.parse(bodies[3]);
      expect(view.items.map((i) => i.customer.registerNoMasked)).toEqual(['УБ90007701', 'УБ90007702', 'УБ90007703'].map((r) => maskRegisterNo(r)));
      expect(view.items[0].customer.registerNoMasked).toBe('УБ****7701');
      expect(view.warnings[0].message).not.toContain('90007701');
    });

    it('DB-д регистр шифрлэгдсэн (задарч байж тохирно)', async () => {
      const c = await cust({ registerNo: 'УБ90008888' });
      expect(c.registerNoEncrypted).not.toContain('90008888');
      expect(decryptedField(c.registerNoEncrypted)).toBe('УБ90008888');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('12. хураангуй, жагсаалт', () => {
    it('summary: тоо, орлого нэгтгэх харилцагчид, баталгааны хамрах хувь, хязгаар, editable; жагсаалтын дараалал', async () => {
      const app = await newApp({ amount: 20_000_000 });
      const [pl, g, co1, p, co2] = [await cust(), await cust(), await cust(), await cust(), await cust()];
      // зориуд эмх замбараагүй дарааллаар нэмнэ
      await addOk(app.id, pl.id, 'PLEDGOR'); await addOk(app.id, g.id, 'GUARANTOR', { guaranteeType: 'LIMITED', guaranteeAmount: 5_000_000 });
      await addOk(app.id, co1.id, 'CO_BORROWER', { liabilityShare: 0.25 }); await addOk(app.id, p.id, 'PRIMARY');
      await addOk(app.id, co2.id, 'CO_BORROWER', { incomeIncluded: false, liabilityShare: 0.25 });
      const view = await listOk(app.id);
      expect(view.items.map((i) => i.role)).toEqual(['PRIMARY', 'CO_BORROWER', 'CO_BORROWER', 'GUARANTOR', 'PLEDGOR']);
      expect(view.items.slice(1, 3).map((i) => i.customerId)).toEqual([co1.id, co2.id]);
      expect(view.summary).toEqual({
        primaryCount: 1, coBorrowerCount: 2, guarantorCount: 1, pledgorCount: 1, clientStepComplete: true, primaryLiabilityShare: 0.5,
        incomeContributorCustomerIds: [p.id, co1.id],
        guaranteeCoverageRatio: 0.25, limits: { maxCoBorrowers: 3, maxGuarantors: 3 }, editable: true,
      });
    });

    it('хоосон хүсэлт: items=[], clientStepComplete=false, coverage 0, warnings=[]', async () => {
      const app = await newApp();
      const view = await listOk(app.id);
      expect(view.items).toEqual([]);
      expect(view.summary).toMatchObject({ primaryCount: 0, clientStepComplete: false, incomeContributorCustomerIds: [], guaranteeCoverageRatio: 0, primaryLiabilityShare: null });
      expect(view.warnings).toEqual([]);
    });

    it('мутацийн хариу: borrower нь тухайн мөр, summary/warnings нь хүсэлтийн бүх төлөв', async () => {
      const app = await newApp();
      const [p, co] = [await cust(), await cust()];
      await addOk(app.id, p.id, 'PRIMARY');
      const res = await addOk(app.id, co.id, 'CO_BORROWER');
      expect(res.borrower).toMatchObject({ customerId: co.id, applicationId: app.id, role: 'CO_BORROWER', isPrimary: false, consentFileId: null, consentSignedAt: null });
      expect(res.summary).toMatchObject({ primaryCount: 1, coBorrowerCount: 1 });
      expect(res.warnings.map((w) => w.code)).toEqual(['CONSENT_MISSING']);
      expect(new Date(res.borrower.createdAt).toString()).not.toBe('Invalid Date');
    });

    it('createdBy / updatedBy: ЗЭЗ-ийн userId бичигдэнэ', async () => {
      const app = await newApp();
      const c = await cust();
      const b = await addOk(app.id, c.id, 'GUARANTOR');
      await http().patch(url(app.id, b.borrower.id)).set(actors.admin('admin-9')).send({ note: 'x' });
      const row = (await rowsOf(app.id))[0];
      expect(row).toMatchObject({ createdBy: 'officer-1', updatedBy: 'admin-9', orgId: ORG });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('зөвшөөрөл бүртгэх (consent)', () => {
    it('fileId ба signedAt хадгалагдана; ISO instant буцна', async () => {
      const app = await newApp();
      const g = await addOk(app.id, (await cust()).id, 'GUARANTOR');
      const res = await http().post(url(app.id, g.borrower.id, 'consent')).set(officer).send({ fileId: 'dms-file-7', signedAt: '2026-10-27T09:30:00.000Z' });
      expect(res.status).toBe(200);
      const body = BorrowerMutationResponse.parse(res.body);
      expect(body.borrower).toMatchObject({ consentFileId: 'dms-file-7', consentSignedAt: '2026-10-27T09:30:00.000Z' });
      const row = (await rowsOf(app.id))[0];
      expect(row.consentFileId).toBe('dms-file-7');
      expect(row.consentSignedAt?.toISOString()).toBe('2026-10-27T09:30:00.000Z');
    });

    it('давтан ижил хүсэлт → 200, event нэмэгдэхгүй; өөр файл → шинэчлэгдэнэ + event', async () => {
      const app = await newApp();
      const g = await addOk(app.id, (await cust()).id, 'GUARANTOR');
      const body = { fileId: 'f1', signedAt: '2026-10-27T09:30:00Z' };
      const r1 = await http().post(url(app.id, g.borrower.id, 'consent')).set(officer).send(body);
      const r2 = await http().post(url(app.id, g.borrower.id, 'consent')).set(officer).send(body);
      expect([r1.status, r2.status]).toEqual([200, 200]);
      expect(await events()).toHaveLength(2);
      const r3 = await http().post(url(app.id, g.borrower.id, 'consent')).set(officer).send({ fileId: 'f2', signedAt: '2026-10-27T09:30:00Z' });
      expect(r3.body.borrower.consentFileId).toBe('f2');
      expect(await events()).toHaveLength(3);
    });

    it('ирээдүйн огноо → 422 CONSENT_SIGNED_IN_FUTURE (5 минутын цагийн зөрүү зөвшөөрнө)', async () => {
      const app = await newApp();
      const g = await addOk(app.id, (await cust()).id, 'GUARANTOR');
      const future = await http().post(url(app.id, g.borrower.id, 'consent')).set(officer).send({ fileId: 'f', signedAt: '2026-10-28T03:00:00Z' });
      expect([future.status, future.body.code]).toEqual([422, 'CONSENT_SIGNED_IN_FUTURE']);
      const skew = await http().post(url(app.id, g.borrower.id, 'consent')).set(officer).send({ fileId: 'f', signedAt: '2026-10-28T02:03:00Z' });
      expect(skew.status).toBe(200);
      expect((await rowsOf(app.id))[0].consentFileId).toBe('f');
    });

    it('үндсэн ба барьцаалагчид ч бүртгэж болно', async () => {
      const app = await newApp();
      const p = await addOk(app.id, (await cust()).id, 'PRIMARY'); const pl = await addOk(app.id, (await cust()).id, 'PLEDGOR');
      for (const b of [p, pl]) expect((await http().post(url(app.id, b.borrower.id, 'consent')).set(officer).send({ fileId: 'f', signedAt: '2026-10-20T00:00:00Z' })).status).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('candidates (регистрээр хайх)', () => {
    const search = (appId: string, registerNo: string, actor: Record<string, string> = officer) => http().get(url(appId, 'candidates')).query({ registerNo }).set(actor);

    it('олдвол нуугдмал регистр, нэр, утас, төрөл, linkedRoles-той', async () => {
      const app = await newApp();
      const c = await cust({ registerNo: 'УБ90009901', lastName: 'Дорж', firstName: 'Сараа', phone: '88001122' });
      await addOk(app.id, c.id, 'PLEDGOR'); await addOk(app.id, c.id, 'PRIMARY');
      const res = await search(app.id, 'УБ90009901');
      expect(res.status).toBe(200);
      const body = BorrowerCandidate.array().parse(res.body);
      expect(body).toEqual([{ customerId: c.id, displayName: 'Дорж Сараа', registerNoMasked: 'УБ****9901', customerType: 'INDIVIDUAL', phone: '88001122', linkedRoles: ['PRIMARY', 'PLEDGOR'] }]);
      expect(JSON.stringify(res.body)).not.toContain('УБ90009901');
    });

    it('регистрийн том/жижиг үсэг, хоосон зайг нормчилно', async () => {
      const app = await newApp();
      const c = await cust({ registerNo: 'УБ90009902' });
      for (const q of ['уб90009902', '  УБ90009902  ', 'Уб90009902']) {
        const res = await search(app.id, q);
        expect([q, res.body.map((x: { customerId: string }) => x.customerId)]).toEqual([q, [c.id]]);
      }
    });

    it('энэ хүсэлтэд оролцоогүй бол linkedRoles=[]; олдохгүй / өөр байгууллагын харилцагч → []', async () => {
      const app = await newApp();
      const c = await cust({ registerNo: 'УБ90009903' }); await cust({ registerNo: 'УБ90009904', orgId: 'other-org' });
      const found = await search(app.id, 'УБ90009903');
      expect(found.body[0].linkedRoles).toEqual([]);
      for (const q of ['УБ00000000', 'УБ90009904', 'УБ9000990']) {
        const res = await search(app.id, q);
        expect([q, res.status, res.body]).toEqual([q, 200, []]);
      }
      expect(c.id).toBeTruthy();
    });

    it('өөр хүсэлтийн оролцоо linkedRoles-д орохгүй; төлөв засах боломжгүй хүсэлтэд ч хайна', async () => {
      const a1 = await newApp({ status: 'SUBMITTED' }); const a2 = await newApp();
      const c = await cust({ registerNo: 'УБ90009905' });
      await addOk(a2.id, c.id, 'GUARANTOR');
      const res = await search(a1.id, 'УБ90009905');
      expect(res.status).toBe(200);
      expect(res.body[0].linkedRoles).toEqual([]);
    });

    it('хуулийн этгээд: customerType LEGAL_ENTITY', async () => {
      const app = await newApp();
      await cust({ registerNo: '1234567', customerType: 'LEGAL_ENTITY', firstName: 'Монгол ХХК', lastName: null });
      const res = await search(app.id, '1234567');
      expect(res.body[0]).toMatchObject({ displayName: 'Монгол ХХК', customerType: 'LEGAL_ENTITY', registerNoMasked: '12*4567' });
    });

    it('өөр ЗЭЗ → 403; ADMIN → 200', async () => {
      const app = await newApp({ officerId: 'officer-1' });
      expect((await search(app.id, 'УБ1', actors.officer('officer-2'))).status).toBe(403);
      expect((await search(app.id, 'УБ1', actors.admin())).status).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('бүтэн урсгал (end-to-end сценари)', () => {
    it('ЗЭЗ хүсэлтэд үндсэн, хамтран, батлан даагч, барьцаалагч нэмж, засч, солиж, хасна', async () => {
      const app = await newApp({ amount: 30_000_000 });
      await seedSteps(app.id, { inquiry: 'COMPLETED', income: 'COMPLETED', score: 'COMPLETED' });
      const [p, co, g, pl] = await Promise.all([cust({ registerNo: 'УБ90010001' }), cust(), cust(), cust()]);

      const found = await http().get(url(app.id, 'candidates')).query({ registerNo: 'УБ90010001' }).set(officer);
      expect(found.body[0].customerId).toBe(p.id);

      const bp = await addOk(app.id, p.id, 'PRIMARY');
      const bco = await addOk(app.id, co.id, 'CO_BORROWER', { relationToPrimary: 'SPOUSE', liabilityShare: 0.5 });
      const bg = await addOk(app.id, g.id, 'GUARANTOR', { guaranteeType: 'LIMITED', guaranteeAmount: 10_000_000, relationToPrimary: 'PARENT' });
      const bpl = await addOk(app.id, pl.id, 'PLEDGOR', { relationToPrimary: 'SIBLING' });
      expect(bpl.summary).toMatchObject({ primaryCount: 1, coBorrowerCount: 1, guarantorCount: 1, pledgorCount: 1, primaryLiabilityShare: 0.5 });
      expect(bpl.warnings.map((w) => w.code).sort()).toEqual(['CONSENT_MISSING', 'CONSENT_MISSING', 'GUARANTEE_BELOW_LOAN']);

      for (const b of [bco, bg]) await http().post(url(app.id, b.borrower.id, 'consent')).set(officer).send({ fileId: `f-${b.borrower.role}`, signedAt: '2026-10-26T10:00:00Z' });
      const upd = await http().patch(url(app.id, bg.borrower.id)).set(officer).send({ guaranteeType: 'JOINT_AND_SEVERAL' });
      expect(BorrowerMutationResponse.parse(upd.body).warnings).toEqual([]);

      await http().post(url(app.id, bco.borrower.id, 'make-primary')).set(officer);
      let view = await listOk(app.id);
      expect(view.items.map((i) => [i.customerId, i.role])).toEqual([[co.id, 'PRIMARY'], [p.id, 'CO_BORROWER'], [g.id, 'GUARANTOR'], [pl.id, 'PLEDGOR']]);
      expect(view.items.find((i) => i.customerId === p.id)?.liabilityShare).toBe(0.5);

      expect((await http().delete(url(app.id, bp.borrower.id)).set(officer)).status).toBe(204);
      expect((await http().delete(url(app.id, bpl.borrower.id)).set(officer)).status).toBe(204);
      view = await listOk(app.id);
      expect(view.items.map((i) => i.role)).toEqual(['PRIMARY', 'GUARANTOR']);
      expect((await events()).map((e) => e.change)).toEqual(['ADDED', 'ADDED', 'ADDED', 'ADDED', 'UPDATED', 'UPDATED', 'UPDATED', 'PRIMARY_CHANGED', 'REMOVED', 'REMOVED']);
      await expectInvariants(app.id);
    });
  });
});
