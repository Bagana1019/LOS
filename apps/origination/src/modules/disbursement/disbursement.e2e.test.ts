import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { ContractView, DisbursementView, OfficialLetterView } from '@los/contracts';
import { createTestApp, type TestApp } from '../../test-utils/test-app';
import { actors, createApplication, createBorrower, createCustomer, createSchedule, hasTestDb, ORG, resetDb } from '../../test-utils/factories';
import { CORE_LOAN_PORT } from '../../integrations/core-loan/core-loan.provider';
import { CoreLoanError, type CoreLoanPort } from '../../integrations/core-loan/core-loan.port';
import { MockCoreLoanPort } from '../../integrations/core-loan/core-loan.mock';
import { ApplicationModule } from '../application/application.module';
import { ContractModule } from '../contract/contract.module';
import { DMS_DOCGEN } from '../contract/dms-docgen.port';
import { FakeDmsDocgen } from '../contract/testing/fake-dms-docgen';
import { DisbursementModule } from './disbursement.module';

// Модуль 11 AC: гэрээнд нэр/дүн/ЭТХ орно; олгох дүн > батлагдсан → 400; гарын үсэггүй → илгээх идэвхгүй; зөвшөөрөхөд ACTIVE + core_loan_id хадгалагдана.
describe.skipIf(!hasTestDb)('contract + disbursement (M11, DB)', () => {
  let t: TestApp;
  let baseUrl: string;
  const dms = new FakeDmsDocgen();
  let core: CoreLoanPort = new MockCoreLoanPort();
  const officer = actors.officer('officer-1');
  const approver = actors.approver('approver-1');

  beforeAll(async () => {
    t = await createTestApp([ApplicationModule, ContractModule, DisbursementModule], (b) => b.overrideProvider(DMS_DOCGEN).useValue(dms).overrideProvider(CORE_LOAN_PORT).useFactory({ factory: () => ({ get mode() { return core.mode; }, openLoan: (r: never) => core.openLoan(r) }) }));
    await t.app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => { await t.close(); });
  beforeEach(async () => { await resetDb(t.prisma); dms.renders.length = 0; dms.files.clear(); core = new MockCoreLoanPort(); });

  const http = () => request(baseUrl);
  const base = (id: string) => `/api/applications/${id}`;

  async function approvedApp(o: { requiresCollateral?: boolean; registryNo?: string | null } = {}) {
    const product = await t.prisma.product.create({ data: { orgId: ORG, code: 'P1', name: 'Хэрэглээний', productType: 'CONSUMER', minAmount: 100_000, maxAmount: 50_000_000, minTerm: 1, maxTerm: 36, minRate: 10, maxRate: 40, requiresCollateral: o.requiresCollateral ?? true } });
    const customer = await createCustomer(t.prisma, { firstName: 'Дорж', lastName: 'Бат-Эрдэнэ' });
    const app = await createApplication(t.prisma, { status: 'APPROVED', productId: product.id, contractNo: 'C-2026-0001', amount: 30_000_000, interestRate: 24, termMonths: 12 });
    await createBorrower(t.prisma, app.id, customer.id);
    const sched = await createSchedule(t.prisma, app.id, { principal: 30_000_000, rate: 24, months: 12, firstDue: '2026-12-05' });
    await t.prisma.repaymentSchedule.update({ where: { id: sched.id }, data: { paramsJson: { type: 'ANNUITY', firstPaymentDate: '2026-12-05', principal: 30_000_000, termMonths: 12, annualRate: 24 } } });
    await t.prisma.decisionRecord.create({ data: { orgId: ORG, applicationId: app.id, decisionNo: 'D-1', decidedAt: new Date() } });
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

  it('Core унавал FAILED (хүсэлт DISBURSING хэвээр), дахин оролдож болно; буцаавал DRAFT/APPROVED', async () => {
    const app = await approvedApp();
    await ready(app.id);
    await http().post(`${base(app.id)}/disbursement/submit`).set(officer);
    core = { mode: 'mock', openLoan: async () => { throw new CoreLoanError('CORE_UNAVAILABLE', 'down'); } };
    const bad = await http().post(`${base(app.id)}/disbursement/approve`).set(approver).send({});
    expect(bad.status).toBe(502);
    expect(bad.body.code).toBe('CORE_OPEN_LOAN_FAILED');
    expect((await t.prisma.disbursementRequest.findUniqueOrThrow({ where: { applicationId: app.id } })).status).toBe('FAILED');
    expect((await t.prisma.loanApplication.findUniqueOrThrow({ where: { id: app.id } })).status).toBe('DISBURSING');
    expect(await t.prisma.erpEvent.count({ where: { applicationId: app.id } })).toBe(0);

    core = new MockCoreLoanPort();
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
