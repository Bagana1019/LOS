import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { ContractView, DisbursementView, OfficialLetterView } from '@los/contracts';
import { createTestApp, type TestApp } from '../../test-utils/test-app';
import { actors, createApplication, createBorrower, createCustomer, createSchedule, hasTestDb, ORG, resetDb } from '../../test-utils/factories';
import { CORE_LOAN_PORT } from '../../integrations/core-loan/core-loan.provider';
import { CORE_CALL_TIMEOUT_MS, CoreLoanError, type CoreLoanPort } from '../../integrations/core-loan/core-loan.port';
import { MockCoreLoanPort } from '../../integrations/core-loan/core-loan.mock';
import { ApplicationModule } from '../application/application.module';
import { ContractModule } from '../contract/contract.module';
import { DMS_DOCGEN } from '../contract/dms-docgen.port';
import { FakeDmsDocgen } from '../contract/testing/fake-dms-docgen';
import { ErpSyncService } from '../erp-sync/erp-sync.service';
import { DisbursementModule } from './disbursement.module';
import { CORE_LEASE_MS, DisbursementService } from './disbursement.service';

// Модуль 11 AC: гэрээнд нэр/дүн/ЭТХ орно; олгох дүн > батлагдсан → 400; гарын үсэггүй → илгээх идэвхгүй; зөвшөөрөхөд ACTIVE + core_loan_id хадгалагдана.
describe.skipIf(!hasTestDb)('contract + disbursement (M11, DB)', () => {
  let t: TestApp;
  let baseUrl: string;
  const dms = new FakeDmsDocgen();
  let core: CoreLoanPort = new MockCoreLoanPort();
  let mock = core as MockCoreLoanPort;
  const officer = actors.officer('officer-1');
  const approver = actors.approver('approver-1');

  beforeAll(async () => {
    t = await createTestApp([ApplicationModule, ContractModule, DisbursementModule], (b) => b.overrideProvider(DMS_DOCGEN).useValue(dms).overrideProvider(CORE_LOAN_PORT).useFactory({ factory: () => ({ get mode() { return core.mode; }, openLoan: (r: never) => core.openLoan(r), findLoan: (k: string) => core.findLoan(k) }) }));
    await t.app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => { await t.close(); });
  beforeEach(async () => { await resetDb(t.prisma); dms.renders.length = 0; dms.files.clear(); mock = new MockCoreLoanPort(); core = mock; vi.restoreAllMocks(); });

  const http = () => request(baseUrl);
  const base = (id: string) => `/api/applications/${id}`;

  async function approvedApp(o: { requiresCollateral?: boolean; registryNo?: string | null; productCode?: string; contractNo?: string } = {}) {
    const product = await t.prisma.product.create({ data: { orgId: ORG, code: o.productCode ?? 'P1', name: 'Хэрэглээний', productType: 'CONSUMER', minAmount: 100_000, maxAmount: 50_000_000, minTerm: 1, maxTerm: 36, minRate: 10, maxRate: 40, requiresCollateral: o.requiresCollateral ?? true } });
    const customer = await createCustomer(t.prisma, { firstName: 'Дорж', lastName: 'Бат-Эрдэнэ' });
    const app = await createApplication(t.prisma, { status: 'APPROVED', productId: product.id, contractNo: o.contractNo ?? 'C-2026-0001', amount: 30_000_000, interestRate: 24, termMonths: 12 });
    await createBorrower(t.prisma, app.id, customer.id);
    const sched = await createSchedule(t.prisma, app.id, { principal: 30_000_000, rate: 24, months: 12, firstDue: '2026-12-05' });
    await t.prisma.repaymentSchedule.update({ where: { id: sched.id }, data: { paramsJson: { type: 'ANNUITY', firstPaymentDate: '2026-12-05', principal: 30_000_000, termMonths: 12, annualRate: 24 } } });
    await t.prisma.decisionRecord.create({ data: { orgId: ORG, applicationId: app.id, decisionNo: `D-${app.id}`, decidedAt: new Date() } });
    if (o.requiresCollateral !== false) await t.prisma.collateral.create({ data: { orgId: ORG, applicationId: app.id, kind: 'REAL_ESTATE', assetType: 'APARTMENT', collateralValue: 60_000_000, registryNo: o.registryNo === undefined ? 'ЭБ-100' : o.registryNo } });
    return app;
  }
  async function ready(appId: string, account = { bankCode: 'KHAN', accountNo: '5012345670', holderName: 'Бат-Эрдэнэ Дорж' }) {
    expect((await http().post(`${base(appId)}/contract/generate`).set(officer)).status).toBe(200);
    const scan = [...dms.files][0]!; // dms-д байгаа файл
    expect((await http().post(`${base(appId)}/contract/signed`).set(officer).send({ fileId: scan })).status).toBe(200);
    expect((await http().post(`${base(appId)}/contract/official-letters`).set(officer).send({})).status).toBe(201);
    const put = await http().put(`${base(appId)}/disbursement`).set(officer).send({ ...account, disburseDate: '2026-11-05', accountOwnerType: 'SELF' });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    return DisbursementView.parse(put.body);
  }

  it('гэрээ: загварт зээлдэгчийн нэр, дүн, ЭТХ-ийн 12 мөр орно; contract мөр үүснэ', async () => {
    const app = await approvedApp();
    const res = await http().post(`${base(app.id)}/contract/generate`).set(officer);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const c = ContractView.parse(res.body);
    expect(c.contractNo).toBe('C-2026-0001');
    expect(c.generatedFileId).toBeTruthy();
    const data = dms.renders[0]!.data as Record<string, unknown>;
    expect(dms.renders[0]!.type).toBe('LOAN_CONTRACT');
    expect(data.borrower_name).toBe('Бат-Эрдэнэ Дорж');
    expect(data.approved_amount).toBe('30,000,000');
    expect(data.contract_no).toBe('C-2026-0001');
    expect((data.schedule as unknown[]).length).toBe(12);
    expect(data.collateral_summary).toContain('APARTMENT');
  });

  it('гэрээ: батлагдаагүй хүсэлтэд 409; өөр ЗЭЗ-д 403', async () => {
    const draft = await createApplication(t.prisma, { status: 'IN_APPROVAL' });
    expect((await http().post(`${base(draft.id)}/contract/generate`).set(officer)).status).toBe(409);
    const app = await approvedApp();
    expect((await http().post(`${base(app.id)}/contract/generate`).set(actors.officer('officer-2'))).status).toBe(403);
  });

  it('олгох дүн > батлагдсан → 400 DISBURSE_EXCEEDS_APPROVED (BR-10)', async () => {
    const app = await approvedApp();
    const res = await http().put(`${base(app.id)}/disbursement`).set(officer).send({ disburseAmount: 30_000_001 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('DISBURSE_EXCEEDS_APPROVED');
    expect(await t.prisma.disbursementRequest.count()).toBe(0);
  });

  it('гарын үсэггүй → илгээх идэвхгүй (canSubmit=false) ба submit 422', async () => {
    const app = await approvedApp();
    const view = DisbursementView.parse((await http().put(`${base(app.id)}/disbursement`).set(officer).send({ bankCode: 'KHAN', accountNo: '5012345670', holderName: 'Бат-Эрдэнэ Дорж', disburseDate: '2026-11-05' })).body);
    expect(view.canSubmit).toBe(false);
    expect(view.checks.find((c) => c.key === 'CONTRACT_SIGNED')!.ok).toBe(false);
    expect(view.nameCheck?.matched).toBe(true);
    expect(view.accountNoMasked).toBe('******5670');
    const res = await http().post(`${base(app.id)}/disbursement/submit`).set(officer);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('DISBURSEMENT_GATE_FAILED');
    expect((await t.prisma.loanApplication.findUniqueOrThrow({ where: { id: app.id } })).status).toBe('APPROVED');
  });

  it('данс-нэрийн тулгалт таараагүй бол илгээхгүй; барьцаа ЭБ-д бүртгэлгүй бол илгээхгүй', async () => {
    const app = await approvedApp({ registryNo: null });
    const v = await ready(app.id, { bankCode: 'KHAN', accountNo: '5012345671', holderName: 'Бат-Эрдэнэ Дорж' }); // ...1 = Сарангэрэл Болд
    expect(v.nameCheck?.matched).toBe(false);
    const failed = (await http().post(`${base(app.id)}/disbursement/submit`).set(officer)).body.details.failed.map((c: { key: string }) => c.key);
    expect(failed).toEqual(expect.arrayContaining(['ACCOUNT_NAME_CHECK', 'COLLATERAL_REGISTERED']));
  });

  it('бүтэн урсгал: илгээх → зөвшөөрөх → Core → ACTIVE, core_loan_id, event, ERP, түүх', async () => {
    const app = await approvedApp();
    const v = await ready(app.id);
    expect(v.canSubmit).toBe(true);
    expect(v.reconciliation).toEqual({ ok: true, diffs: [] });

    const sub = DisbursementView.parse((await http().post(`${base(app.id)}/disbursement/submit`).set(officer)).body);
    expect(sub.status).toBe('SUBMITTED');
    expect((await t.prisma.loanApplication.findUniqueOrThrow({ where: { id: app.id } })).status).toBe('DISBURSING');
    // засах боломжгүй
    expect((await http().put(`${base(app.id)}/disbursement`).set(officer).send({ disburseAmount: 1_000_000 })).status).toBe(409);
    // ЗЭЗ зөвшөөрөх эрхгүй
    expect((await http().post(`${base(app.id)}/disbursement/approve`).set(officer).send({})).status).toBe(403);

    const ok = await http().post(`${base(app.id)}/disbursement/approve`).set(approver).send({ comment: 'ok' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const done = DisbursementView.parse(ok.body);
    expect(done.status).toBe('SENT_TO_CORE');
    expect(done.coreLoanId).toMatch(/^CL-/);
    const row = await t.prisma.loanApplication.findUniqueOrThrow({ where: { id: app.id } });
    expect(row.status).toBe('ACTIVE');
    expect(row.disbursedAt).not.toBeNull();
    const disb = await t.prisma.disbursementRequest.findUniqueOrThrow({ where: { applicationId: app.id } });
    expect(disb.coreLoanId).toBe(done.coreLoanId);
    expect(disb.accountNoEncrypted).not.toContain('5012345670'); // шифрлэгдсэн
    expect(done.history.map((h) => h.action)).toEqual(['DRAFT_UPDATED', 'SUBMITTED', 'APPROVED', 'SENT_TO_CORE']);
    expect(await t.prisma.erpEvent.count({ where: { applicationId: app.id, eventType: 'DISBURSEMENT' } })).toBe(1);
    await t.app.get(await import('../../test-utils/test-app').then((m) => m.OutboxRelayService)).relayOnce();
    expect(t.bus.published.some((e) => e.type === 'DisbursementApproved' && (e as { coreLoanId: string | null }).coreLoanId === done.coreLoanId)).toBe(true);
    // давтан зөвшөөрөх боломжгүй
    expect((await http().post(`${base(app.id)}/disbursement/approve`).set(approver).send({})).status).toBe(409);
  });

  it('Core унавал (үр дүн тодорхойгүй) APPROVED хэвээр, lease хадгалагдана (H1) — FAILED биш; lease дууссаны дараа дахин оролдож болно', async () => {
    const app = await approvedApp();
    await ready(app.id);
    await http().post(`${base(app.id)}/disbursement/submit`).set(officer);
    core = { mode: 'mock', findLoan: async () => null, openLoan: async () => { throw new CoreLoanError('CORE_UNAVAILABLE', 'down'); } };
    const bad = await http().post(`${base(app.id)}/disbursement/approve`).set(approver).send({});
    expect(bad.status).toBe(502);
    expect(bad.body.code).toBe('CORE_OPEN_LOAN_FAILED');
    const row = await t.prisma.disbursementRequest.findUniqueOrThrow({ where: { applicationId: app.id } });
    expect(row.status).toBe('APPROVED');
    expect(row.coreRequestedAt).not.toBeNull();
    expect(row.coreUnknownAt).not.toBeNull();
    expect((row.historyJson as Array<{ action: string; note: string | null }>).at(-1)).toMatchObject({ action: 'CORE_UNKNOWN', note: 'CORE_UNAVAILABLE' });
    expect((await t.prisma.loanApplication.findUniqueOrThrow({ where: { id: app.id } })).status).toBe('DISBURSING');
    expect(await t.prisma.erpEvent.count({ where: { applicationId: app.id } })).toBe(0);

    core = new MockCoreLoanPort();
    expect((await http().post(`${base(app.id)}/disbursement/approve`).set(approver).send({})).body.code).toBe('DISBURSEMENT_CORE_IN_PROGRESS');
    t.clock.advanceMs(CORE_LEASE_MS + 1_000);
    const retry = await http().post(`${base(app.id)}/disbursement/approve`).set(approver).send({});
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect((await t.prisma.loanApplication.findUniqueOrThrow({ where: { id: app.id } })).status).toBe('ACTIVE');
  });

  it('батлагч буцаавал (тайлбартай) олголт DRAFT, хүсэлт APPROVED болно', async () => {
    const app = await approvedApp();
    await ready(app.id);
    await http().post(`${base(app.id)}/disbursement/submit`).set(officer);
    expect((await http().post(`${base(app.id)}/disbursement/reject`).set(approver).send({})).status).toBe(400);
    const res = await http().post(`${base(app.id)}/disbursement/reject`).set(approver).send({ comment: 'Данс буруу' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(DisbursementView.parse(res.body).status).toBe('DRAFT');
    expect((await t.prisma.loanApplication.findUniqueOrThrow({ where: { id: app.id } })).status).toBe('APPROVED');
  });

  // ── H1: Core амжилттай болсны дараах сэргээлт — Core-д давхар данс хэзээ ч нээхгүй ──
  async function submitted(contractNo = 'C-2026-0001') {
    const app = await approvedApp({ productCode: `P-${contractNo}`, contractNo });
    await ready(app.id);
    expect((await http().post(`${base(app.id)}/disbursement/submit`).set(officer)).status).toBe(200);
    return app;
  }
  const disb = (applicationId: string) => t.prisma.disbursementRequest.findUniqueOrThrow({ where: { applicationId } });
  const appStatus = async (id: string) => (await t.prisma.loanApplication.findUniqueOrThrow({ where: { id } })).status;
  const expireLease = (_applicationId: string) => { t.clock.advanceMs(CORE_LEASE_MS + 1_000); };
  /** DISBURSEMENT_CORE_SETTLE_SECONDS-ийн анхдагч (900с). */
  const SETTLE_MS = 900_000;
  async function coreOkLocalFails(appId: string) {
    vi.spyOn(t.app.get(ErpSyncService), 'emitDisbursement').mockRejectedValueOnce(new Error('db down'));
    const res = await http().post(`${base(appId)}/disbursement/approve`).set(approver).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(503);
    expect(res.body.code).toBe('DISBURSEMENT_COMPLETION_PENDING');
  }

  it('H1: Core нээгээд DB алдвал APPROVED + lease үлдэнэ; lease дуусахаас өмнө approve/reconcile/reject 409', async () => {
    const app = await submitted();
    await coreOkLocalFails(app.id);
    const row = await disb(app.id);
    expect(row.status).toBe('APPROVED');
    expect(row.coreRequestedAt).not.toBeNull();
    expect(row.coreLoanId).toBeNull();
    expect(await appStatus(app.id)).toBe('DISBURSING');
    expect(await t.prisma.erpEvent.count({ where: { applicationId: app.id } })).toBe(0);
    for (const action of ['approve', 'reconcile']) {
      const r = await http().post(`${base(app.id)}/disbursement/${action}`).set(approver).send({});
      expect(r.status, action).toBe(409);
      expect(r.body.code, action).toBe('DISBURSEMENT_CORE_IN_PROGRESS');
    }
    expect((await http().post(`${base(app.id)}/disbursement/reject`).set(approver).send({ comment: 'x' })).status).toBe(409);
    expect(mock.calls).toHaveLength(1);
  });

  it('H1: lease дууссаны дараа reconcile → Core-оос лавлагаагаар олж дуусгана (ACTIVE, ERP 1), openLoan 1 удаа', async () => {
    const app = await submitted();
    await coreOkLocalFails(app.id);
    const coreLoanId = (await mock.findLoan(mock.calls[0]!.idempotencyKey))!.coreLoanId;
    await expireLease(app.id);
    const res = await http().post(`${base(app.id)}/disbursement/reconcile`).set(approver).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const v = DisbursementView.parse(res.body);
    expect(v.status).toBe('SENT_TO_CORE');
    expect(v.coreLoanId).toBe(coreLoanId);
    expect(v.history.map((h) => h.action)).toEqual(['DRAFT_UPDATED', 'SUBMITTED', 'APPROVED', 'SENT_TO_CORE']);
    expect(v.history.at(-1)!.note).toBe('RECONCILED');
    expect(await appStatus(app.id)).toBe('ACTIVE');
    expect(await t.prisma.erpEvent.count({ where: { applicationId: app.id, eventType: 'DISBURSEMENT' } })).toBe(1);
    expect(mock.calls).toHaveLength(1);
    expect((await http().post(`${base(app.id)}/disbursement/reconcile`).set(approver).send({})).status).toBe(409);
  });

  it('H1: lease дууссаны дараа approve дахин дарвал мөн нээхгүй, зөвхөн дуусгана', async () => {
    const app = await submitted();
    await coreOkLocalFails(app.id);
    await expireLease(app.id);
    const res = await http().post(`${base(app.id)}/disbursement/approve`).set(approver).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(DisbursementView.parse(res.body).status).toBe('SENT_TO_CORE');
    expect(mock.calls).toHaveLength(1);
  });

  it('H1 sweeper: хугацаа хэтэрсэн APPROVED-г олж дуусгана; Core-д байхгүй бол settle-ийн дараа л FAILED (sweeper хэзээ ч нээхгүй)', async () => {
    const svc = t.app.get(DisbursementService);
    const a = await submitted();
    await coreOkLocalFails(a.id);
    expect(await svc.reconcileStale()).toBe(0); // lease хүчинтэй
    // Core руу хүрээгүй (процесс унасан) мөр
    const b = await submitted('C-2026-0002');
    await t.prisma.disbursementRequest.update({ where: { applicationId: b.id }, data: { status: 'APPROVED', coreRequestedAt: t.clock.now() } });
    await expireLease(b.id);

    expect(await svc.reconcileStale()).toBe(2);
    expect((await disb(a.id)).status).toBe('SENT_TO_CORE');
    expect(await appStatus(a.id)).toBe('ACTIVE');
    // b: унасан lease эзэмшигч openLoan илгээсэн байж болно → тодорхойгүй; шууд FAILED биш
    expect((await disb(b.id)).status).toBe('APPROVED');
    expect((await disb(b.id)).coreUnknownAt).not.toBeNull();
    t.clock.advanceMs(SETTLE_MS);
    expect(await svc.reconcileStale()).toBe(1); // 1/2
    expect((await disb(b.id)).status).toBe('APPROVED');
    expireLease(b.id);
    expect(await svc.reconcileStale()).toBe(1); // 2/2 → баталгаатай
    expect((await disb(b.id)).status).toBe('FAILED');
    expect(await appStatus(b.id)).toBe('DISBURSING');
    expect(mock.calls).toHaveLength(1); // зөвхөн a-гийн анхны дуудлага
    expect(await svc.reconcileStale()).toBe(0);
    // FAILED-ийг батлагч дахин зөвшөөрвөл нэг л удаа нээнэ
    expect((await http().post(`${base(b.id)}/disbursement/approve`).set(approver).send({})).status).toBe(200);
    expect(mock.calls).toHaveLength(2);
  });

  const lookupDown: CoreLoanPort = { mode: 'mock', findLoan: async () => { throw new CoreLoanError('CORE_UNAVAILABLE', 'down'); }, openLoan: async () => { throw new CoreLoanError('CORE_UNAVAILABLE', 'down'); } };
  const breakG5 = (applicationId: string) => t.prisma.repaymentSchedule.updateMany({ where: { applicationId }, data: { isStale: true } });
  const history = async (applicationId: string) => (await disb(applicationId)).historyJson as Array<{ action: string; by: string | null; note: string | null }>;
  /** Core данс нээгээд "татгалзсан" гэж хариулсан (FAILED, гэхдээ Core-д данс бий) — FAILED + данс гэсэн хамгийн муу тохиолдол. */
  async function failedWithCoreLoan(appId: string) {
    core = { mode: 'mock', findLoan: (k) => mock.findLoan(k), openLoan: async (r) => { await mock.openLoan(r); throw new CoreLoanError('CORE_REJECTED', 'rejected'); } };
    expect((await http().post(`${base(appId)}/disbursement/approve`).set(approver).send({})).status).toBe(502);
    expect((await disb(appId)).status).toBe('FAILED');
    core = mock;
  }

  it('H1: Core timeout боловч данс нээгдсэн → APPROVED (тодорхойгүй, lease хадгалагдана); буцаах 409; lease дууссаны дараа reconcile нээхгүй, олж дуусгана', async () => {
    const app = await submitted();
    core = { mode: 'mock', findLoan: (k) => mock.findLoan(k), openLoan: async (r) => { await mock.openLoan(r); throw new CoreLoanError('CORE_UNAVAILABLE', 'timeout'); } };
    expect((await http().post(`${base(app.id)}/disbursement/approve`).set(approver).send({})).status).toBe(502);
    expect((await disb(app.id)).status).toBe('APPROVED');
    expect((await disb(app.id)).coreRequestedAt).not.toBeNull();
    core = mock;
    expect((await http().post(`${base(app.id)}/disbursement/reject`).set(approver).send({ comment: 'буцаая' })).status).toBe(409);
    expireLease(app.id);
    const ok = await http().post(`${base(app.id)}/disbursement/reconcile`).set(approver).send({});
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(DisbursementView.parse(ok.body).status).toBe('SENT_TO_CORE');
    expect(mock.calls).toHaveLength(1);
    expect(await appStatus(app.id)).toBe('ACTIVE');
  });

  it('H1 sweeper: Core лавлагаа унавал FAILED болгохгүй — APPROVED + lease хэвээр (дуусахаар дахин шалгана); "олдсонгүй" settle-ийн дараа л FAILED', async () => {
    const svc = t.app.get(DisbursementService);
    const app = await submitted();
    await t.prisma.disbursementRequest.update({ where: { applicationId: app.id }, data: { status: 'APPROVED', coreRequestedAt: t.clock.now() } });
    await expireLease(app.id);
    core = lookupDown;
    expect(await svc.reconcileStale()).toBe(1);
    const row = await disb(app.id);
    expect(row.status).toBe('APPROVED');
    expect(row.coreRequestedAt).not.toBeNull();
    expect((await history(app.id)).filter((h) => h.action === 'CORE_UNKNOWN')).toHaveLength(1);
    core = mock;
    expect(await svc.reconcileStale()).toBe(0); // lease хүчинтэй
    expireLease(app.id);
    expect(await svc.reconcileStale()).toBe(1); // олдохгүй, гэхдээ settle цонх дотор
    expect((await disb(app.id)).status).toBe('APPROVED');
    t.clock.advanceMs(SETTLE_MS);
    expect(await svc.reconcileStale()).toBe(1);
    expireLease(app.id);
    expect(await svc.reconcileStale()).toBe(1);
    expect((await disb(app.id)).status).toBe('FAILED');
    expect(mock.calls).toHaveLength(0);
  });

  it('H1: FAILED мөрийг Core лавлагаа унасан үед буцаахгүй (fail closed, 502)', async () => {
    const app = await submitted();
    core = { mode: 'mock', findLoan: async () => null, openLoan: async () => { throw new CoreLoanError('CORE_REJECTED', 'no'); } };
    expect((await http().post(`${base(app.id)}/disbursement/approve`).set(approver).send({})).status).toBe(502);
    expect((await disb(app.id)).status).toBe('FAILED');
    core = lookupDown;
    expect((await http().post(`${base(app.id)}/disbursement/reject`).set(approver).send({ comment: 'буцаая' })).status).toBe(502);
    expect((await disb(app.id)).status).toBe('FAILED');
  });

  it('H1: FAILED + Core-д данс бий + G5 одоо унасан → approve 422, буцаах 409, reconcile нээхгүйгээр дуусгана', async () => {
    const app = await submitted();
    await failedWithCoreLoan(app.id);
    await breakG5(app.id);
    expect((await http().post(`${base(app.id)}/disbursement/approve`).set(approver).send({})).status).toBe(422);
    expect((await http().post(`${base(app.id)}/disbursement/reject`).set(approver).send({ comment: 'буцаая' })).body.code).toBe('DISBURSEMENT_CORE_LOAN_EXISTS');
    const res = await http().post(`${base(app.id)}/disbursement/reconcile`).set(approver).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(DisbursementView.parse(res.body).status).toBe('SENT_TO_CORE');
    expect(await appStatus(app.id)).toBe('ACTIVE');
    expect(mock.calls).toHaveLength(1);
  });

  it('H1: FAILED reconcile — Core-д байхгүй бол FAILED хэвээр (нээхгүй); лавлагаа унавал 502, FAILED хэвээр', async () => {
    const app = await submitted();
    core = { mode: 'mock', findLoan: async () => null, openLoan: async () => { throw new CoreLoanError('CORE_REJECTED', 'no'); } };
    await http().post(`${base(app.id)}/disbursement/approve`).set(approver).send({});
    core = mock;
    const before = await history(app.id);
    const res = await http().post(`${base(app.id)}/disbursement/reconcile`).set(approver).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(DisbursementView.parse(res.body).status).toBe('FAILED');
    expect(await history(app.id)).toEqual(before);
    expect(mock.calls).toHaveLength(0);
    core = lookupDown;
    expect((await http().post(`${base(app.id)}/disbursement/reconcile`).set(approver).send({})).status).toBe(502);
    expect((await disb(app.id)).status).toBe('FAILED');
  });

  it('H1: хугацаа хэтэрсэн APPROVED-г дахин зөвшөөрөхөд G5 дахин шалгана (унасан бол нээхгүй); амжилттай бол APPROVE_RETRY түүх', async () => {
    const app = await submitted();
    await t.prisma.disbursementRequest.update({ where: { applicationId: app.id }, data: { status: 'APPROVED', coreRequestedAt: t.clock.now() } });
    await expireLease(app.id);
    await breakG5(app.id);
    const bad = await http().post(`${base(app.id)}/disbursement/approve`).set(approver).send({});
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('DISBURSEMENT_GATE_FAILED');
    expect(mock.calls).toHaveLength(0);
    await t.prisma.repaymentSchedule.updateMany({ where: { applicationId: app.id }, data: { isStale: false } });
    const ok = await http().post(`${base(app.id)}/disbursement/approve`).set(approver).send({ comment: 'дахин' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await history(app.id)).find((h) => h.action === 'APPROVE_RETRY')).toMatchObject({ by: 'approver-1', note: 'дахин' });
    expect(mock.calls).toHaveLength(1);
  });

  it('H1: буцааж дахин илгээсэн олголт өмнөх оролдлогын Core дансыг холбохгүй (оролдлого бүр шинэ idempotency key)', async () => {
    const app = await submitted();
    const id = (await disb(app.id)).id;
    expect((await http().post(`${base(app.id)}/disbursement/reject`).set(approver).send({ comment: 'дүн буруу' })).status).toBe(200);
    // Өмнөх оролдлогод (шалгалтын дараа) Core данс нээсэн гэж үзье — хуучин ба 1-р оролдлогын түлхүүрээр
    const planted = mock.calls.length;
    const req = { applicationId: app.id, contractNo: 'C-2026-0001', customerId: 'c', amount: 30_000_000, currency: 'MNT', termMonths: 12, interestRate: 24, repaymentType: 'ANNUITY', disburseDate: '2026-11-05', firstPaymentDate: null, account: { bankCode: 'KHAN', accountNo: '5012345670', holderName: 'X' } };
    const old = [(await mock.openLoan({ ...req, idempotencyKey: id })).coreLoanId, (await mock.openLoan({ ...req, idempotencyKey: `${id}:1` })).coreLoanId];
    expect((await http().put(`${base(app.id)}/disbursement`).set(officer).send({ disburseAmount: 20_000_000 })).status).toBe(200);
    expect((await http().post(`${base(app.id)}/disbursement/submit`).set(officer)).status).toBe(200);
    const ok = await http().post(`${base(app.id)}/disbursement/approve`).set(approver).send({});
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(old).not.toContain(DisbursementView.parse(ok.body).coreLoanId);
    expect(mock.calls).toHaveLength(planted + 3);
    expect(mock.calls.at(-1)).toMatchObject({ idempotencyKey: `${id}:2`, amount: 20_000_000 });
  });

  // ── H1 race: тодорхойгүй үр дүнгийн дараах "олдсонгүй" нь settle цонх (900с) + 2 зайтай лавлагаанаас өмнө баталгаагүй ──
  const actions = async (applicationId: string) => (await history(applicationId)).map((h) => h.action);
  async function timedOutLateOpen(appId: string) {
    mock.delayOpens = true;
    const r = await http().post(`${base(appId)}/disbursement/approve`).set(approver).send({});
    expect(r.status, JSON.stringify(r.body)).toBe(502);
    const row = await disb(appId);
    expect(row.status).toBe('APPROVED');
    expect(row.coreRequestedAt).not.toBeNull(); // lease суллагдахгүй
    expect(row.coreUnknownAt).not.toBeNull();
    return mock.calls[0]!.idempotencyKey;
  }

  it('H1 race: timeout → Core хожуу нээнэ → шууд reconcile/sweeper FAILED болгохгүй, буцаахгүй; данс гарч ирвэл дуусгана (давхар данс үгүй)', async () => {
    const svc = t.app.get(DisbursementService);
    const app = await submitted();
    const key = await timedOutLateOpen(app.id);
    const early = await http().post(`${base(app.id)}/disbursement/reconcile`).set(approver).send({});
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('DISBURSEMENT_CORE_IN_PROGRESS'); // lease хүчинтэй
    expireLease(app.id);
    const settling = await http().post(`${base(app.id)}/disbursement/reconcile`).set(approver).send({});
    expect(settling.status, JSON.stringify(settling.body)).toBe(409);
    expect(settling.body.code).toBe('DISBURSEMENT_CORE_SETTLING');
    expect((await disb(app.id)).status).toBe('APPROVED');
    expireLease(app.id);
    expect(await svc.reconcileStale()).toBe(1);
    expect((await disb(app.id)).status).toBe('APPROVED');
    expect((await http().post(`${base(app.id)}/disbursement/reject`).set(approver).send({ comment: 'буцаая' })).status).toBe(409);
    // Түүх: CORE_UNKNOWN нэг, CORE_SETTLING нэг (лавлагаа бүрт spam үгүй)
    expect((await actions(app.id)).filter((a) => a === 'CORE_SETTLING')).toHaveLength(1);
    expect((await actions(app.id)).filter((a) => a === 'CORE_UNKNOWN')).toHaveLength(1);

    mock.flushLateOpens();
    expireLease(app.id);
    const ok = await http().post(`${base(app.id)}/disbursement/reconcile`).set(approver).send({});
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(DisbursementView.parse(ok.body).coreLoanId).toBe((await mock.findLoan(key))!.coreLoanId);
    expect(await appStatus(app.id)).toBe('ACTIVE');
    expect(mock.calls).toHaveLength(1);
    const row = await disb(app.id);
    expect([row.coreUnknownAt, row.coreNotFoundCount]).toEqual([null, 0]);
  });

  it('H1 race: Core үнэхээр нээгээгүй → settle цонх + 2 зайтай лавлагааны дараа л FAILED; дараа нь буцааж болно', async () => {
    const svc = t.app.get(DisbursementService);
    const app = await submitted();
    await timedOutLateOpen(app.id);
    t.clock.advanceMs(SETTLE_MS - 10_000); // цонх дуусахаас өмнөх лавлагаа тоологдохгүй
    expect(await svc.reconcileStale()).toBe(1);
    expect((await disb(app.id)).coreNotFoundCount).toBe(0);
    t.clock.advanceMs(10_000);
    expect(await svc.reconcileStale()).toBe(0); // lease хүчинтэй (лавлагаа хоорондын зай)
    expireLease(app.id);
    const first = await http().post(`${base(app.id)}/disbursement/reconcile`).set(approver).send({});
    expect(first.body.code).toBe('DISBURSEMENT_CORE_SETTLING');
    expect((await disb(app.id)).coreNotFoundCount).toBe(1);
    expireLease(app.id);
    expect(await svc.reconcileStale()).toBe(1);
    expect((await disb(app.id)).status).toBe('FAILED');
    expect((await history(app.id)).at(-1)).toMatchObject({ action: 'CORE_FAILED', note: 'CORE_NOT_FOUND' });
    expect([(await disb(app.id)).coreUnknownAt, (await disb(app.id)).coreNotFoundCount]).toEqual([null, 0]); // баталгаатай → цэвэрлэгдэнэ
    expect((await actions(app.id)).filter((a) => a === 'CORE_SETTLING')).toHaveLength(1);
    const rej = await http().post(`${base(app.id)}/disbursement/reject`).set(approver).send({ comment: 'буцаая' });
    expect(rej.status, JSON.stringify(rej.body)).toBe(200);
    expect(DisbursementView.parse(rej.body).status).toBe('DRAFT');
    expect(mock.calls).toHaveLength(1);
  });

  it('H1 race: дахин зөвшөөрөх нь ИЖИЛ түлхүүр ашиглана; тодорхой Core татгалзалт (данс байхгүй нь баталгаатай) → FAILED, буцаах шууд зөвшөөрөгдөнө', async () => {
    const app = await submitted();
    const key = await timedOutLateOpen(app.id);
    expireLease(app.id);
    const retry = await http().post(`${base(app.id)}/disbursement/approve`).set(approver).send({});
    expect(retry.status).toBe(502); // давхар оролдлого ч timeout (Core боловсруулж байна)
    expect(mock.calls.map((c) => c.idempotencyKey)).toEqual([key, key]);
    expireLease(app.id);
    core = { mode: 'mock', findLoan: (k) => mock.findLoan(k), openLoan: async () => { throw new CoreLoanError('CORE_REJECTED', 'rejected'); } };
    expect((await http().post(`${base(app.id)}/disbursement/approve`).set(approver).send({})).status).toBe(502);
    core = mock;
    const failed = await disb(app.id);
    expect([failed.status, failed.coreUnknownAt, failed.coreNotFoundCount]).toEqual(['FAILED', null, 0]);
    const ok = await http().post(`${base(app.id)}/disbursement/reject`).set(approver).send({ comment: 'буцаая' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(DisbursementView.parse(ok.body).status).toBe('DRAFT');
    const row = await disb(app.id);
    expect([row.coreUnknownAt, row.coreNotFoundCount, row.coreRequestedAt]).toEqual([null, 0, null]);
  });

  // ── H1 review-2: settle цонх нь openLoan илгээгдэж БОЛОХ хамгийн сүүлийн мөчөөс тоологдоно; хуучин нотолгоо шинэ оролдлогод шилжихгүй ──
  /** Хуучин (өмнөх оролдлогын) нотолгоо: цонх аль хэдийн өнгөрсөн, тоолуур ≥ 2. */
  const plantOldEvidence = (applicationId: string, status: string) => {
    const now = t.clock.now().getTime();
    return t.prisma.disbursementRequest.update({ where: { applicationId }, data: { status, coreUnknownAt: new Date(now - 7_200_000), coreNotFoundCount: 2, coreNotFoundAt: new Date(now - 3_600_000) } });
  };
  /** openLoan Core руу илгээгдсэний дараа процесс унана (markUnknown хэзээ ч ажиллахгүй). */
  const crashAfterOpenSent = () => {
    mock.delayOpens = true;
    vi.spyOn(t.app.get(DisbursementService) as unknown as { markUnknown: () => Promise<void> }, 'markUnknown').mockRejectedValueOnce(new Error('process crashed'));
  };
  async function expectSettling(applicationId: string) {
    const r = await http().post(`${base(applicationId)}/disbursement/reconcile`).set(approver).send({});
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.code).toBe('DISBURSEMENT_CORE_SETTLING');
    expect((await disb(applicationId)).status).toBe('APPROVED');
  }

  it('H1 review-2 (a): SUBMITTED + хуучин нотолгоо → approve openLoan илгээгээд унасан → reconcile SETTLING (FAILED биш)', async () => {
    const app = await submitted();
    await plantOldEvidence(app.id, 'SUBMITTED');
    crashAfterOpenSent();
    expect((await http().post(`${base(app.id)}/disbursement/approve`).set(approver).send({})).status).toBe(500);
    expect(mock.calls).toHaveLength(1);
    expireLease(app.id);
    await expectSettling(app.id);
    expireLease(app.id);
    expect(await t.app.get(DisbursementService).reconcileStale()).toBe(1);
    expect((await disb(app.id)).status).toBe('APPROVED');
    mock.flushLateOpens();
    expireLease(app.id);
    expect((await http().post(`${base(app.id)}/disbursement/reconcile`).set(approver).send({})).status).toBe(200);
    expect(await appStatus(app.id)).toBe('ACTIVE');
  });

  it('H1 review-2 (b): FAILED + хуучин нотолгоо → дахин зөвшөөрөх openLoan илгээгээд унасан → reconcile SETTLING', async () => {
    const app = await submitted();
    await plantOldEvidence(app.id, 'FAILED');
    crashAfterOpenSent();
    expect((await http().post(`${base(app.id)}/disbursement/approve`).set(approver).send({})).status).toBe(500);
    expireLease(app.id);
    await expectSettling(app.id);
  });

  it('H1 review-2 (b): FAILED + хуучин нотолгоо → дахин зөвшөөрөх timeout → reconcile SETTLING; reject 409', async () => {
    const app = await submitted();
    await plantOldEvidence(app.id, 'FAILED');
    mock.delayOpens = true;
    expect((await http().post(`${base(app.id)}/disbursement/approve`).set(approver).send({})).status).toBe(502);
    expireLease(app.id);
    await expectSettling(app.id);
    expect((await http().post(`${base(app.id)}/disbursement/reject`).set(approver).send({ comment: 'x' })).status).toBe(409);
  });

  it('H1 review-2: хугацаа хэтэрсэн APPROVED + хуучин нотолгоо → дахин зөвшөөрөх openLoan илгээгээд унасан → sweeper FAILED болгохгүй', async () => {
    const app = await submitted();
    await plantOldEvidence(app.id, 'APPROVED');
    await t.prisma.disbursementRequest.update({ where: { applicationId: app.id }, data: { coreRequestedAt: new Date(t.clock.now().getTime() - CORE_LEASE_MS - 1_000) } });
    crashAfterOpenSent();
    expect((await http().post(`${base(app.id)}/disbursement/approve`).set(approver).send({})).status).toBe(500);
    expireLease(app.id);
    expect(await t.app.get(DisbursementService).reconcileStale()).toBe(1);
    expect((await disb(app.id)).status).toBe('APPROVED');
  });

  it('H1 review-2 (c): FAILED + хуучин (цонх дотор) нотолгоо → дахин зөвшөөрөх, Core тодорхой татгалзана → FAILED, буцаах шууд зөвшөөрөгдөнө', async () => {
    const app = await submitted();
    await t.prisma.disbursementRequest.update({ where: { applicationId: app.id }, data: { status: 'FAILED', coreUnknownAt: new Date(t.clock.now().getTime() - 60_000), coreNotFoundCount: 0 } });
    core = { mode: 'mock', findLoan: async () => null, openLoan: async () => { throw new CoreLoanError('CORE_REJECTED', 'no'); } };
    expect((await http().post(`${base(app.id)}/disbursement/approve`).set(approver).send({})).status).toBe(502);
    core = mock;
    expect((await disb(app.id)).status).toBe('FAILED');
    expect((await http().post(`${base(app.id)}/disbursement/reject`).set(approver).send({ comment: 'буцаая' })).status).toBe(200);
  });

  // ── H1 review-3: settle эхлэл = openLoan-ийг бодитоор илгээх мөч; lease алдсан / хугацаа дөхсөн эзэмшигч илгээхгүй ──
  it('H1 review-3 (a): findLoan-ийн дараа эзэмшигч send deadline-аас хэтэртэл "хөлдсөн" → openLoan ИЛГЭЭХГҮЙ, 409', async () => {
    const app = await submitted();
    core = { mode: 'mock', findLoan: async (k) => { t.clock.advanceMs(CORE_LEASE_MS - CORE_CALL_TIMEOUT_MS + 1_000); return mock.findLoan(k); }, openLoan: (r) => mock.openLoan(r) };
    const r = await http().post(`${base(app.id)}/disbursement/approve`).set(approver).send({});
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.code).toBe('DISBURSEMENT_CORE_IN_PROGRESS');
    expect(mock.calls).toHaveLength(0);
    expect((await disb(app.id)).status).toBe('APPROVED');
  });

  it('H1 review-3 (b): claim ба илгээх хооронд lease-ийг өөр процесс авсан → openLoan ИЛГЭЭХГҮЙ, 409', async () => {
    const app = await submitted();
    core = { mode: 'mock', findLoan: async (k) => {
      await t.prisma.disbursementRequest.update({ where: { applicationId: app.id }, data: { coreRequestedAt: new Date(t.clock.now().getTime() + 1) } });
      return mock.findLoan(k);
    }, openLoan: (r) => mock.openLoan(r) };
    const r = await http().post(`${base(app.id)}/disbursement/approve`).set(approver).send({});
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(mock.calls).toHaveLength(0);
  });

  it('H1 review-3 (c): core_unknown_at = openLoan илгээсэн мөч (claim биш) — findLoan удаан байсан ч', async () => {
    const app = await submitted();
    const claimedAt = t.clock.now().getTime();
    let seen: { stamp: number | undefined; sentAt: number } | null = null;
    core = {
      mode: 'mock',
      findLoan: async (k) => { t.clock.advanceMs(5_000); return mock.findLoan(k); },
      openLoan: async (r) => { seen = { stamp: (await disb(app.id)).coreUnknownAt?.getTime(), sentAt: t.clock.now().getTime() }; return mock.openLoan(r); },
    };
    const r = await http().post(`${base(app.id)}/disbursement/approve`).set(approver).send({});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(seen).toEqual({ stamp: claimedAt + 5_000, sentAt: claimedAt + 5_000 });
    expect((await disb(app.id)).coreUnknownAt).toBeNull(); // амжилт → цэвэрлэгдэнэ
  });

  it('H1 review-3 (d): claimStale — илгээсэн lease → эхлэл = lease төгсгөл; дараагийн lookup-only claim эхлэлийг хөдөлгөхгүй', async () => {
    const svc = t.app.get(DisbursementService);
    const app = await submitted();
    const R = t.clock.now().getTime();
    await t.prisma.disbursementRequest.update({ where: { applicationId: app.id }, data: { status: 'APPROVED', coreRequestedAt: new Date(R), coreUnknownAt: new Date(R + 5_000) } });
    expireLease(app.id);
    expect(await svc.reconcileStale()).toBe(1);
    expect((await disb(app.id)).coreUnknownAt?.getTime()).toBe(R + CORE_LEASE_MS);
    expireLease(app.id);
    expect(await svc.reconcileStale()).toBe(1);
    expect((await disb(app.id)).coreUnknownAt?.getTime()).toBe(R + CORE_LEASE_MS);
    expect((await disb(app.id)).status).toBe('APPROVED');
  });

  it('H1 review-3 (d): хугацаа хэтэрсэн lease-ийг дахин зөвшөөрөх авч, илгээхгүй зогсвол эхлэл = хуучин lease төгсгөл (хуучин тамга биш)', async () => {
    const app = await submitted();
    const R = t.clock.now().getTime();
    await t.prisma.disbursementRequest.update({ where: { applicationId: app.id }, data: { status: 'APPROVED', coreRequestedAt: new Date(R), coreUnknownAt: new Date(R + 5_000) } });
    expireLease(app.id);
    core = { mode: 'mock', findLoan: async (k) => { t.clock.advanceMs(CORE_LEASE_MS); return mock.findLoan(k); }, openLoan: (r) => mock.openLoan(r) };
    expect((await http().post(`${base(app.id)}/disbursement/approve`).set(approver).send({})).status).toBe(409);
    expect(mock.calls).toHaveLength(0);
    expect((await disb(app.id)).coreUnknownAt?.getTime()).toBe(R + CORE_LEASE_MS);
  });

  it('H1: тодорхойгүй үр дүнгүй мөр — Core татгалзвал шууд FAILED, буцаах шууд зөвшөөрөгдөнө (өмнөх зан төлөв)', async () => {
    const app = await submitted();
    core = { mode: 'mock', findLoan: async () => null, openLoan: async () => { throw new CoreLoanError('CORE_REJECTED', 'no'); } };
    expect((await http().post(`${base(app.id)}/disbursement/approve`).set(approver).send({})).status).toBe(502);
    expect((await disb(app.id)).coreUnknownAt).toBeNull();
    core = mock;
    expect((await http().post(`${base(app.id)}/disbursement/reject`).set(approver).send({ comment: 'буцаая' })).status).toBe(200);
  });

  it('H1: зэрэг хоёр approve → нэг нь 200, нөгөө нь 409; openLoan 1 удаа', async () => {
    const app = await submitted();
    const [r1, r2] = await Promise.all([1, 2].map(() => http().post(`${base(app.id)}/disbursement/approve`).set(approver).send({})));
    expect([r1!.status, r2!.status].sort()).toEqual([200, 409]);
    expect(mock.calls).toHaveLength(1);
  });

  it('H1: reconcile нь SUBMITTED мөрт 409 DISBURSEMENT_NOT_RECONCILABLE; ЗЭЗ-д 403', async () => {
    const app = await submitted();
    const r = await http().post(`${base(app.id)}/disbursement/reconcile`).set(approver).send({});
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('DISBURSEMENT_NOT_RECONCILABLE');
    expect((await http().post(`${base(app.id)}/disbursement/reconcile`).set(officer).send({})).status).toBe(403);
  });

  it('албан бичиг: үүсгэж, хэвлэсэн тэмдэглэнэ; загвар тохируулаагүй бол 422', async () => {
    const app = await approvedApp();
    const l = OfficialLetterView.parse((await http().post(`${base(app.id)}/contract/official-letters`).set(officer).send({ extra: { representative_name: 'Б. Болд' } })).body);
    expect(l.generatedFileId).toBeTruthy();
    expect((dms.renders[0]!.data as Record<string, string>).representative_name).toBe('Б. Болд');
    const printed = OfficialLetterView.parse((await http().post(`${base(app.id)}/contract/official-letters/${l.id}/print`).set(officer)).body);
    expect(printed.printedAt).not.toBeNull();
    dms.templates.delete('OFFICIAL_LETTER');
    expect((await http().post(`${base(app.id)}/contract/official-letters`).set(officer).send({})).status).toBe(422);
    dms.templates.add('OFFICIAL_LETTER');
  });

  it('гарын үсэгтэй гэрээг дахин үүсгэхгүй (409); олдохгүй файл 422', async () => {
    const app = await approvedApp();
    await http().post(`${base(app.id)}/contract/generate`).set(officer);
    expect((await http().post(`${base(app.id)}/contract/signed`).set(officer).send({ fileId: 'nope' })).status).toBe(422);
    await http().post(`${base(app.id)}/contract/signed`).set(officer).send({ fileId: [...dms.files][0] });
    expect((await http().post(`${base(app.id)}/contract/generate`).set(officer)).status).toBe(409);
  });
});
