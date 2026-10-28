// E2E ТЕСТИЙН хуваалцсан хэсэг (SYNTHETIC): «үүсгэх → 2 хуулга upload → ажлын төлөв → тойм → гүйлгээ → ангилал солих → дахин тооцоолох →
// задаргаа → системрүү татах → scoring оролт» бүтэн урсгал. in-memory (bsa-api.e2e.test.ts) ба жинхэнэ Postgres+Redis (bsa-api.integration.e2e.test.ts)
// хоёр ЯГ ИЖИЛ урсгалыг ажиллуулна. Хүлээгдэх тоонуудыг КОДООС БИШ, датасетийн тогтмолуудаас ГАРААР бодож бичсэн (тайлбарт зөвхөн арифметик).
//
// Датасет (testing/scenario.ts, PDF/Latin хувилбар; сар бүр ижил, 2026-04..06, ББӨ 10 %, санал болгосон төлбөр 500,000):
//   A (TDB, 18 мөр): Salary 1,200,000 · Sales 900,000 · Loan payment 400,000 · Goods 150,000 · Food 100,000 · Fee 1,000 (04-01, 06-30) · Transfer 500,000 (05-28)
//   B (MBANK, 9 мөр): Rent 600,000 · Unitel 80,000 · Fee 500 (04-01, 06-30) · Transfer-in 500,000 (05-28)
// Анхдагч дүрмээр: Salary → SALARY(100 %) · Unitel → FIXED_EXPENSE · бусад Latin утга → OTHER_INCOME(10 %)/OTHER_EXPENSE; Transfer хос → өөрийн шилжүүлэг.
import { BsaApiError } from '@los/contracts';
import type { Test } from 'supertest';
import { expect, vi } from 'vitest';
import { ACCOUNT_A, ACCOUNT_B, PII_MARKERS, happyFiles, withoutRandomIds } from '../testing/scenario';
import { analysisBody, type Api, type E2eApp } from './e2e-app';

export type Res = Awaited<Test>;
export interface JobBody {
  id: string;
  analysisId: string;
  fileName: string;
  bankCode: string | null;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  rowsTotal: number;
  rowsDone: number;
  accountMasked: string | null;
  errors: Array<{ code: string; message: string }>;
  warnings: Array<{ code: string; message: string }>;
}
export interface TxnBody {
  id: string;
  txnDate: string;
  direction: 'INCOME' | 'EXPENSE';
  amount: number;
  description: string;
  categoryCode: string | null;
  isOwnTransfer: boolean;
  manualOverride: boolean;
  importJobId: string;
}
interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

const WAIT = { timeout: 30_000, interval: 50 };
const CYRILLIC = /[Ѐ-ӿ]/;

/** Алдааны хариу: BsaApiError хэлбэр, монгол мессеж, correlationId, оруулсан утга/PII-гүй */
export function expectError(res: Res, status: number, errorCode: string): BsaApiError {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  const body = BsaApiError.parse(res.body);
  expect(body.statusCode).toBe(status);
  expect(body.errorCode).toBe(errorCode);
  expect(body.message).toMatch(CYRILLIC);
  expect(typeof body.correlationId).toBe('string');
  expectNoPii(JSON.stringify(res.body));
  return body;
}

/** Хариу/лог дотор хуурамч PII тэмдэг байхгүй (санамсаргүй UUID/hash-ийг эхлээд хасна) */
export function expectNoPii(text: string): void {
  const clean = withoutRandomIds(text);
  for (const marker of PII_MARKERS) expect(clean, `PII marker "${marker}" leaked`).not.toContain(marker);
}

/** Амжилттай хариунд дансны БҮТЭН дугаар, бүтэн регистр байхгүй (далдлагдсан) */
export function expectMasked(res: Res): void {
  const text = JSON.stringify(res.body);
  for (const secret of [ACCOUNT_A, ACCOUNT_B, 'УБ90010203', '90010203']) expect(text, `unmasked "${secret}"`).not.toContain(secret);
}

/** `count` ажил бүгд дуустал (COMPLETED | FAILED) API-аар асууна */
export async function waitForJobs(api: Api, analysisId: string, count: number): Promise<JobBody[]> {
  let jobs: JobBody[] = [];
  await vi.waitFor(async () => {
    const res = await api.get(`/bsa/jobs?analysisId=${analysisId}&pageSize=200`);
    expect(res.status).toBe(200);
    jobs = (res.body as Page<JobBody>).items;
    expect(jobs).toHaveLength(count);
    expect(jobs.every((j) => j.status === 'COMPLETED' || j.status === 'FAILED')).toBe(true);
  }, WAIT);
  return jobs;
}

export async function createAnalysis(api: Api, over: Record<string, unknown> = {}): Promise<{ id: string; body: Record<string, unknown> }> {
  const res = await api.post('/bsa/analyses', analysisBody(over));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { id: res.body.id as string, body: res.body as Record<string, unknown> };
}

export async function allTransactions(api: Api, id: string, query = ''): Promise<TxnBody[]> {
  const res = await api.get(`/bsa/analyses/${id}/transactions?limit=1000${query}`);
  expect(res.status).toBe(200);
  return (res.body as Page<TxnBody>).items;
}

const idOfDescription = (txns: TxnBody[], description: string): string => {
  const found = txns.find((t) => t.description === description);
  if (!found) throw new Error(`test setup: no transaction "${description}"`);
  return found.id;
};

export interface FlowResult {
  analysisId: string;
  jobs: JobBody[];
}

/** Бүтэн урсгал. `api` = байгууллага org-1, салбар br-1-ийн ЗЭЗ (officer) */
export async function runFullFlow(e: E2eApp): Promise<FlowResult> {
  const api = e.api.as('officer');

  // ── 1. Үүсгэх (INT-1): регистр далдлагдана ──
  const created = await api.post('/bsa/analyses', analysisBody());
  expect(created.status).toBe(201);
  expectMasked(created);
  expect(created.body).toMatchObject({
    status: 'DRAFT', version: 1, applicationId: 'app-1', branchId: 'br-1', createdBy: 'u-officer', summary: null, proposedMonthlyPayment: 500_000,
    customer: { registerNoMasked: '******0203' },
  });
  const id = created.body.id as string;
  expect((await api.get('/bsa/analyses')).body).toMatchObject({ total: 1, page: 1 });
  expect((await api.get('/bsa/analyses?status=ANALYZED')).body.total).toBe(0);
  expect((await api.get('/bsa/analyses?applicationId=app-1')).body.total).toBe(1);

  // ── 2. Хоёр PDF хуулга оруулах (BSA-FR-2.1) → 202, файл бүр ACCEPTED ──
  const { a, b } = await happyFiles({ format: 'pdf' });
  const upload = await api.upload(id, [a, b]);
  expect(upload.status, JSON.stringify(upload.body)).toBe(202);
  expect(upload.body).toMatchObject({ accepted: 2, duplicates: 0, rejected: 0 });
  expect((upload.body.outcomes as Array<{ status: string; format: string }>).map((o) => [o.status, o.format])).toEqual([['ACCEPTED', 'PDF'], ['ACCEPTED', 'PDF']]);

  // ── 3. Ажлын төлөв (BSA-FR-2.6): дуустал API-аар асууна ──
  const jobs = await waitForJobs(api, id, 2);
  const tdb = jobs.find((j) => j.bankCode === 'TDB');
  const mbank = jobs.find((j) => j.bankCode === 'MBANK');
  expect(tdb).toMatchObject({ status: 'COMPLETED', rowsTotal: 18, rowsDone: 18, accountMasked: '******3344', errors: [] });
  expect(mbank).toMatchObject({ status: 'COMPLETED', rowsTotal: 9, rowsDone: 9, accountMasked: '******1122', errors: [] });
  expect(tdb?.warnings.map((w) => w.code)).toContain('UNVERIFIED_PARSER'); // parser бодит хуулгаар баталгаажаагүй гэдгийг харуулна
  const list = await api.get(`/bsa/jobs?analysisId=${id}`);
  expectMasked(list);
  expect(list.body.counts).toEqual({ PENDING: 0, PROCESSING: 0, COMPLETED: 2, FAILED: 0 });
  expect((await api.get(`/bsa/jobs?analysisId=${id}&bank=TDB`)).body.total).toBe(1);
  expect((await api.get(`/bsa/jobs?analysisId=${id}&status=FAILED`)).body.total).toBe(0);
  const one = await api.get(`/bsa/jobs/${tdb?.id}`);
  expect(one.status).toBe(200);
  expect(one.body).toMatchObject({ id: tdb?.id, analysisId: id, status: 'COMPLETED' });
  const imports = await api.get(`/bsa/analyses/${id}/imports`);
  expect(imports.body).toMatchObject({ total: 2, counts: { COMPLETED: 2 } });

  // ── 4. Тойм: гараар бодсон суурь тоонууд ──
  // орлого/сар: Salary 1,200,000 + Sales 900,000 + Rent 600,000 = 2,700,000 (өөрийн шилжүүлгийн хос хасагдсан)
  // баталгаажсан: 1,200,000×1.0 + (900,000 + 600,000)×0.1 = 1,350,000 · DTI орлого: 1,350,000×(1−0.1) = 1,215,000
  // ӨОХ = 500,000 / 1,215,000 = 41.15 % → 41.2 (MEDIUM: 35 % < x ≤ 55 %) · өр 0 (Latin «Loan payment» анхдагч дүрэмд таарахгүй)
  const overview = await api.get(`/bsa/analyses/${id}`);
  expect(overview.status).toBe(200);
  expectMasked(overview);
  // Хадгалагдсан INT-4 хураангуй импорт бүрийн дараа DRAFT төлөвтэй шинэчлэгддэг (LOS-д зөвхөн finalize-аар хүрнэ)
  expect(overview.body.summary).toMatchObject({ status: 'DRAFT', transactionCount: 27, dtiIncome: 1_215_000, dtiPercent: 41.2 });
  expect(overview.body).toMatchObject({
    summaryStale: false,
    analysis: { status: 'DRAFT', ownAccountCount: 2, periodFrom: '2026-04-01', periodTo: '2026-06-30', periodMonths: 3 },
    transactions: { total: 27, income: 10, expense: 17, ownTransfers: 2, manualOverrides: 0 },
    jobs: { total: 2, counts: { COMPLETED: 2, FAILED: 0 } },
  });
  expect(overview.body.details).toMatchObject({
    period: { from: '2026-04-01', to: '2026-06-30', months: 3 },
    coverage: { requiredMonths: 3, coveredMonths: 3, shortfallMonths: 0 },
    transactions: { inPeriod: 27, ownTransfers: 2, outOfPeriod: 0 },
    dti: { costOfGoodsRate: 0.1, maxDti: 0.55, proposedMonthlyPayment: 500_000, meetsLimit: true },
  });
  const warningCodes = (overview.body.warnings as Array<{ code: string }>).map((w) => w.code);
  expect(warningCodes).toEqual(expect.arrayContaining(['UNVERIFIED_PARSER', 'OTHER_SHARE_EXCEEDED']));
  const history = (overview.body.history.items as Array<{ action: string }>).map((h) => h.action);
  expect(history).toEqual(expect.arrayContaining(['ANALYSIS_CREATED', 'FILE_UPLOADED', 'IMPORT_COMPLETED', 'RECALCULATED']));

  const baseline = await api.post(`/bsa/analyses/${id}/recalculate`, {}); // бие хоосон ⇒ ангилал + DTI дахин (өөрчлөлтгүй ⇒ ижил тоо)
  expect(baseline.status).toBe(200);
  expect(baseline.body).toMatchObject({
    recalculated: true,
    reclassified: 0,
    summary: {
      status: 'DRAFT', transactionCount: 27, periodMonths: 3, totalMonthlyIncome: 2_700_000, verifiedMonthlyIncome: 1_350_000, dtiIncome: 1_215_000,
      businessIncomeMonthly: 0, existingDebtServiceMonthly: 0, dtiPercent: 41.2, dtiLevel: 'MEDIUM', pendingSuspiciousCount: 0,
    },
  });

  // ── 5. Гүйлгээний жагсаалт ба шүүлтүүр (BSA-FR-4.6) ──
  const all = await allTransactions(api, id);
  expect(all).toHaveLength(27);
  expect(all[0]).toMatchObject({ txnDate: '2026-04-01' });
  const filtered = async (q: string): Promise<Page<TxnBody>> => {
    const res = await api.get(`/bsa/analyses/${id}/transactions?${q}`);
    expect(res.status, `${q}: ${JSON.stringify(res.body)}`).toBe(200);
    return res.body as Page<TxnBody>;
  };
  expect((await filtered('direction=INCOME')).total).toBe(10); // A: 3 цалин + 3 борлуулалт · B: 3 түрээс + 1 шилжүүлгийн орлого
  expect((await filtered('direction=EXPENSE')).total).toBe(17);
  const salary = await filtered('category=SALARY');
  expect(salary.items.map((t) => t.amount)).toEqual([1_200_000, 1_200_000, 1_200_000]);
  const own = await filtered('ownTransfer=true');
  expect(own.items.map((t) => [t.txnDate, t.amount]).sort()).toEqual([['2026-05-28', 500_000], ['2026-05-28', 500_000]]);
  expect((await filtered('category=OWN_TRANSFER_IN,NON_EXPENSE')).total).toBe(2); // таслалаар олон ангилал
  expect((await filtered('text=UNITEL')).total).toBe(3); // том жижиг үсэг үл ялгана
  expect((await filtered('amountMin=1000000&amountMax=1200000')).total).toBe(3); // зөвхөн цалин (Sales 900,000 < 1,000,000)
  expect((await filtered('dateFrom=2026-05-01&dateTo=2026-05-31')).total).toBe(9); // A: 6 · B: 3 (5-р сарын)
  expect((await filtered(`importJobId=${mbank?.id}`)).total).toBe(9);
  expect((await filtered('manualOverride=true')).total).toBe(0);
  const top = await filtered('sort=AMOUNT_DESC&limit=2');
  expect(top).toMatchObject({ total: 27, limit: 2, offset: 0, hasMore: true });
  expect(top.items.map((t) => t.amount)).toEqual([1_200_000, 1_200_000]);
  const next = await filtered('sort=AMOUNT_DESC&limit=2&offset=2');
  expect(next).toMatchObject({ offset: 2, page: 2 });
  expect(next.items.map((t) => t.amount)).toEqual([1_200_000, 900_000]);
  const newest = await filtered('sort=DATE_DESC&limit=1');
  expect(newest.items[0].txnDate).toBe('2026-06-30');
  expectMasked(await api.get(`/bsa/analyses/${id}/transactions?limit=1000`));

  // ── 6. Гараар ангилал солих (BSA-FR-3.3) ба «ижил утгатай бүгдэд» ──
  const rulesBefore = (await e.api.as('admin').get('/bsa/rules')).body as unknown[];
  const sales = await api.post(`/bsa/analyses/${id}/reclassify`, {
    transactionIds: [idOfDescription(all, 'Sales ZXQ-B04')], categoryCode: 'BUSINESS_INCOME', applyToSimilar: true,
  });
  expect(sales.status, JSON.stringify(sales.body)).toBe(200);
  // Sales 3 мөр: сонгосон 1 + ижил үндэстэй 2 · Sales → BUSINESS_INCOME (85 %): баталгаажсан 1,200,000 + 900,000×0.85 + 600,000×0.1 = 2,025,000
  // DTI орлого 2,025,000×0.9 = 1,822,500 · ӨОХ 500,000 / 1,822,500 = 27.43 % → 27.4 (LOW ≤ 35 %) · бизнесийн орлого 765,000
  expect(sales.body).toMatchObject({
    selected: 1, similar: 2, affected: 3, repushRequired: false,
    suggestedRule: { direction: 'INCOME', categoryCode: 'BUSINESS_INCOME', source: 'FEEDBACK', matchType: 'KEYWORD', priority: 500 },
    summary: { verifiedMonthlyIncome: 2_025_000, dtiIncome: 1_822_500, businessIncomeMonthly: 765_000, dtiPercent: 27.4, dtiLevel: 'LOW' },
  });
  // Санал болгосон дүрэм ХАДГАЛАГДААГҮЙ (BSA-FR-3.4: админ хянаж баталгаажуулна)
  expect(((await e.api.as('admin').get('/bsa/rules')).body as unknown[]).length).toBe(rulesBefore.length);

  const goods = await api.post(`/bsa/analyses/${id}/reclassify`, {
    transactionIds: [idOfDescription(all, 'Goods ZXQ-E04')], categoryCode: 'BUSINESS_EXPENSE', applyToSimilar: true,
  });
  expect(goods.body).toMatchObject({ affected: 3, selected: 1, similar: 2 });
  const loan = await api.post(`/bsa/analyses/${id}/reclassify`, {
    transactionIds: [idOfDescription(all, 'Loan payment ZXQ-L04')], categoryCode: 'LOAN_PAYMENT', applyToSimilar: true,
  });
  expect(loan.body).toMatchObject({ affected: 3 });
  const food = await api.post(`/bsa/analyses/${id}/reclassify`, {
    transactionIds: [idOfDescription(all, 'Food ZXQ-F04')], categoryCode: 'ESSENTIAL_EXPENSE', applyToSimilar: true,
  });
  expect(food.body).toMatchObject({ affected: 3 });
  // Бизнесийн зардал Goods 150,000 · ЦМУ 765,000 − 150,000 = 615,000 · өр (зээл) 400,000 · өрхийн зардал Food 100,000 + Unitel 80,000 = 180,000
  // ӨОХ = (500,000 + 400,000) / 1,822,500 = 49.38 % → 49.4 (MEDIUM)
  const afterManual = (food.body as { summary: Record<string, unknown> }).summary;
  expect(afterManual).toMatchObject({
    businessIncomeMonthly: 765_000, businessExpenseMonthly: 150_000, netCashFlowMonthly: 615_000, existingDebtServiceMonthly: 400_000,
    verifiedMonthlyIncome: 2_025_000, dtiIncome: 1_822_500, dtiPercent: 49.4, dtiLevel: 'MEDIUM',
  });
  expect((await filtered('manualOverride=true')).total).toBe(12);
  expect((await filtered('category=BUSINESS_INCOME')).items.map((t) => t.description).sort()).toEqual(['Sales ZXQ-B04', 'Sales ZXQ-B05', 'Sales ZXQ-B06']);
  // Алдаа: чиглэл таарахгүй ангилал, байхгүй гүйлгээ
  expectError(
    await api.post(`/bsa/analyses/${id}/reclassify`, { transactionIds: [idOfDescription(all, 'Salary ZXQ-S04')], categoryCode: 'LOAN_PAYMENT' }),
    400, 'CATEGORY_INVALID',
  );
  expectError(await api.post(`/bsa/analyses/${id}/reclassify`, { transactionIds: ['no-such-transaction'], categoryCode: 'SALARY' }), 404, 'TRANSACTION_NOT_FOUND');

  // ── 7. Санал болгосон төлбөр өөрчлөх → DTI дахин (INT-6, BSA-FR-4.1) ──
  // ӨОХ = (700,000 + 400,000) / 1,822,500 = 60.36 % → 60.4 (HIGH > 55 %, дээд хязгаараас давсан)
  const higher = await api.post(`/bsa/analyses/${id}/recalculate`, { proposedMonthlyPayment: 700_000 });
  expect(higher.status).toBe(200);
  expect(higher.body).toMatchObject({
    recalculated: true, reclassified: null, repushRequired: false,
    analysis: { proposedMonthlyPayment: 700_000 },
    summary: { dtiPercent: 60.4, dtiLevel: 'HIGH' },
    details: { dti: { proposedMonthlyPayment: 700_000, meetsLimit: false, maxDti: 0.55 } },
  });
  expect(higher.body.analysis.summary).toBeUndefined(); // хураангуй нэг л газар (summary)
  expect((higher.body.details as { dti: { dtiRatio: number } }).dti.dtiRatio).toBeCloseTo(1_100_000 / 1_822_500, 10);
  expectError(await api.post(`/bsa/analyses/${id}/recalculate`, { periodMonths: 5 }), 400, 'PERIOD_NOT_ALLOWED');
  expectError(await api.post(`/bsa/analyses/${id}/recalculate`, { proposedMonthlyPayment: -1 }), 400, 'VALIDATION_FAILED');
  expectError(await api.post(`/bsa/analyses/${id}/recalculate`, { unknownField: 1 }), 400, 'VALIDATION_FAILED');
  const back = await api.post(`/bsa/analyses/${id}/recalculate`, { proposedMonthlyPayment: 500_000 });
  expect(back.body.summary).toMatchObject({ dtiPercent: 49.4, dtiLevel: 'MEDIUM' });

  // ── 8. Орлого/зарлагын задаргаа ба аргачлал (BSA-FR-4.3/4.4) ──
  const breakdown = await api.get(`/bsa/analyses/${id}/breakdown`);
  expect(breakdown.status).toBe(200);
  const income = breakdown.body.income as { categories: Array<{ code: string; monthlyAvg: number; weightedMonthly: number; txnCount: number }>; monthlyAvgTotal: number; weightedMonthlyTotal: number };
  expect(income.categories.map((c) => [c.code, c.monthlyAvg, c.weightedMonthly])).toEqual([
    ['SALARY', 1_200_000, 1_200_000],
    ['BUSINESS_INCOME', 900_000, 765_000],
    ['OTHER_INCOME', 600_000, 60_000],
  ]);
  expect([income.monthlyAvgTotal, income.weightedMonthlyTotal]).toEqual([2_700_000, 2_025_000]);
  // зарлага/сар: зээл 400,000 + бизнесийн 150,000 + зайлшгүй 100,000 + тогтмол (Unitel) 80,000 + бусад (4 шимтгэл 3,000 ÷ 3) 1,000 = 731,000
  const expense = breakdown.body.expense as { categories: Array<{ code: string; monthlyAvg: number }>; monthlyAvgTotal: number };
  expect(expense.monthlyAvgTotal).toBe(731_000);
  expect(expense.categories.map((c) => c.code)).toEqual(['LOAN_PAYMENT', 'BUSINESS_EXPENSE', 'ESSENTIAL_EXPENSE', 'FIXED_EXPENSE', 'OTHER_EXPENSE']);
  const methodology = breakdown.body.methodology as Array<{ step: number; key: string; value: number }>;
  expect(methodology.map((m) => m.step)).toEqual(methodology.map((_, i) => i + 1));
  expect(methodology.find((m) => m.key === 'dti_ratio')?.value).toBe(49.4);
  expect(methodology.find((m) => m.key === 'cogs_adjustment')?.value).toBe(1_822_500);
  const withEmpty = await api.get(`/bsa/analyses/${id}/breakdown?includeEmpty=true`);
  expect((withEmpty.body.income.categories as unknown[]).length).toBeGreaterThan(income.categories.length);

  // ── 9. Системрүү татах (INT-4 / INT-5) ──
  expectError(await api.get(`/bsa/analyses/${id}/scoring-input`), 409, 'NOT_ANALYZED');
  expect((await api.get(`/bsa/analyses/${id}/summary`)).body).toMatchObject({ status: 'DRAFT', dtiPercent: 49.4 });
  const finalized = await api.post(`/bsa/analyses/${id}/finalize`);
  expect(finalized.status, JSON.stringify(finalized.body)).toBe(200);
  expect(finalized.body).toMatchObject({
    firstTime: true,
    warnings: expect.any(Array),
    summary: { status: 'ANALYZED', dtiPercent: 49.4, dtiLevel: 'MEDIUM', transactionCount: 27, existingDebtServiceMonthly: 400_000, netCashFlowMonthly: 615_000 },
  });
  expect(typeof finalized.body.pushedToLosAt).toBe('string');
  const again = await api.post(`/bsa/analyses/${id}/finalize`);
  expect(again.body).toMatchObject({ firstTime: false, summary: { status: 'ANALYZED' } });
  const stored = await api.get(`/bsa/analyses/${id}/summary`);
  expect(stored.status).toBe(200);
  expect(stored.body).toEqual(finalized.body.summary);
  const scoring = await api.get(`/bsa/analyses/${id}/scoring-input`);
  expect(scoring.status).toBe(200);
  expect(scoring.body.input).toMatchObject({
    analysisId: id, loanApplicationId: 'app-1', borrowerId: 'bor-1', status: 'ANALYZED', periodMonths: 3, transactionCount: 27,
    businessIncomeMonthly: 765_000, businessExpenseMonthly: 150_000, businessNcfMonthly: 615_000, householdExpenseMonthly: 180_000,
    existingDebtServiceMonthly: 400_000, verifiedMonthlyIncome: 2_025_000, dtiIncomeMonthly: 1_822_500, dtiPercent: 49.4, pendingSuspiciousCount: 0,
  });
  expect(scoring.body.patch).toMatchObject({
    scoreRequest: { businessNcfMonthly: 615_000, existingDebtServiceMonthly: 400_000, householdExpenseMonthly: 180_000 },
    sosco: { dtiPercent: 49.4, pendingSuspiciousCount: 0 },
  });

  // ANALYZED болсны дараа: файл нэмэх / устгах боломжгүй; параметр өөрчилбөл LOS руу дахин татах шаардлагатай
  expectError(await api.upload(id, [a]), 409, 'ANALYSIS_NOT_DRAFT');
  expectError(await api.del(`/bsa/analyses/${id}`), 409, 'ANALYSIS_NOT_DRAFT');
  const repush = await api.post(`/bsa/analyses/${id}/recalculate`, { proposedMonthlyPayment: 600_000 });
  // (600,000 + 400,000) / 1,822,500 = 54.87 % → 54.9 (MEDIUM: ≤ 55 %)
  expect(repush.body).toMatchObject({ repushRequired: true, summary: { dtiPercent: 54.9, dtiLevel: 'MEDIUM' } });
  return { analysisId: id, jobs };
}

/** Үүрэг тус бүрийн унших эрх (бүтэн урсгалын дараа, ANALYZED шинжилгээ дээр) — ЗЭЗ-ийн салбар br-1 */
export async function expectReadScopes(e: E2eApp, analysisId: string): Promise<void> {
  const path = `/bsa/analyses/${analysisId}`;
  for (const who of ['officer', 'manager', 'approver', 'admin'] as const) {
    expect((await e.api.as(who).get(path)).status, `${who} reads`).toBe(200);
  }
  expect((await e.api.as('officer2').get(path)).status).toBe(403); // ижил салбар, өөр ЗЭЗ
  expect((await e.api.as('managerOtherBranch').get(path)).status).toBe(403); // өөр салбар
  expect((await e.api.as('officerOtherBranch').get(path)).status).toBe(403);
  expectError(await e.api.as('otherOrgAdmin').get(path), 404, 'NOT_FOUND'); // өөр байгууллага: оршихыг ил гаргахгүй
}
