import {
  BsaAnalysisDetails, BsaLosOverview, BsaLosPushResponse, BsaResolveSuspicionsRequest, BsaSuspicionListResponse, BsaSummary, SuspicionFlag,
  type BsaSuspicionView, type ReviewStatus,
} from '@los/contracts';
import type { MockApi } from './mock-api';

// BSA (дансны хуулгын шинжилгээ) e2e: origination `/applications/:id/bsa…` ба scoring `/scoring/bsa/…` дуудлагуудыг санах ойн төлөвтэйгөөр дууриана.
// Хэлбэрүүд нь `@los/contracts`-ийн zod схемээр баталгаажна (scoring-ийн ImportJobView / BsaCategoryDef-д схем байхгүй тул энд гараар).

export const APP_ID = '00000000-0000-4000-8000-0000000000b5';
export const ANALYSIS_ID = 'an-1';
export const OVERVIEW_URL = `/los/bsa/${APP_ID}`;
export const ANALYSIS_URL = `/los/bsa/${APP_ID}/${ANALYSIS_ID}`;
export const SC = `/scoring/bsa/analyses/${ANALYSIS_ID}`;
export const BANK_NOT_DETECTED_MESSAGE = 'Хуулгын банкийг таньж чадсангүй. Банкаа гараар сонгоод дахин оруулна уу.';

export interface JobFixture {
  id: string; analysisId: string; fileName: string; status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED'; bankCode: string | null;
  errors: { code: string; message: string }[];
}
export interface CategoryFixture { code: string; direction: 'INCOME' | 'EXPENSE'; groupCode: string; name: string; weight: number; dtiRole: string; isActive: boolean }

export const CATEGORIES: CategoryFixture[] = [
  { code: 'SALARY', direction: 'INCOME', groupCode: 'A', name: 'Хөдөлмөрийн орлого (цалин)', weight: 1, dtiRole: 'INCOME', isActive: true },
  { code: 'OTHER_INCOME', direction: 'INCOME', groupCode: '?', name: 'Бусад орлого', weight: 0.1, dtiRole: 'INCOME', isActive: true },
  { code: 'LOAN_PROCEEDS', direction: 'INCOME', groupCode: '—', name: 'Зээл (авсан зээлийн олголт)', weight: 0, dtiRole: 'INCOME', isActive: true },
  { code: 'NON_INCOME', direction: 'INCOME', groupCode: '—', name: 'Орлого бус (буцаалт, залруулга)', weight: 0, dtiRole: 'INCOME', isActive: true },
  { code: 'LOAN_PAYMENT', direction: 'EXPENSE', groupCode: 'A', name: 'Зээлийн төлбөр', weight: 1, dtiRole: 'DEBT_SERVICE', isActive: true },
  { code: 'OTHER_EXPENSE', direction: 'EXPENSE', groupCode: '?', name: 'Бусад зардал', weight: 1, dtiRole: 'INFO', isActive: true },
  { code: 'OLD_EXPENSE', direction: 'EXPENSE', groupCode: 'F', name: 'Хуучин идэвхгүй ангилал', weight: 1, dtiRole: 'INFO', isActive: false },
];

export interface BsaWorld {
  status: 'DRAFT' | 'ANALYZED';
  /** Хүсэлтийн ЭТХ-ээс санал болгосон сарын төлбөр (null = тооцох боломжгүй). */
  proposedMonthlyPayment: number | null;
  jobs: JobFixture[];
  suspicions: BsaSuspicionView[];
  warnings: { code: string; message: string; severity: 'ERROR' | 'WARNING'; scope: 'ANALYSIS' | 'JOB' }[];
  summaryStale: boolean;
  uploads: { contentType: string; raw: string }[];
  retries: { id: string; body: unknown }[];
  resolves: unknown[];
  pushes: string[];
}

const txn = (id: string, o: Partial<BsaSuspicionView['transactions'][number]> = {}): BsaSuspicionView['transactions'][number] => ({
  id, txnDate: '2026-09-12', txnTime: '10:15:00', direction: 'INCOME', amount: 12_000_000, description: 'Урьдчилгаа', counterpartyAccount: '****4821', categoryCode: 'OTHER_INCOME', ...o,
});

export const SUSPICIONS: BsaSuspicionView[] = [
  {
    id: 's-income', flag: 'OWN_ACCOUNT', status: 'PENDING', action: null, confidence: 85, comment: null, resolvedBy: null, resolvedAt: null, firstDate: '2026-09-12', totalAmount: 12_000_000,
    transactionIds: ['t1'], transactions: [txn('t1')],
  },
  {
    id: 's-pair', flag: 'CIRCULAR', status: 'PENDING', action: null, confidence: 92, comment: null, resolvedBy: null, resolvedAt: null, firstDate: '2026-09-20', totalAmount: 24_000_000,
    transactionIds: ['t2', 't3'],
    transactions: [
      txn('t2', { txnDate: '2026-09-20', amount: 12_000_000, description: 'Зээл олголт', counterpartyAccount: '****9910', categoryCode: 'OTHER_INCOME' }),
      txn('t3', { txnDate: '2026-09-20', direction: 'EXPENSE', amount: 12_000_000, description: '', counterpartyAccount: null, categoryCode: 'OTHER_EXPENSE' }),
    ],
  },
  {
    id: 's-quick', flag: 'QUICK_CASH', status: 'PENDING', action: null, confidence: null, comment: null, resolvedBy: null, resolvedAt: null, firstDate: '2026-09-25', totalAmount: 3_000_000,
    transactionIds: ['t4'], transactions: [txn('t4', { txnDate: '2026-09-25', amount: 3_000_000, description: 'Бэлэн мөнгө', counterpartyAccount: null, categoryCode: null })],
  },
  {
    id: 's-gamble', flag: 'GAMBLING', status: 'PENDING', action: null, confidence: 70, comment: null, resolvedBy: null, resolvedAt: null, firstDate: '2026-09-28', totalAmount: 500_000,
    transactionIds: ['t5'], transactions: [txn('t5', { txnDate: '2026-09-28', direction: 'EXPENSE', amount: 500_000, description: 'Бооцоо', counterpartyAccount: '****7777', categoryCode: 'OTHER_EXPENSE' })],
  },
];

export const FAILED_JOB: JobFixture = {
  id: 'job-1', analysisId: ANALYSIS_ID, fileName: 'statement-sep.pdf', status: 'FAILED', bankCode: null,
  errors: [{ code: 'BANK_NOT_DETECTED', message: BANK_NOT_DETECTED_MESSAGE }],
};

export function newBsaWorld(o: Partial<BsaWorld> = {}): BsaWorld {
  return {
    status: 'DRAFT', proposedMonthlyPayment: 450_000, jobs: [], suspicions: SUSPICIONS.map((s) => ({ ...s })), uploads: [], retries: [], resolves: [], pushes: [],
    warnings: [
      { code: 'COVERAGE_SHORTFALL', message: '2 сарын хуулга дутуу байна.', severity: 'WARNING', scope: 'ANALYSIS' },
      { code: 'OTHER_SHARE_EXCEEDED', message: '«Бусад» ангилал зарлагын 50.7% байна (босго 30%). Ангиллыг шалгана уу.', severity: 'WARNING', scope: 'ANALYSIS' },
    ],
    summaryStale: false, ...o,
  };
}

const summary = (w: BsaWorld) => BsaSummary.parse({
  analysisId: ANALYSIS_ID, loanApplicationId: APP_ID, borrowerId: 'c1', status: w.status, version: 1, periodMonths: 6, periodFrom: '2026-04-01', periodTo: '2026-09-30', transactionCount: 120,
  totalMonthlyIncome: 3_000_000, verifiedMonthlyIncome: 2_800_000, dtiIncome: 2_800_000, businessIncomeMonthly: 0, businessExpenseMonthly: 0, netCashFlowMonthly: 0,
  existingDebtServiceMonthly: 480_000, incomeReliability: 100, dtiPercent: 17, dtiLevel: 'LOW', pendingSuspiciousCount: w.suspicions.filter((s) => s.status === 'PENDING').length, reportPdfUrl: null,
});

const details = () => BsaAnalysisDetails.parse({
  analysisId: ANALYSIS_ID, computedAt: '2026-11-20T03:00:00.000Z',
  period: { from: '2026-04-01', to: '2026-09-30', months: 6, mode: 'AUTO', requestedMonths: null, clamped: false },
  coverage: { requiredFrom: '2026-04-01', requiredTo: '2026-09-30', requiredMonths: 6, coveredMonths: 4, shortfallMonths: 2, missingMonths: ['2026-04', '2026-05'], gaps: [], accountGaps: [], overlaps: [] },
  otherShare: [{ direction: 'EXPENSE', otherAmount: 507_000, totalAmount: 1_000_000, share: 0.507, exceeded: true }],
  warnings: [],
  transactions: { inPeriod: 120, ownTransfers: 4, outOfPeriod: 0, manualOverrides: 0 },
  dti: { dtiRatio: 0.179, meetsLimit: true, maxDti: 0.55, costOfGoodsRate: 0.6, proposedMonthlyPayment: 450_000, householdExpenseMonthly: 300_000 },
  categories: [
    { code: 'SALARY', name: 'Хөдөлмөрийн орлого (цалин)', direction: 'INCOME', groupCode: 'A', weight: 1, dtiRole: 'INCOME', totalAmount: 16_800_000, monthlyAvg: 2_800_000, weightedMonthly: 2_800_000, monthsPresent: 6, txnCount: 6, share: 0.93 },
    { code: 'OTHER_EXPENSE', name: 'Бусад зардал', direction: 'EXPENSE', groupCode: '?', weight: 1, dtiRole: 'INFO', totalAmount: 507_000, monthlyAvg: 84_500, weightedMonthly: 84_500, monthsPresent: 5, txnCount: 11, share: 0.507 },
  ],
  methodology: [
    { step: 1, key: 'salary_monthly', label: 'Цалингийн сарын дундаж', formula: 'Σ цалин / сар', inputs: { total: 16_800_000, months: 6 }, value: 2_800_000 },
    { step: 2, key: 'dti_ratio', label: 'ӨОХ-ийн харьцаа', formula: '(өр + санал болгосон төлбөр) / орлого', inputs: { debt: 480_000 }, value: 0.179 },
  ],
});

function counts(items: BsaSuspicionView[]) {
  const byFlag = Object.fromEntries(SuspicionFlag.map((f) => [f, { total: items.filter((s) => s.flag === f).length, pending: items.filter((s) => s.flag === f && s.status === 'PENDING').length }]));
  const pending = items.filter((s) => s.status === 'PENDING').length;
  return { total: items.length, pending, resolved: items.length - pending, byFlag };
}

/** origination + scoring дуудлагуудыг `world`-д холбоно. Mutable `world`-ийг тест дундаас шалгана. */
export function installBsa(api: MockApi, world: BsaWorld): void {
  const overview = () => BsaLosOverview.parse({
    applicationId: APP_ID, summary: null, proposedMonthlyPayment: world.proposedMonthlyPayment, available: true, editable: world.status === 'DRAFT',
    borrowers: [{
      customerId: 'c1', role: 'PRIMARY', displayName: 'Номин Дашдорж', analysisId: ANALYSIS_ID, status: world.status, version: 1, dtiPercent: 17,
      pendingSuspiciousCount: world.suspicions.filter((s) => s.status === 'PENDING').length,
    }],
  });
  api.get('/applications/:id/bsa', () => ({ json: overview() }));
  api.post('/applications/:id/bsa/analyses/:aid/push', ({ params }) => {
    world.pushes.push(params.aid ?? '');
    world.status = 'ANALYZED';
    return { json: BsaLosPushResponse.parse({ summary: {}, warnings: [], reportAttached: true }) };
  });

  api.get(SC, () => ({
    json: {
      analysis: { id: ANALYSIS_ID, applicationId: APP_ID, customerId: 'c1', status: world.status, version: 1 },
      summary: summary(world), summaryStale: world.summaryStale, details: details(), warnings: world.warnings,
      jobs: { items: world.jobs, total: world.jobs.length, counts: {} }, history: { items: [], total: 0 }, transactions: { total: 120, income: 60, expense: 60, ownTransfers: 4, manualOverrides: 0, unclassified: 0 },
    },
  }));
  api.get(`${SC}/imports`, () => ({ json: { items: world.jobs, total: world.jobs.length } }));
  api.post(`${SC}/imports`, ({ body, headers }) => {
    world.uploads.push({ contentType: headers['content-type'] ?? '', raw: typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: 202, json: { outcomes: [], accepted: 1, duplicates: 0, rejected: 0 } };
  });
  api.post(`${SC}/recalculate`, { json: {} });
  api.post('/scoring/bsa/jobs/:id/retry', ({ params, body }) => {
    world.retries.push({ id: params.id ?? '', body });
    world.jobs = world.jobs.map((j) => (j.id === params.id ? { ...j, status: 'PENDING', errors: [] } : j));
    return { status: 202, json: world.jobs.find((j) => j.id === params.id) ?? {} };
  });
  api.get(`${SC}/suspicions`, ({ search }) => {
    const status = search.get('status') as ReviewStatus | null;
    const flag = search.get('flag');
    const items = world.suspicions.filter((s) => (!status || s.status === status) && (!flag || s.flag === flag));
    return { json: BsaSuspicionListResponse.parse({ items, total: items.length, offset: 0, limit: 100, counts: counts(world.suspicions) }) };
  });
  api.post(`${SC}/suspicions/resolve`, ({ body }) => {
    const req = BsaResolveSuspicionsRequest.parse(body);
    world.resolves.push(req);
    world.suspicions = world.suspicions.map((s) => (req.ids.includes(s.id) ? { ...s, status: 'RESOLVED', action: req.action } : s));
    return { json: { updated: req.ids.length } };
  });
  api.get('/scoring/bsa/categories', () => ({ json: CATEGORIES }));
}
