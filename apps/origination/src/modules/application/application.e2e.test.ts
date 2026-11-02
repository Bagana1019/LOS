import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { ApplicationDetail, ApplicationListResponse, ApplicationStatusChanged, ApplicationSubmitted, StepKey } from '@los/contracts';
import { createTestApp, TestApp } from '../../test-utils/test-app';
import { actors, BRANCH, hasTestDb, ORG, resetDb } from '../../test-utils/factories';
import { ApplicationStateMachine } from './application-state-machine';
import { ApplicationModule } from './application.module';

// Модуль 2 AC: шинэ хүсэлт → Шинэ таб; 12 алхам LOCKED/PENDING; DRAFT→APPROVED 400; ЗЭЗ А ЗЭЗ Б-ийн хүсэлтийг харахгүй (403); 2-р үе шат цоожтой.
describe.skipIf(!hasTestDb)('application API (DB)', () => {
  let t: TestApp;
  let baseUrl: string;
  const officerA = actors.officer('officer-a');
  const officerB = actors.officer('officer-b');
  beforeAll(async () => {
    t = await createTestApp([ApplicationModule]);
    await t.app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => { await t.close(); });
  beforeEach(async () => { await resetDb(t.prisma); });

  const http = () => request(baseUrl);
  async function create(actor: Record<string, string> = officerA, body: Record<string, unknown> = {}) {
    const res = await http().post('/api/applications').set(actor).send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return ApplicationDetail.parse(res.body);
  }
  const completeSteps = (appId: string, keys: readonly string[]) => t.prisma.loanApplicationStep.updateMany({ where: { applicationId: appId, stepKey: { in: [...keys] } }, data: { status: 'COMPLETED', completedAt: new Date() } });
  const REQUIRED = ['client', 'inquiry', 'income', 'loan', 'collateral', 'installment', 'score'];
  async function product() {
    return t.prisma.product.create({ data: { orgId: ORG, code: 'P1', name: 'Хэрэглээний', productType: 'CONSUMER', minAmount: 100_000, maxAmount: 50_000_000, minTerm: 1, maxTerm: 36, minRate: 10, maxRate: 40 } });
  }

  it('шинэ хүсэлт: DRAFT, ЗЭЗ+салбар, 12 алхам (1-р үе шат PENDING, 2-р үе шат LOCKED), Шинэ табд', async () => {
    const app = await create();
    expect(app.status).toBe('DRAFT');
    expect(app.appNo).toMatch(/^LA-\d{4}-\d{6}$/);
    expect(app.officerId).toBe('officer-a');
    expect(app.branchId).toBe(BRANCH);
    expect(app.steps.map((s) => s.stepKey)).toEqual([...StepKey].sort((a, b) => app.steps.findIndex((s) => s.stepKey === a) - app.steps.findIndex((s) => s.stepKey === b)));
    expect(app.steps).toHaveLength(12);
    expect(app.steps.filter((s) => s.status === 'PENDING')).toHaveLength(9);
    expect(app.steps.filter((s) => s.status === 'LOCKED').map((s) => s.stepKey)).toEqual(['contract', 'official_documents', 'disburse']);
    expect(app.stage1Completed).toBe(0);
    expect(app.stage1Total).toBe(9);
    expect(app.editable).toBe(true);
    const list = ApplicationListResponse.parse((await http().get('/api/applications?status=DRAFT').set(officerA)).body);
    expect(list.items.map((i) => i.id)).toEqual([app.id]);
    expect(list.counts.DRAFT).toBe(1);
    expect(list.counts.SUBMITTED).toBe(0);
    const audit = await t.prisma.auditLog.findMany({ where: { applicationId: app.id } });
    expect(audit.map((a) => a.action)).toEqual(['APPLICATION_CREATED']);
  });

  it('хүсэлтийн дугаар зэрэгцээ үүсгэхэд давхцахгүй', async () => {
    const apps = await Promise.all(Array.from({ length: 8 }, () => create()));
    expect(new Set(apps.map((a) => a.appNo)).size).toBe(8);
  });

  it('бүтээгдэхүүн заавал биш; идэвхгүй/олдохгүй бол 422; валют бүтээгдэхүүнээс', async () => {
    const p = await product();
    expect((await create(officerA, { productId: p.id })).productName).toBe('Хэрэглээний');
    const bad = await http().post('/api/applications').set(officerA).send({ productId: '00000000-0000-0000-0000-000000000000' });
    expect(bad.status).toBe(422);
  });

  it('эрх: ЗЭЗ А ЗЭЗ Б-ийн хүсэлтийг харахгүй (403), жагсаалтад ч гарахгүй', async () => {
    const a = await create(officerA);
    expect((await http().get(`/api/applications/${a.id}`).set(officerB)).status).toBe(403);
    expect((await http().get(`/api/applications/${a.id}/history`).set(officerB)).status).toBe(403);
    expect((await http().post(`/api/applications/${a.id}/transition`).set(officerB).send({ to: 'SUBMITTED' })).status).toBe(403);
    const list = ApplicationListResponse.parse((await http().get('/api/applications').set(officerB)).body);
    expect(list.total).toBe(0);
    expect(list.counts.DRAFT).toBe(0);
    // officerId шүүлтээр хүрээг давж болохгүй
    expect(ApplicationListResponse.parse((await http().get('/api/applications?officerId=officer-a').set(officerB)).body).total).toBe(0);
  });

  it('эрх: салбарын захирал өөрийн салбарыг, батлагч/админ бүгдийг уншина; бичихгүй; харилцагч дүр хориотой', async () => {
    const a = await create(officerA);
    expect((await http().get(`/api/applications/${a.id}`).set(actors.branchManager())).status).toBe(200);
    expect((await http().get(`/api/applications/${a.id}`).set(actors.branchManager('bm-2', 'branch-2'))).status).toBe(403);
    expect((await http().get(`/api/applications/${a.id}`).set(actors.approver())).status).toBe(200);
    expect((await http().get('/api/applications').set(actors.admin())).body.total).toBe(1);
    expect((await http().post('/api/applications').set(actors.branchManager()).send({})).status).toBe(403);
    expect((await http().post('/api/applications').set(actors.approver()).send({})).status).toBe(403);
    expect((await http().get('/api/applications').set(actors.customer('c1'))).status).toBe(403);
    expect((await http().post(`/api/applications/${a.id}/transition`).set(actors.approver()).send({ to: 'SUBMITTED' })).status).toBe(403);
  });

  it('хориотой шилжилт: DRAFT→APPROVED 400; системийн шилжилтийг ЗЭЗ хийж чадахгүй', async () => {
    const a = await create();
    const res = await http().post(`/api/applications/${a.id}/transition`).set(officerA).send({ to: 'APPROVED' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_TRANSITION');
    const row = await t.prisma.loanApplication.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.status).toBe('DRAFT');
    // IN_APPROVAL → APPROVED бол хүснэгтэд байгаа боловч HTTP-ээр хийж болохгүй
    await t.prisma.loanApplication.update({ where: { id: a.id }, data: { status: 'IN_APPROVAL' } });
    const sys = await http().post(`/api/applications/${a.id}/transition`).set(officerA).send({ to: 'APPROVED' });
    expect(sys.status).toBe(403);
    expect(sys.body.code).toBe('TRANSITION_NOT_ALLOWED');
  });

  it('илгээх (G1): заавал алхам дутуу бол 422 + дутуу жагсаалт; бүрдвэл SUBMITTED, audit, 2 event', async () => {
    const p = await product();
    const a = await create(officerA, { productId: p.id });
    await completeSteps(a.id, REQUIRED.slice(0, 5));
    const blocked = await http().post(`/api/applications/${a.id}/transition`).set(officerA).send({ to: 'SUBMITTED' });
    expect(blocked.status).toBe(422);
    expect(blocked.body.code).toBe('STEPS_INCOMPLETE');
    expect(blocked.body.details.missing).toEqual(['installment', 'score']);
    const detail = ApplicationDetail.parse((await http().get(`/api/applications/${a.id}`).set(officerA)).body);
    expect(detail.transitions).toEqual([{ to: 'SUBMITTED', allowed: true, blockedBy: ['installment', 'score'] }]);

    await completeSteps(a.id, REQUIRED);
    await t.prisma.loanApplication.update({ where: { id: a.id }, data: { amount: 5_000_000 } });
    const ok = await http().post(`/api/applications/${a.id}/transition`).set(officerA).send({ to: 'SUBMITTED' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const submitted = ApplicationDetail.parse(ok.body);
    expect(submitted.status).toBe('SUBMITTED');
    expect(submitted.submittedAt).not.toBeNull();
    expect(submitted.editable).toBe(false);
    expect(submitted.transitions).toEqual([{ to: 'IN_APPROVAL', allowed: false, blockedBy: [] }]); // системийн шилжилт
    // давхар илгээх → 400
    expect((await http().post(`/api/applications/${a.id}/transition`).set(officerA).send({ to: 'SUBMITTED' })).status).toBe(400);

    const hist = (await http().get(`/api/applications/${a.id}/history`).set(officerA)).body.items;
    expect(hist.map((h: { to: string }) => h.to)).toEqual(['DRAFT', 'SUBMITTED']);
    const outbox = await t.prisma.outbox.findMany({ orderBy: { createdAt: 'asc' } });
    const changed = outbox.filter((o) => o.type === 'ApplicationStatusChanged').map((o) => ApplicationStatusChanged.parse(o.payload));
    expect(changed).toMatchObject([{ applicationId: a.id, from: 'DRAFT', to: 'SUBMITTED' }]);
    const sub = outbox.filter((o) => o.type === 'ApplicationSubmitted').map((o) => ApplicationSubmitted.parse(o.payload));
    expect(sub).toMatchObject([{ applicationId: a.id, amount: 5_000_000, productId: p.id }]);
  });

  it('илгээх: бүтээгдэхүүн/дүн байхгүй бол 422 LOAN_TERMS_MISSING', async () => {
    const a = await create();
    await completeSteps(a.id, REQUIRED);
    const res = await http().post(`/api/applications/${a.id}/transition`).set(officerA).send({ to: 'SUBMITTED' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('LOAN_TERMS_MISSING');
  });

  it('системийн шилжилт: IN_APPROVAL→APPROVED үед 2-р үе шат нээгдэнэ; RETURNED→дахин илгээхэд version+1', async () => {
    const p = await product();
    const a = await create(officerA, { productId: p.id });
    await completeSteps(a.id, REQUIRED);
    await t.prisma.loanApplication.update({ where: { id: a.id }, data: { amount: 1_000_000 } });
    await http().post(`/api/applications/${a.id}/transition`).set(officerA).send({ to: 'SUBMITTED' }).expect(200);
    const machine = t.app.get(ApplicationStateMachine);
    const ctx = { orgId: ORG, userId: 'approver-1', roles: ['APPROVER'], branchId: null, customerId: null, correlationId: 'c1' } as never;
    const run = (to: string) => t.prisma.$transaction((tx) => machine.apply(tx, ctx, a.id, to as never, { via: 'SYSTEM' }));
    await run('IN_APPROVAL');
    await run('RETURNED');
    const stage2 = () => t.prisma.loanApplicationStep.findMany({ where: { applicationId: a.id, stepKey: { in: ['contract', 'official_documents', 'disburse'] } } });
    expect((await stage2()).every((s) => s.status === 'LOCKED')).toBe(true);
    const re = ApplicationDetail.parse((await http().post(`/api/applications/${a.id}/transition`).set(officerA).send({ to: 'SUBMITTED' })).body);
    expect(re.version).toBe(2);
    expect(re.returnedAt).toBeNull();
    await run('IN_APPROVAL');
    await run('APPROVED');
    expect((await stage2()).every((s) => s.status === 'PENDING')).toBe(true);
    await expect(run('DRAFT')).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    const row = await t.prisma.loanApplication.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.status).toBe('APPROVED');
    expect(row.approvedAt).not.toBeNull();
  });

  it('жагсаалт: шүүлт, эрэмбэ, хуудаслалт, хайлт; буруу pageSize 400', async () => {
    const apps = [];
    for (let i = 0; i < 3; i++) apps.push(await create());
    await t.prisma.loanApplication.update({ where: { id: apps[1].id }, data: { status: 'RETURNED', contractNo: 'B10026ABC' } });
    const get = async (qs: string) => ApplicationListResponse.parse((await http().get(`/api/applications${qs}`).set(officerA)).body);
    expect((await get('?status=RETURNED')).items.map((i) => i.id)).toEqual([apps[1].id]);
    expect((await get('?q=b10026')).items.map((i) => i.id)).toEqual([apps[1].id]);
    expect((await get(`?q=${apps[2].appNo}`)).items.map((i) => i.id)).toEqual([apps[2].id]);
    const p1 = await get('?pageSize=10&sort=appNo&dir=asc&page=1');
    expect(p1.items.map((i) => i.appNo)).toEqual(apps.map((a) => a.appNo).sort());
    expect(p1.total).toBe(3);
    const p2 = await get('?pageSize=10&page=2');
    expect(p2.items).toHaveLength(0);
    expect((await get('')).counts).toMatchObject({ DRAFT: 2, RETURNED: 1 });
    expect((await http().get('/api/applications?pageSize=7').set(officerA)).status).toBe(400);
    expect((await http().get('/api/applications?currency=XXXX').set(officerA)).status).toBe(400);
  });

  it('Excel экспорт (FR-1.3): xlsx буцаана, хүрээнд хязгаарлагдана', async () => {
    await create(officerA);
    await create(officerB);
    const res = await http().get('/api/applications/export').set(officerA).buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as Buffer);
    expect(wb.worksheets[0].rowCount).toBe(2); // толгой + ЗЭЗ А-н 1 хүсэлт
  });
});
