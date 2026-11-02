import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { ApplicationDocumentMutationResponse, ApplicationDocumentsResponse, DocumentOcrCheck, StepKey, DocumentUploaded, DocumentRemoved } from '@los/contracts';
import { buildEvent } from '@los/database';
import { DomainError, UpstreamError } from '@los/nest-common';
import type { Product } from '.prisma/client-origination';
import { createTestApp, type TestApp } from '../../test-utils/test-app';
import { actors, createApplication, createBorrower, createCustomer, hasTestDb, ORG, resetDb } from '../../test-utils/factories';
import { DMS_DOCUMENTS } from './dms-documents.port';
import { DocumentModule } from './document.module';
import { MAX_RECONCILE_ATTEMPTS, SERVICE_PRINCIPAL } from './document.service';
import { FakeDmsDocuments, readableOcr } from './testing/fake-dms-documents';

const CHECKLIST = [
  { key: 'id_card', name: 'Иргэний үнэмлэхний хуулбар', required: true },
  { key: 'salary_statement', name: 'Цалингийн тодорхойлолт', required: true },
  { key: 'application_form', name: 'Зээлийн хүсэлтийн маягт', required: true },
];
const NOW = '2026-10-28T02:00:00.000Z'; // createTestApp-ийн тогтмол цаг

// FR-9.1, FR-9.2 — HTTP түвшний integration тест (supertest + бодит Postgres + dms-ийн fake).
describe.skipIf(!hasTestDb)('application documents API (DB, fake dms)', () => {
  let t: TestApp;
  let baseUrl: string;
  const dms = new FakeDmsDocuments();
  const officer = actors.officer();

  beforeAll(async () => {
    t = await createTestApp([DocumentModule], (b) => b.overrideProvider(DMS_DOCUMENTS).useValue(dms));
    await t.app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => { await t.close(); });
  beforeEach(async () => {
    await resetDb(t.prisma);
    dms.reset();
    vi.restoreAllMocks();
  });

  // ── туслахууд ─────────────────────────────────────────────────────────────────────────
  const http = () => request(baseUrl);
  const url = (appId: string, ...rest: string[]) => ['/api/applications', appId, 'documents', ...rest].join('/');

  async function product(checklist: unknown = CHECKLIST): Promise<Product> {
    return t.prisma.product.create({
      data: { orgId: ORG, code: `T-${Math.random().toString(36).slice(2, 8)}`, name: 'Тест бүтээгдэхүүн', productType: 'CONSUMER', minAmount: 100_000, maxAmount: 50_000_000, minTerm: 1, maxTerm: 36, minRate: 18, maxRate: 42, documentChecklistJson: checklist as never },
    });
  }
  async function seedSteps(appId: string, status: Partial<Record<StepKey, string>> = {}, fallback = 'PENDING') {
    await t.prisma.loanApplicationStep.createMany({ data: StepKey.map((stepKey) => ({ orgId: ORG, applicationId: appId, stepKey, status: status[stepKey] ?? fallback })) });
  }
  const step = (appId: string) => t.prisma.loanApplicationStep.findUniqueOrThrow({ where: { applicationId_stepKey: { applicationId: appId, stepKey: 'document' } } });
  /** Бүтээгдэхүүнтэй, алхмууд бэлдсэн (document=PENDING) хүсэлт. */
  async function scenario(o: { checklist?: unknown; status?: string; officerId?: string; steps?: Partial<Record<StepKey, string>> | false } = {}) {
    const prod = await product(o.checklist);
    const app = await createApplication(t.prisma, { productId: prod.id, status: o.status ?? 'DRAFT', ...(o.officerId ? { officerId: o.officerId } : {}) });
    if (o.steps !== false) await seedSteps(app.id, o.steps ?? { document: 'PENDING' });
    return { prod, app };
  }
  const file = (name = 'scan.pdf', org = ORG) => dms.addFile(org, { name });
  const attach = (appId: string, body: Record<string, unknown>, actor: Record<string, string> = officer) => http().post(url(appId)).set(actor).send(body);
  const list = (appId: string, actor: Record<string, string> = officer) => http().get(url(appId)).set(actor);
  const remove = (appId: string, docId: string, actor: Record<string, string> = officer) => http().delete(url(appId, docId)).set(actor);
  const ocr = (appId: string, docId: string, actor: Record<string, string> = officer) => http().post(url(appId, docId, 'ocr')).set(actor).send({});

  async function attachOk(appId: string, body: Record<string, unknown>, actor: Record<string, string> = officer) {
    const res = await attach(appId, { fileId: file(), ...body }, actor);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return ApplicationDocumentMutationResponse.parse(res.body);
  }
  async function listOk(appId: string, actor: Record<string, string> = officer) {
    const res = await list(appId, actor);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return ApplicationDocumentsResponse.parse(res.body);
  }
  const audits = (appId: string) => t.prisma.auditLog.findMany({ where: { applicationId: appId, entity: 'DOCUMENT' }, orderBy: { at: 'asc' } });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('AC (docs/04 M9): checklist 3 төрөл', () => {
    it('2 оруулахад PENDING, 3-р нь COMPLETED, нэгийг хасахад дахин PENDING', async () => {
      const { app } = await scenario();
      expect((await step(app.id)).status).toBe('PENDING');

      const first = await attachOk(app.id, { checklistKey: 'id_card' });
      expect(first.documents.summary).toEqual({ productMissing: false, required: 3, satisfied: 1, complete: false, missing: ['salary_statement', 'application_form'] });
      const second = await attachOk(app.id, { checklistKey: 'salary_statement' });
      expect(second.documents.summary).toMatchObject({ satisfied: 2, complete: false, missing: ['application_form'] });
      expect((await step(app.id)).status).toBe('PENDING');
      expect((await step(app.id)).completedAt).toBeNull();

      const third = await attachOk(app.id, { checklistKey: 'application_form' });
      expect(third.documents.summary).toEqual({ productMissing: false, required: 3, satisfied: 3, complete: true, missing: [] });
      const done = await step(app.id);
      expect(done.status).toBe('COMPLETED');
      expect(done.completedAt?.toISOString()).toBe(NOW);

      const removed = await remove(app.id, second.document!.id);
      expect(removed.status).toBe(200);
      const body = ApplicationDocumentMutationResponse.parse(removed.body);
      expect(body.document).toBeNull();
      expect(body.documents.summary).toMatchObject({ satisfied: 2, complete: false, missing: ['salary_statement'] });
      const back = await step(app.id);
      expect(back.status).toBe('PENDING');
      expect(back.completedAt).toBeNull();

      await attachOk(app.id, { checklistKey: 'salary_statement' });
      expect((await step(app.id)).status).toBe('COMPLETED');
    });

    it('мутацийн хариу: хавсарсан баримт (ажилтан, файлын мэдээлэл), checklist, items — GET-тэй ижил', async () => {
      const { app } = await scenario();
      const fileId = dms.addFile(ORG, { name: 'id-card.png', mime: 'image/png', size: 4321 });
      const res = await attachOk(app.id, { fileId, checklistKey: 'id_card', note: 'Урд хойд' });
      expect(res.document).toMatchObject({
        applicationId: app.id, type: 'id_card', checklistKey: 'id_card', relatedEntity: 'APPLICATION', relatedId: null, note: 'Урд хойд', fileId, fileName: 'id-card.png', mime: 'image/png', size: 4321, uploadedBy: 'officer-1',
      });
      expect(res.documents.items.map((d) => d.id)).toEqual([res.document!.id]);
      expect(res.documents.checklist[0]).toMatchObject({ key: 'id_card', satisfied: true });
      expect(await listOk(app.id)).toEqual(res.documents);
    });

    it('төрөл дутуу хүсэлт: GET нь checklist-ийн бүх мөр, хоосон extras, дутуу түлхүүрүүдийг өгнө', async () => {
      const { app } = await scenario();
      const out = await listOk(app.id);
      expect(out.items).toEqual([]);
      expect(out.checklist.map((c) => [c.key, c.required, c.satisfied])).toEqual([['id_card', true, false], ['salary_statement', true, false], ['application_form', true, false]]);
      expect(out.summary).toEqual({ productMissing: false, required: 3, satisfied: 0, complete: false, missing: ['id_card', 'salary_statement', 'application_form'] });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('checklist ба нэмэлт баримт (extras)', () => {
    it('type=other (түлхүүргүй) ба чөлөөт төрөл нь extras: checklist-ийг хангахгүй, алхмыг өөрчлөхгүй', async () => {
      const { app } = await scenario();
      const other = await attachOk(app.id, { type: 'other', note: 'Нэмэлт' });
      const custom = await attachOk(app.id, { type: 'Хуучин зээлийн гэрээ' });
      expect(other.document).toMatchObject({ type: 'other', checklistKey: null });
      expect(custom.document).toMatchObject({ checklistKey: null });
      const out = await listOk(app.id);
      expect(out.extras.map((d) => d.id)).toEqual([other.document!.id, custom.document!.id]);
      expect(out.items).toHaveLength(2);
      expect(out.checklist.every((c) => !c.satisfied)).toBe(true);
      expect(out.summary).toMatchObject({ satisfied: 0, complete: false });
      expect((await step(app.id)).status).toBe('PENDING');
    });

    it('төрөл нь checklist-ийн түлхүүртэй давхцвал тэр мөрийг хангана (type: "id_card" ≡ checklistKey: "id_card")', async () => {
      const { app } = await scenario();
      const res = await attachOk(app.id, { type: 'ID_CARD' });
      expect(res.document).toMatchObject({ type: 'id_card', checklistKey: 'id_card' });
      expect(res.documents.checklist[0]!.satisfied).toBe(true);
      expect(res.documents.extras).toEqual([]);
    });

    it('checklistKey өгвөл type анхдагчаар түүнтэй ижил; нэг түлхүүрт хэд хэдэн баримт', async () => {
      const { app } = await scenario();
      await attachOk(app.id, { checklistKey: 'id_card' });
      const second = await attachOk(app.id, { checklistKey: 'id_card', type: 'Иргэний үнэмлэх (ар тал)' });
      expect(second.document!.type).toBe('иргэний_үнэмлэх_(ар_тал)');
      const out = second.documents;
      expect(out.checklist[0]!.documents).toHaveLength(2);
      expect(out.summary.satisfied).toBe(1);
    });

    it('бүтээгдэхүүний түлхүүр том үсэгтэй ("ID_CARD") байсан ч нормчилж таарна, каноник түлхүүрээр хадгална', async () => {
      const { app } = await scenario({ checklist: [{ key: 'ID_CARD', name: 'Үнэмлэх', required: true }] });
      const res = await attachOk(app.id, { checklistKey: ' id_card ' });
      expect(res.document!.checklistKey).toBe('id_card'); // dms нормчилсон
      expect(res.documents.checklist[0]).toMatchObject({ key: 'ID_CARD', satisfied: true });
      expect(res.documents.summary.complete).toBe(true);
      expect((await step(app.id)).status).toBe('COMPLETED');
    });

    it('сонголттой (required=false) мөр алхмыг хаахгүй', async () => {
      const { app } = await scenario({ checklist: [{ key: 'a', name: 'A', required: true }, { key: 'b', name: 'B', required: false }] });
      await attachOk(app.id, { checklistKey: 'a' });
      expect((await step(app.id)).status).toBe('COMPLETED');
    });

    it('checklist-д байхгүй түлхүүр → 422 UNKNOWN_CHECKLIST_KEY (dms руу очдоггүй)', async () => {
      const { app } = await scenario();
      const res = await attach(app.id, { fileId: file(), checklistKey: 'passport' });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('UNKNOWN_CHECKLIST_KEY');
      expect(res.body.details.allowedKeys).toEqual(['id_card', 'salary_statement', 'application_form']);
      expect(dms.callsOf('create')).toHaveLength(0);
      expect(dms.all()).toHaveLength(0);
    });

    it('төрөл ч, түлхүүр ч байхгүй → 400 VALIDATION_FAILED; буруу fileId (uuid биш) → 400', async () => {
      const { app } = await scenario();
      for (const body of [{ fileId: file() }, { fileId: 'x', type: 'other' }, { type: 'other' }, { fileId: file(), type: 'other', relatedEntity: 'NOPE' }]) {
        const res = await attach(app.id, body);
        expect([res.status, res.body.code]).toEqual([400, 'VALIDATION_FAILED']);
      }
    });

    it('dms-д файл байхгүй/устсан/өөр байгууллагынх → 422 FILE_NOT_FOUND; алхам, аудит өөрчлөгдөхгүй', async () => {
      const { app } = await scenario();
      const purged = file();
      dms.purgeFile(purged);
      const foreign = dms.addFile('other-org');
      for (const fileId of [purged, foreign, '11111111-1111-4111-8111-111111111111']) {
        const res = await attach(app.id, { fileId, checklistKey: 'id_card' });
        expect([res.status, res.body.code]).toEqual([422, 'FILE_NOT_FOUND']);
      }
      expect(await audits(app.id)).toHaveLength(0);
      expect((await step(app.id)).status).toBe('PENDING');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('холбоос: BORROWER / COLLATERAL / APPLICATION', () => {
    it('BORROWER: хүсэлтийн оролцогч (аль ч дүр) → 201, relatedEntity/relatedId хадгалагдана, түлхүүрийг хангана', async () => {
      const { app } = await scenario();
      const primary = await createCustomer(t.prisma);
      const guarantor = await createCustomer(t.prisma);
      await createBorrower(t.prisma, app.id, primary.id, 'PRIMARY');
      await createBorrower(t.prisma, app.id, guarantor.id, 'GUARANTOR');
      const res = await attachOk(app.id, { checklistKey: 'id_card', relatedEntity: 'BORROWER', relatedId: guarantor.id });
      expect(res.document).toMatchObject({ relatedEntity: 'BORROWER', relatedId: guarantor.id, checklistKey: 'id_card' });
      expect(res.documents.checklist[0]).toMatchObject({ satisfied: true });
      const forPledgor = await createCustomer(t.prisma);
      await createBorrower(t.prisma, app.id, forPledgor.id, 'PLEDGOR');
      await attachOk(app.id, { type: 'other', relatedEntity: 'BORROWER', relatedId: forPledgor.id });
    });

    it('BORROWER: relatedId заавал (422 RELATED_ID_REQUIRED)', async () => {
      const { app } = await scenario();
      const res = await attach(app.id, { fileId: file(), checklistKey: 'id_card', relatedEntity: 'BORROWER' });
      expect([res.status, res.body.code]).toEqual([422, 'RELATED_ID_REQUIRED']);
      expect(dms.callsOf('create')).toHaveLength(0);
    });

    it('BORROWER: хүсэлтийн оролцогч биш (өөр хүсэлтийн, үл мэдэгдэх, өөр байгууллагын) харилцагч → 422 BORROWER_NOT_ON_APPLICATION', async () => {
      const { app } = await scenario();
      const other = await createApplication(t.prisma);
      const stranger = await createCustomer(t.prisma);
      const ofOther = await createCustomer(t.prisma);
      await createBorrower(t.prisma, other.id, ofOther.id, 'PRIMARY');
      for (const relatedId of [stranger.id, ofOther.id, 'no-such-customer']) {
        const res = await attach(app.id, { fileId: file(), checklistKey: 'id_card', relatedEntity: 'BORROWER', relatedId });
        expect([relatedId === stranger.id ? 's' : 'o', res.status, res.body.code]).toEqual([relatedId === stranger.id ? 's' : 'o', 422, 'BORROWER_NOT_ON_APPLICATION']);
      }
      expect(dms.callsOf('create')).toHaveLength(0);
    });

    it('COLLATERAL → 422 USE_COLLATERAL_DOCUMENTS (барьцааны баримт барьцааны endpoint-оор); dms-д хүрэхгүй', async () => {
      const { app } = await scenario();
      const res = await attach(app.id, { fileId: file(), type: 'ownership_certificate', relatedEntity: 'COLLATERAL', relatedId: 'col-1' });
      expect([res.status, res.body.code]).toEqual([422, 'USE_COLLATERAL_DOCUMENTS']);
      expect(res.body.message).toMatch(/[а-я]/i);
      expect(dms.callsOf('create')).toHaveLength(0);
    });

    it('APPLICATION нь relatedId-тай байж болохгүй (422 RELATED_ID_NOT_ALLOWED)', async () => {
      const { app } = await scenario();
      const res = await attach(app.id, { fileId: file(), type: 'other', relatedId: 'x' });
      expect([res.status, res.body.code]).toEqual([422, 'RELATED_ID_NOT_ALLOWED']);
    });

    it('dms-д барьцааны баримт байвч хүсэлтийн checklist/items/extras-д орохгүй, энэ endpoint-оор хасаж болохгүй', async () => {
      const { app } = await scenario();
      const fileId = file();
      const col = await dms.insertDirect(ORG, { applicationId: app.id, type: 'id_card', checklistKey: 'id_card', relatedEntity: 'COLLATERAL', relatedId: 'col-1', fileId });
      const out = await listOk(app.id);
      expect(out.items).toEqual([]);
      expect(out.checklist[0]!.satisfied).toBe(false);
      const res = await remove(app.id, col.id);
      expect([res.status, res.body.code]).toEqual([422, 'USE_COLLATERAL_DOCUMENTS']);
      expect(dms.callsOf('remove')).toHaveLength(0);
      expect(dms.all()).toHaveLength(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('бүтээгдэхүүн байхгүй / checklist буруу (FR-9.2)', () => {
    it('бүтээгдэхүүн сонгоогүй: productMissing, хоосон checklist; төрлөөр хавсаргаж болно (extras), алхам PENDING', async () => {
      const app = await createApplication(t.prisma, { productId: null });
      await seedSteps(app.id, { document: 'PENDING' });
      const empty = await listOk(app.id);
      expect(empty.summary).toEqual({ productMissing: true, required: 0, satisfied: 0, complete: false, missing: [] });
      expect(empty.checklist).toEqual([]);
      const res = await attachOk(app.id, { type: 'other', note: 'Эхлээд' });
      expect(res.documents.extras).toHaveLength(1);
      expect(res.documents.summary.productMissing).toBe(true);
      expect((await step(app.id)).status).toBe('PENDING');
    });

    it('бүтээгдэхүүнгүй үед checklistKey өгвөл 422 UNKNOWN_CHECKLIST_KEY', async () => {
      const app = await createApplication(t.prisma, { productId: null });
      const res = await attach(app.id, { fileId: file(), checklistKey: 'id_card' });
      expect([res.status, res.body.code]).toEqual([422, 'UNKNOWN_CHECKLIST_KEY']);
      expect(res.body.details.allowedKeys).toEqual([]);
    });

    it('бүтээгдэхүүнтэй болсны дараа (4-р алхам) өмнө хавсаргасан түлхүүртэй баримт тооцогдоно', async () => {
      const app = await createApplication(t.prisma, { productId: null });
      await seedSteps(app.id, { document: 'PENDING' });
      await attachOk(app.id, { type: 'id_card' }); // бүтээгдэхүүнгүй үед түлхүүргүй
      const prod = await product([{ key: 'id_card', name: 'Үнэмлэх', required: true }]);
      await t.prisma.loanApplication.update({ where: { id: app.id }, data: { productId: prod.id } });
      // түлхүүргүй баримт нь checklist-ийг хангахгүй (extras) — гараар дахин хавсаргана
      const out = await listOk(app.id);
      expect(out.summary).toMatchObject({ productMissing: false, complete: false, missing: ['id_card'] });
      expect(out.extras).toHaveLength(1);
      await attachOk(app.id, { checklistKey: 'id_card' });
      expect((await step(app.id)).status).toBe('COMPLETED');
    });

    it('checklist JSON буруу хэлбэртэй → хоосон checklist гэж үзнэ (алдаа биш); null → мөн хоосон', async () => {
      for (const bad of ['id_card', { key: 'a' }, [{ key: '' }], null]) {
        await resetDb(t.prisma);
        const { app } = await scenario({ checklist: bad });
        const out = await listOk(app.id);
        expect(out.checklist, JSON.stringify(bad)).toEqual([]);
        expect(out.summary).toEqual({ productMissing: false, required: 0, satisfied: 0, complete: true, missing: [] });
        await attachOk(app.id, { type: 'other' }); // түлхүүргүйгээр хавсаргаж болно
        expect((await step(app.id)).status).toBe('COMPLETED'); // шаардлагагүй бүтээгдэхүүн: алхам хаагдана
      }
    });

    it('бүтээгдэхүүн DB-д алга (productId өлгөөтэй) → productMissing', async () => {
      const app = await createApplication(t.prisma, { productId: null });
      // Product FK байдаг тул өөр байгууллагын бүтээгдэхүүнийг заана: org-ын хүрээнд олдохгүй
      const foreign = await t.prisma.product.create({ data: { orgId: 'other-org', code: `F-${Date.now()}`, name: 'Бусад', productType: 'CONSUMER', minAmount: 1, maxAmount: 2, minTerm: 1, maxTerm: 2, minRate: 1, maxRate: 2, documentChecklistJson: CHECKLIST } });
      await t.prisma.loanApplication.update({ where: { id: app.id }, data: { productId: foreign.id } });
      try {
        expect((await listOk(app.id)).summary.productMissing).toBe(true);
      } finally {
        await t.prisma.loanApplication.update({ where: { id: app.id }, data: { productId: null } });
        await t.prisma.product.delete({ where: { id: foreign.id } });
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('эрх (NFR-3)', () => {
    it('нэвтрээгүй → 401 UNAUTHENTICATED; CUSTOMER дүр → 403 (бүх endpoint)', async () => {
      const { app } = await scenario();
      const c = await createCustomer(t.prisma);
      await createBorrower(t.prisma, app.id, c.id, 'PRIMARY');
      const calls = (h: Record<string, string>) => [http().get(url(app.id)).set(h), http().post(url(app.id)).set(h).send({}), http().delete(url(app.id, 'x')).set(h), http().post(url(app.id, 'x', 'ocr')).set(h).send({})];
      for (const r of await Promise.all(calls(actors.anonymous()))) expect([r.status, r.body.code]).toEqual([401, 'UNAUTHENTICATED']);
      for (const r of await Promise.all(calls(actors.customer(c.id)))) expect([r.status, r.body.code]).toEqual([403, 'FORBIDDEN']);
    });

    it('унших: өөрийн ЗЭЗ, өөрийн салбарын захирал, батлагч, админ → 200; өөр ЗЭЗ / өөр салбар → 403', async () => {
      const { app } = await scenario({ officerId: 'officer-1' });
      for (const actor of [actors.officer('officer-1'), actors.branchManager('bm', 'branch-1'), actors.approver(), actors.admin()]) expect((await list(app.id, actor)).status).toBe(200);
      for (const actor of [actors.officer('officer-2'), actors.branchManager('bm', 'branch-2')]) {
        const res = await list(app.id, actor);
        expect([res.status, res.body.code]).toEqual([403, 'FORBIDDEN']);
      }
    });

    it('бичих: өөр ЗЭЗ → 403; BRANCH_MANAGER, APPROVER → 403 (унших эрхтэй ч); өөрийн ЗЭЗ ба ADMIN → 201', async () => {
      const { app } = await scenario({ officerId: 'officer-1' });
      for (const actor of [actors.officer('officer-2'), actors.branchManager('bm', 'branch-1'), actors.approver()]) {
        const res = await attach(app.id, { fileId: file(), type: 'other' }, actor);
        expect([res.status, res.body.code]).toEqual([403, 'FORBIDDEN']);
      }
      expect(dms.callsOf('create')).toHaveLength(0);
      expect((await attach(app.id, { fileId: file(), checklistKey: 'id_card' })).status).toBe(201);
      expect((await attach(app.id, { fileId: file(), checklistKey: 'salary_statement' }, actors.admin())).status).toBe(201);
    });

    it('хасах: өөр ЗЭЗ / салбарын захирал / батлагч → 403 (баримт хэвээр); өөрийн ЗЭЗ, ADMIN → 200', async () => {
      const { app } = await scenario({ officerId: 'officer-1' });
      const a = await attachOk(app.id, { checklistKey: 'id_card' });
      const b = await attachOk(app.id, { checklistKey: 'salary_statement' });
      for (const actor of [actors.officer('officer-2'), actors.branchManager('bm', 'branch-1'), actors.approver()]) expect((await remove(app.id, a.document!.id, actor)).status).toBe(403);
      expect(dms.all()).toHaveLength(2);
      expect((await remove(app.id, a.document!.id)).status).toBe(200);
      expect((await remove(app.id, b.document!.id, actors.admin())).status).toBe(200);
      expect(dms.all()).toHaveLength(0);
    });

    it('хүсэлт олдохгүй / өөр байгууллагын хүсэлт → 404 APPLICATION_NOT_FOUND (бүх endpoint)', async () => {
      const { app } = await scenario();
      const foreign = { ...officer, 'x-org-id': 'other-org' };
      for (const [appId, actor] of [['missing', officer], [app.id, foreign]] as const) {
        const rs = [await list(appId, actor), await attach(appId, { fileId: file(), type: 'other' }, actor), await remove(appId, 'x', actor), await ocr(appId, 'x', actor)];
        for (const r of rs) expect([r.status, r.body.code]).toEqual([404, 'APPLICATION_NOT_FOUND']);
      }
    });

    it('баримт нь өөр хүсэлтийнх бол (docId таарсан ч) 404 DOCUMENT_NOT_FOUND — dms руу устгал очдоггүй', async () => {
      const { app } = await scenario();
      const other = await createApplication(t.prisma);
      const mine = await attachOk(app.id, { checklistKey: 'id_card' });
      const foreignDoc = await dms.insertDirect(ORG, { applicationId: other.id, type: 'other', relatedEntity: 'APPLICATION', fileId: file() });
      const res = await remove(app.id, foreignDoc.id);
      expect([res.status, res.body.code]).toEqual([404, 'DOCUMENT_NOT_FOUND']);
      expect((await remove(app.id, 'nope')).status).toBe(404);
      expect(dms.callsOf('remove')).toHaveLength(0);
      expect(dms.all()).toHaveLength(2);
      expect(mine.document).toBeTruthy();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('хүсэлтийн төлөв (FR-10.4)', () => {
    it.each(['SUBMITTED', 'IN_APPROVAL', 'APPROVED', 'DISBURSING', 'ACTIVE', 'REJECTED', 'CLOSED'])('%s төлөвт хавсаргах/хасах → 409 APPLICATION_NOT_EDITABLE; унших боломжтой', async (status) => {
      const { app } = await scenario({ status });
      const doc = await dms.insertDirect(ORG, { applicationId: app.id, type: 'other', relatedEntity: 'APPLICATION', fileId: file() });
      const a = await attach(app.id, { fileId: file(), checklistKey: 'id_card' });
      expect([a.status, a.body.code, a.body.details]).toEqual([409, 'APPLICATION_NOT_EDITABLE', { status }]);
      const r = await remove(app.id, doc.id);
      expect([r.status, r.body.code]).toEqual([409, 'APPLICATION_NOT_EDITABLE']);
      expect(dms.callsOf('create')).toHaveLength(0);
      expect(dms.callsOf('remove')).toHaveLength(0);
      expect((await list(app.id)).status).toBe(200);
    });

    it('RETURNED төлөвт засна', async () => {
      const { app } = await scenario({ status: 'RETURNED' });
      expect((await attach(app.id, { fileId: file(), checklistKey: 'id_card' })).status).toBe(201);
    });

    it('LOCKED алхамд хүрэхгүй (төлөв, completed_at хэвээр); алхмын мөр огт байхгүй ч алдаагүй', async () => {
      const { app } = await scenario({ checklist: [{ key: 'a', name: 'A', required: true }], steps: { document: 'LOCKED' } });
      await attachOk(app.id, { checklistKey: 'a' });
      const locked = await step(app.id);
      expect([locked.status, locked.completedAt]).toEqual(['LOCKED', null]);
      const bare = await scenario({ checklist: [{ key: 'a', name: 'A', required: true }], steps: false });
      await attachOk(bare.app.id, { checklistKey: 'a' });
      expect(await t.prisma.loanApplicationStep.count({ where: { applicationId: bare.app.id } })).toBe(0);
    });

    it('document алхмаас бусад алхамд хүрэхгүй', async () => {
      const { app } = await scenario({ checklist: [{ key: 'a', name: 'A', required: true }], steps: { document: 'PENDING', client: 'COMPLETED', score: 'COMPLETED' } });
      await attachOk(app.id, { checklistKey: 'a' });
      const rows = await t.prisma.loanApplicationStep.findMany({ where: { applicationId: app.id } });
      expect(Object.fromEntries(rows.map((r) => [r.stepKey, r.status]))).toMatchObject({ document: 'COMPLETED', client: 'COMPLETED', score: 'COMPLETED', income: 'PENDING', loan: 'PENDING' });
    });

    it('STALE алхам дахин тооцогдоно (COMPLETED ⇄ PENDING)', async () => {
      const { app } = await scenario({ checklist: [{ key: 'a', name: 'A', required: true }], steps: { document: 'STALE' } });
      await attachOk(app.id, { checklistKey: 'a' });
      expect((await step(app.id)).status).toBe('COMPLETED');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('зэрэг өөрчлөлт, dms-ийн алдаа', () => {
    it('ШИНЭ жагсаалтаар тооцно: attach-ийн дараа хэн нэгэн баримтыг хассан бол алхам эцсийн жагсаалттай нийцнэ (бичих → дахин унших → давтах)', async () => {
      const { app } = await scenario({ checklist: [{ key: 'a', name: 'A', required: true }, { key: 'b', name: 'B', required: true }] });
      await attachOk(app.id, { checklistKey: 'a' });
      // b-г хавсаргах үед: жагсаалт #1 (a, b) → COMPLETED бичнэ → жагсаалт #2-ийн өмнө өөр хүн b-г хасна → #2 нь зөрнө → давтаж PENDING болгоно
      let removedB = false;
      const base = dms.listCalls; // attach бүр reconcile-д 2 жагсаалт уншина (бичихийн өмнө, дараа): энэ attach-ийн 2-р жагсаалтын өмнө
      dms.beforeList = (n) => {
        if (n !== base + 2 || removedB) return;
        removedB = true;
        const b = dms.all(ORG).find((d) => d.checklistKey === 'b')!;
        dms.removeDirect(ORG, b.id);
      };
      const res = await attach(app.id, { fileId: file(), checklistKey: 'b' });
      expect(res.status).toBe(201);
      expect(removedB).toBe(true);
      expect(res.body.documents.summary).toMatchObject({ complete: false, missing: ['b'] });
      expect((await step(app.id)).status).toBe('PENDING');
      expect((await step(app.id)).completedAt).toBeNull();
    });

    it('зэрэг өөрчлөлт хэт их үед давталт хязгаартай (MAX_RECONCILE_ATTEMPTS) — гацахгүй', async () => {
      const { app } = await scenario({ checklist: [{ key: 'a', name: 'A', required: true }] });
      let flip = 0;
      dms.beforeList = (n) => {
        if (n < 2) return;
        // жагсаалт бүрийн өмнө нэг баримт нэмж/хасч байнга зөрүүлнэ
        if (flip++ % 2 === 0) void dms.insertDirect(ORG, { applicationId: app.id, type: 'other', relatedEntity: 'APPLICATION', fileId: file() });
        else dms.removeDirect(ORG, dms.all(ORG).find((d) => d.type === 'other')!.id);
      };
      const res = await attach(app.id, { fileId: file(), checklistKey: 'a' });
      expect(res.status).toBe(201);
      expect(dms.listCalls).toBeLessThanOrEqual(1 + MAX_RECONCILE_ATTEMPTS);
    });

    it('зэрэг attach/remove нь нэг төлөвт нийлнэ: алхам дандаа dms-ийн эцсийн жагсаалттай нийцнэ', async () => {
      for (let round = 0; round < 6; round++) {
        await resetDb(t.prisma);
        dms.reset();
        const { app } = await scenario();
        const seed = [await attachOk(app.id, { checklistKey: 'id_card' }), await attachOk(app.id, { checklistKey: 'salary_statement' })];
        const ops = [
          attach(app.id, { fileId: file(), checklistKey: 'application_form' }),
          attach(app.id, { fileId: file(), checklistKey: 'application_form' }),
          remove(app.id, seed[0]!.document!.id),
          attach(app.id, { fileId: file(), checklistKey: 'id_card' }),
          remove(app.id, seed[1]!.document!.id),
          attach(app.id, { fileId: file(), checklistKey: 'salary_statement' }),
        ];
        const results = await Promise.all(ops);
        expect(results.every((r) => [200, 201].includes(r.status)), JSON.stringify(results.map((r) => r.status))).toBe(true);
        const keys = new Set(dms.all(ORG).map((d) => d.checklistKey));
        const complete = CHECKLIST.every((c) => keys.has(c.key));
        expect((await step(app.id)).status, `round ${round}`).toBe(complete ? 'COMPLETED' : 'PENDING');
        const final = await listOk(app.id);
        expect(final.summary.complete).toBe(complete);
      }
    });

    it('dms унасан үед хавсралт 502/504, юу ч өөрчлөгдөхгүй (аудит, алхам)', async () => {
      const { app } = await scenario();
      dms.failNext('create', new UpstreamError('dms', null, 'dms хариу өгсөнгүй (timeout)', 504));
      const res = await attach(app.id, { fileId: file(), checklistKey: 'id_card' });
      expect(res.status).toBe(504);
      expect(res.body.code).toBe('UPSTREAM_TIMEOUT');
      expect(await audits(app.id)).toHaveLength(0);
      expect((await step(app.id)).status).toBe('PENDING');
      dms.failNext('list', new UpstreamError('dms', 503, 'dms алдаа буцаалаа (503)', 502));
      expect((await list(app.id)).status).toBe(502);
    });

    it('хүсэлт хаагдсан (attach-ийн явцад SUBMITTED болсон) → 409, dms-д орсон баримтыг буцаана, алхам хөдлөхгүй', async () => {
      const { app } = await scenario({ checklist: [{ key: 'a', name: 'A', required: true }] });
      dms.afterCreate = async () => { await t.prisma.loanApplication.update({ where: { id: app.id }, data: { status: 'SUBMITTED' } }); };
      const res = await attach(app.id, { fileId: file(), checklistKey: 'a' });
      expect([res.status, res.body.code]).toEqual([409, 'APPLICATION_NOT_EDITABLE']);
      expect(dms.all()).toHaveLength(0); // өнчин баримт үлдээгээгүй
      expect(dms.callsOf('remove')).toHaveLength(1);
      expect((await step(app.id)).status).toBe('PENDING');
      expect(await audits(app.id)).toHaveLength(0);
    });

    it('жагсаалт унасан ч баримт орсон: алдаа буцаана, дараа нь DocumentUploaded event алхмыг засна (subscriber нөөц)', async () => {
      const { app } = await scenario({ checklist: [{ key: 'a', name: 'A', required: true }] });
      // create амжилттай, дараагийн жагсаалт (дахин тооцоолол) унана
      dms.beforeList = (n) => { if (n === 1) dms.failNext('list', new UpstreamError('dms', null, 'холбогдож чадсангүй', 502)); };
      const res = await attach(app.id, { fileId: file(), checklistKey: 'a' });
      expect(res.status).toBe(502);
      expect(dms.all()).toHaveLength(1);
      expect((await audits(app.id)).map((a) => a.action)).toEqual(['DOCUMENT_ATTACHED']);
      expect((await step(app.id)).status).toBe('PENDING'); // хараахан тусгагдаагүй
      dms.beforeList = undefined;
      const stored = dms.all()[0]!;
      await t.bus.publish(buildEvent({ orgId: ORG, userId: 'officer-1', correlationId: 'c1' }, 'DocumentUploaded', { documentId: stored.id, applicationId: app.id, kind: 'a', checklistKey: 'a', relatedEntity: 'APPLICATION', relatedId: null, fileId: stored.fileId }));
      expect((await step(app.id)).status).toBe('COMPLETED');
    });

    it('remove: dms-д аль хэдийн устсан (зэрэг устгал) бол алдаагүй, үр дүн адил', async () => {
      const { app } = await scenario({ checklist: [{ key: 'a', name: 'A', required: true }] });
      const added = await attachOk(app.id, { checklistKey: 'a' });
      expect((await step(app.id)).status).toBe('COMPLETED');
      vi.spyOn(dms, 'remove').mockImplementationOnce(async (id, ctx) => { dms.removeDirect(ctx.orgId, id); return false; });
      const res = await remove(app.id, added.document!.id);
      expect(res.status).toBe(200);
      expect(res.body.documents.items).toEqual([]);
      expect((await step(app.id)).status).toBe('PENDING');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('аудит ба PII', () => {
    it('DOCUMENT_ATTACHED / DOCUMENT_REMOVED аудит: хэн, юуг; тайлбар, файлын нэр, чөлөөт төрөл орохгүй', async () => {
      const { app } = await scenario();
      const customer = await createCustomer(t.prisma, { registerNo: 'УБ90000001' });
      await createBorrower(t.prisma, app.id, customer.id, 'PRIMARY');
      const fileId = dms.addFile(ORG, { name: 'Бат-Эрдэнэ-үнэмлэх.pdf' });
      const added = await attachOk(app.id, { fileId, checklistKey: 'id_card', relatedEntity: 'BORROWER', relatedId: customer.id, note: 'Бат-Эрдэнийн УБ90000001 үнэмлэх' });
      await attachOk(app.id, { type: 'Бат-Эрдэнийн гэрчилгээ' });
      await remove(app.id, added.document!.id);
      const rows = await audits(app.id);
      expect(rows.map((r) => [r.action, r.actorId, r.orgId])).toEqual([['DOCUMENT_ATTACHED', 'officer-1', ORG], ['DOCUMENT_ATTACHED', 'officer-1', ORG], ['DOCUMENT_REMOVED', 'officer-1', ORG]]);
      expect(rows[0]).toMatchObject({ entity: 'DOCUMENT', entityId: added.document!.id, applicationId: app.id });
      expect(rows[0]!.afterJson).toEqual({ documentId: added.document!.id, fileId, checklistKey: 'id_card', relatedEntity: 'BORROWER', relatedId: customer.id });
      expect(rows[2]!.beforeJson).toMatchObject({ documentId: added.document!.id, checklistKey: 'id_card' });
      const dump = JSON.stringify(rows);
      for (const secret of ['Бат-Эрдэн', 'УБ90000001', '.pdf', 'үнэмлэх']) expect(dump).not.toContain(secret);
    });

    it('лог-д тайлбар, файлын нэр, регистр, OCR-ийн текст гарахгүй', async () => {
      const out: string[] = [];
      for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => void out.push(JSON.stringify(args)));
      const { app } = await scenario();
      const customer = await createCustomer(t.prisma, { registerNo: 'УБ90000001' });
      await createBorrower(t.prisma, app.id, customer.id, 'PRIMARY');
      const fileId = dms.addFile(ORG, { name: 'Бат-Эрдэнэ-үнэмлэх.pdf' });
      const added = await attachOk(app.id, { fileId, checklistKey: 'id_card', note: 'Бат-Эрдэнийн УБ90000001' });
      dms.setOcr(added.document!.id, readableOcr(added.document!.id, { registerNo: 'УБ90000001' }));
      expect((await ocr(app.id, added.document!.id)).status).toBe(200);
      dms.failNext('create', new UpstreamError('dms', 500, 'dms алдаа буцаалаа (500)', 502));
      await attach(app.id, { fileId, checklistKey: 'salary_statement', note: 'Бат-Эрдэнийн УБ90000001' });
      const dump = out.join('\n');
      for (const secret of ['Бат-Эрдэн', 'УБ90000001', '.pdf']) expect(dump).not.toContain(secret);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('DocumentUploaded / DocumentRemoved subscriber (алхмын нөөц)', () => {
    const fire = (type: 'DocumentUploaded' | 'DocumentRemoved', over: { applicationId?: string | null; orgId?: string } = {}) => {
      const ctx = { orgId: over.orgId ?? ORG, userId: 'officer-1', correlationId: 'corr-evt' };
      const applicationId = over.applicationId === undefined ? null : over.applicationId;
      const event = type === 'DocumentUploaded'
        ? buildEvent(ctx, 'DocumentUploaded', { documentId: 'd', applicationId, kind: 'a', checklistKey: 'a', relatedEntity: 'APPLICATION', relatedId: null, fileId: 'f' })
        : buildEvent(ctx, 'DocumentRemoved', { documentId: 'd', applicationId, kind: 'a', checklistKey: 'a' });
      return { event, publish: () => t.bus.publish(event) };
    };
    const oneKey = [{ key: 'a', name: 'A', required: true }];

    it('dms-д шууд орсон баримт → event ирэхэд алхам COMPLETED; баримт устахад PENDING', async () => {
      const { app } = await scenario({ checklist: oneKey });
      const doc = await dms.insertDirect(ORG, { applicationId: app.id, type: 'a', checklistKey: 'a', relatedEntity: 'APPLICATION', fileId: file() });
      await fire('DocumentUploaded', { applicationId: app.id }).publish();
      const done = await step(app.id);
      expect([done.status, done.completedAt?.toISOString()]).toEqual(['COMPLETED', NOW]);
      dms.removeDirect(ORG, doc.id);
      await fire('DocumentRemoved', { applicationId: app.id }).publish();
      expect((await step(app.id)).status).toBe('PENDING');
    });

    it('dms-ийг үйлчилгээний хэрэглэгчээр (унших эрхтэй) дууддаг — event-д хэрэглэгч байхгүй', async () => {
      const { app } = await scenario({ checklist: oneKey });
      await fire('DocumentUploaded', { applicationId: app.id }).publish();
      const call = dms.callsOf('list')[0]!;
      expect(call.ctx).toMatchObject({ userId: SERVICE_PRINCIPAL.userId, roles: ['ADMIN'], orgId: ORG, correlationId: 'corr-evt' });
    });

    it('давхар хүргэлт (ижил eventId) нэг л удаа боловсруулагдана — dms-д дахин хандахгүй', async () => {
      const { app } = await scenario({ checklist: oneKey });
      const { event, publish } = fire('DocumentUploaded', { applicationId: app.id });
      await publish();
      const lists = dms.listCalls;
      expect(lists).toBeGreaterThan(0);
      await t.bus.publish(event);
      await t.bus.publish({ ...event });
      expect(dms.listCalls).toBe(lists);
      expect(await t.prisma.processedEvent.count({ where: { consumer: 'origination-documents', eventId: event.eventId } })).toBe(1);
    });

    it('үл мэдэгдэх хүсэлт, өөр байгууллага, applicationId=null → чимээгүй алгасна (dms-д хандахгүй)', async () => {
      const { app } = await scenario({ checklist: oneKey });
      await fire('DocumentUploaded', { applicationId: 'no-such-app' }).publish();
      await fire('DocumentUploaded', { applicationId: app.id, orgId: 'other-org' }).publish();
      await fire('DocumentRemoved', { applicationId: null }).publish();
      expect(dms.callsOf('list')).toHaveLength(0);
      expect((await step(app.id)).status).toBe('PENDING');
    });

    it('засагдахгүй төлөв (илгээсэн хүсэлт) болон LOCKED алхамд хүрэхгүй', async () => {
      const submitted = await scenario({ checklist: oneKey, status: 'SUBMITTED', steps: { document: 'COMPLETED' } });
      await dms.insertDirect(ORG, { applicationId: submitted.app.id, type: 'a', checklistKey: 'zzz', relatedEntity: 'APPLICATION', fileId: file() });
      await fire('DocumentRemoved', { applicationId: submitted.app.id }).publish();
      expect((await step(submitted.app.id)).status).toBe('COMPLETED');
      const locked = await scenario({ checklist: oneKey, steps: { document: 'LOCKED' } });
      await dms.insertDirect(ORG, { applicationId: locked.app.id, type: 'a', checklistKey: 'a', relatedEntity: 'APPLICATION', fileId: file() });
      await fire('DocumentUploaded', { applicationId: locked.app.id }).publish();
      expect((await step(locked.app.id)).status).toBe('LOCKED');
    });

    it('dms унасан бол event-ийн боловсруулалт унана (marker үлдэхгүй → bus дахин хүргэнэ), дараа нь амжина', async () => {
      const { app } = await scenario({ checklist: oneKey });
      await dms.insertDirect(ORG, { applicationId: app.id, type: 'a', checklistKey: 'a', relatedEntity: 'APPLICATION', fileId: file() });
      const { event, publish } = fire('DocumentUploaded', { applicationId: app.id });
      dms.failNext('list', new UpstreamError('dms', null, 'холбогдож чадсангүй', 502));
      await expect(publish()).rejects.toThrow();
      expect(await t.prisma.processedEvent.count({ where: { eventId: event.eventId } })).toBe(0);
      await t.bus.publish(event);
      expect((await step(app.id)).status).toBe('COMPLETED');
    });

    it('event-ийн схем: DocumentUploaded/DocumentRemoved нэмэлт талбартай parse хийгдэнэ', () => {
      expect(DocumentUploaded.parse(fire('DocumentUploaded', { applicationId: 'x' }).event).checklistKey).toBe('a');
      expect(DocumentRemoved.parse(fire('DocumentRemoved', { applicationId: 'x' }).event).kind).toBe('a');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('OCR тулгалт (POST …/documents/:docId/ocr)', () => {
    async function idCardScenario(o: { primaryRegister?: string; status?: string } = {}) {
      const { app } = await scenario({ status: o.status });
      const primary = await createCustomer(t.prisma, { registerNo: o.primaryRegister ?? 'УБ90000001' });
      await createBorrower(t.prisma, app.id, primary.id, 'PRIMARY');
      return { app, primary };
    }
    const idDoc = (appId: string, extra: Record<string, unknown> = {}) => attachOk(appId, { checklistKey: 'id_card', ...extra });

    it('ҮНДСЭН зээлдэгчийн регистртэй таарвал MATCH — далдлагдсан регистр, итгэл, checkedAt; хадгалагдахгүй; no-store', async () => {
      const { app } = await idCardScenario();
      const doc = (await idDoc(app.id)).document!;
      dms.setOcr(doc.id, readableOcr(doc.id, { registerNo: 'УБ90000001', registerConfidence: 0.91, warnings: ['expiryDate: үнэмлэхний хүчинтэй хугацаа дууссан байна'] }));
      const auditBefore = await t.prisma.auditLog.count();
      const res = await ocr(app.id, doc.id);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const check = DocumentOcrCheck.parse(res.body);
      expect(check).toEqual({ documentId: doc.id, verdict: 'MATCH', docType: 'ID_CARD', registerMasked: 'УБ****0001', confidence: 0.91, warnings: ['expiryDate: үнэмлэхний хүчинтэй хугацаа дууссан байна'], checkedAt: NOW });
      expect(JSON.stringify(res.body)).not.toContain('УБ90000001');
      expect(await t.prisma.auditLog.count()).toBe(auditBefore); // юу ч хадгалагдаагүй
      expect(dms.all()).toHaveLength(1);
    });

    it('хоосон зай, жижиг үсэг, таслалтай бичсэн ч MATCH (normalizeRegisterNo)', async () => {
      const { app } = await idCardScenario();
      const doc = (await idDoc(app.id)).document!;
      dms.setOcr(doc.id, readableOcr(doc.id, { registerNo: ' уб 9000-0001 ' }));
      expect(DocumentOcrCheck.parse((await ocr(app.id, doc.id)).body).verdict).toBe('MATCH');
    });

    it('өөр регистр → MISMATCH (зөвлөмж анхааруулгатай, OCR-ийн регистрийг л далдлан харуулна)', async () => {
      const { app } = await idCardScenario();
      const doc = (await idDoc(app.id)).document!;
      dms.setOcr(doc.id, readableOcr(doc.id, { registerNo: 'ЖЮ85061512' }));
      const check = DocumentOcrCheck.parse((await ocr(app.id, doc.id)).body);
      expect(check.verdict).toBe('MISMATCH');
      expect(check.registerMasked).toBe('ЖЮ****1512');
      expect(check.warnings.join(' ')).toMatch(/таарахгүй/);
      expect(JSON.stringify(check)).not.toMatch(/90000001|85061512/);
    });

    it('баримт BORROWER-т холбогдсон бол ТЭР зээлдэгчтэй тулгана (үндсэнтэй биш)', async () => {
      const { app } = await idCardScenario();
      const guarantor = await createCustomer(t.prisma, { registerNo: 'ЖЮ85061512' });
      await createBorrower(t.prisma, app.id, guarantor.id, 'GUARANTOR');
      const forGuarantor = (await idDoc(app.id, { relatedEntity: 'BORROWER', relatedId: guarantor.id })).document!;
      const appLevel = (await idDoc(app.id)).document!;
      for (const id of [forGuarantor.id, appLevel.id]) dms.setOcr(id, readableOcr(id, { registerNo: 'ЖЮ85061512' }));
      expect(DocumentOcrCheck.parse((await ocr(app.id, forGuarantor.id)).body).verdict).toBe('MATCH');
      expect(DocumentOcrCheck.parse((await ocr(app.id, appLevel.id)).body).verdict).toBe('MISMATCH'); // хүсэлтийн түвшин → үндсэн зээлдэгч
    });

    it('регистр уншигдаагүй / файл уншигдахгүй → UNREADABLE (алдаа биш), шалтгаан монголоор', async () => {
      const { app } = await idCardScenario();
      const doc = (await idDoc(app.id)).document!;
      dms.setOcr(doc.id, readableOcr(doc.id, { registerNo: null, registerConfidence: null }));
      const noReg = DocumentOcrCheck.parse((await ocr(app.id, doc.id)).body);
      expect(noReg).toMatchObject({ verdict: 'UNREADABLE', registerMasked: null, confidence: null });
      expect(noReg.warnings.join(' ')).toMatch(/регистр/);
      dms.setOcr(doc.id, { readable: false, reason: 'UNSUPPORTED_FILE' });
      const bad = DocumentOcrCheck.parse((await ocr(app.id, doc.id)).body);
      expect(bad).toMatchObject({ verdict: 'UNREADABLE', docType: null, registerMasked: null });
      expect(bad.warnings).toHaveLength(1);
      dms.setOcr(doc.id, { readable: false, reason: 'NO_TEXT' }); // mock-д fixture байхгүй
      expect(DocumentOcrCheck.parse((await ocr(app.id, doc.id)).body).verdict).toBe('UNREADABLE');
    });

    it('id_card биш баримт → NOT_APPLICABLE (dms OCR дуудагдахгүй); extras ч мөн', async () => {
      const { app } = await idCardScenario();
      const salary = (await attachOk(app.id, { checklistKey: 'salary_statement' })).document!;
      const other = (await attachOk(app.id, { type: 'other' })).document!;
      for (const doc of [salary, other]) {
        const check = DocumentOcrCheck.parse((await ocr(app.id, doc.id)).body);
        expect(check).toEqual({ documentId: doc.id, verdict: 'NOT_APPLICABLE', docType: null, registerMasked: null, confidence: null, warnings: [], checkedAt: NOW });
      }
      expect(dms.callsOf('ocr')).toHaveLength(0);
    });

    it('үндсэн зээлдэгчгүй (хүсэлтийн түвшний баримт) → 422 PRIMARY_BORROWER_MISSING; холбогдсон зээлдэгч хасагдсан → 422 BORROWER_NOT_ON_APPLICATION', async () => {
      const { app } = await scenario();
      const doc = (await idDoc(app.id)).document!;
      let res = await ocr(app.id, doc.id);
      expect([res.status, res.body.code]).toEqual([422, 'PRIMARY_BORROWER_MISSING']);

      const guarantor = await createCustomer(t.prisma);
      const link = await createBorrower(t.prisma, app.id, guarantor.id, 'GUARANTOR');
      const forGuarantor = (await idDoc(app.id, { relatedEntity: 'BORROWER', relatedId: guarantor.id })).document!;
      await t.prisma.loanApplicationBorrower.delete({ where: { id: link.id } });
      res = await ocr(app.id, forGuarantor.id);
      expect([res.status, res.body.code]).toEqual([422, 'BORROWER_NOT_ON_APPLICATION']);
      expect(dms.callsOf('ocr')).toHaveLength(0);
    });

    it('баримт олдохгүй / өөр хүсэлтийнх → 404 DOCUMENT_NOT_FOUND', async () => {
      const { app } = await idCardScenario();
      const other = await createApplication(t.prisma);
      const foreign = await dms.insertDirect(ORG, { applicationId: other.id, type: 'id_card', checklistKey: 'id_card', relatedEntity: 'APPLICATION', fileId: file() });
      for (const id of ['nope', foreign.id]) {
        const res = await ocr(app.id, id);
        expect([res.status, res.body.code]).toEqual([404, 'DOCUMENT_NOT_FOUND']);
      }
    });

    it('эрх: өөр ЗЭЗ, салбарын захирал, батлагч → 403; өөрийн ЗЭЗ, ADMIN → 200; илгээсэн хүсэлтэд ч ажиллана (юу ч өөрчлөхгүй)', async () => {
      const { app } = await idCardScenario();
      const doc = (await idDoc(app.id)).document!;
      dms.setOcr(doc.id, readableOcr(doc.id));
      for (const actor of [actors.officer('officer-2'), actors.branchManager('bm', 'branch-1'), actors.approver()]) expect((await ocr(app.id, doc.id, actor)).status).toBe(403);
      expect((await ocr(app.id, doc.id, actors.admin())).status).toBe(200);
      await t.prisma.loanApplication.update({ where: { id: app.id }, data: { status: 'SUBMITTED' } });
      expect((await ocr(app.id, doc.id)).status).toBe(200);
    });

    it('dms OCR унасан/завгүй бол алдаа дамжина (дүгнэлт биш): 504, 429', async () => {
      const { app } = await idCardScenario();
      const doc = (await idDoc(app.id)).document!;
      dms.failNext('ocr', new UpstreamError('dms', null, 'dms хариу өгсөнгүй (timeout)', 504));
      expect((await ocr(app.id, doc.id)).status).toBe(504);
      dms.failNext('ocr', new DomainError('OCR_BUSY', 'OCR түр завгүй байна, дахин оролдоно уу', 429));
      const busy = await ocr(app.id, doc.id);
      expect([busy.status, busy.body.code]).toEqual([429, 'OCR_BUSY']);
      expect((await ocr(app.id, doc.id)).status).toBe(200); // алдаа нэг удаа; дараагийн дуудлага хэвийн
    });
  });
});
