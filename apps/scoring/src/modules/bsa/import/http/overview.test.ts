// Тойм / задаргааны цэвэр бүтээгч: анхааруулгын эрэмбэ, ажлын анхааруулгыг кодоор нэгтгэх, хоосон ангиллыг нуух.
import type { BsaAnalysisDetails, BsaSummary } from '@los/contracts';
import { describe, expect, it } from 'vitest';
import type { AnalysisView, ImportJobView } from '../views';
import { buildBreakdown, buildOverview } from './overview';

const issue = (code: string, severity: 'ERROR' | 'WARNING' = 'WARNING') => ({ code, message: `msg ${code}`, severity });
const job = (id: string, over: Partial<ImportJobView> = {}): ImportJobView =>
  ({ id, analysisId: 'a1', errors: [], warnings: [], status: 'COMPLETED', ...over }) as unknown as ImportJobView;
const summary = { analysisId: 'a1', status: 'DRAFT', dtiPercent: 41.2 } as unknown as BsaSummary;
const analysis = { id: 'a1', status: 'DRAFT', summary } as unknown as AnalysisView;
const counts = { PENDING: 0, PROCESSING: 0, COMPLETED: 2, FAILED: 0 };
const txCounts = { total: 27, income: 10, expense: 17, ownTransfers: 2, manualOverrides: 1, unclassified: 0, extra: 'ignored' } as never;

const category = (code: string, direction: 'INCOME' | 'EXPENSE', monthlyAvg: number, weightedMonthly: number, txnCount: number) =>
  ({ code, direction, monthlyAvg, weightedMonthly, txnCount }) as BsaAnalysisDetails['categories'][number];

function details(over: Partial<BsaAnalysisDetails> = {}): BsaAnalysisDetails {
  return {
    analysisId: 'a1',
    computedAt: '2026-07-15T09:00:00.000Z',
    period: { from: '2026-04-01', to: '2026-06-30', months: 3 },
    categories: [],
    methodology: [{ step: 1, key: 'period_months', value: 3 }],
    dti: { dtiRatio: 0.4 },
    otherShare: [],
    transactions: { inPeriod: 27 },
    warnings: [],
    ...over,
  } as unknown as BsaAnalysisDetails;
}

describe('buildOverview', () => {
  it('splits the stored summary from the analysis meta and keeps only the documented transaction counters', () => {
    const o = buildOverview({
      analysis, report: { summary, details: details(), summaryStale: true },
      jobs: { items: [], total: 0, counts }, history: { items: [], total: 0 }, transactions: txCounts,
    });
    expect(o.analysis).not.toHaveProperty('summary');
    expect(o.summary).toBe(summary);
    expect(o.summaryStale).toBe(true);
    expect(o.transactions).toEqual({ total: 27, income: 10, expense: 17, ownTransfers: 2, manualOverrides: 1, unclassified: 0 });
  });

  it('orders warnings: errors first, analysis scope before job scope, then by code', () => {
    const o = buildOverview({
      analysis,
      report: { summary: null, details: details({ warnings: [{ code: 'B_ANALYSIS', message: 'm' }, { code: 'A_ANALYSIS', message: 'm' }] }), summaryStale: false },
      jobs: { items: [job('j1', { warnings: [issue('Z_JOB')], errors: [issue('E_JOB', 'ERROR')] })], total: 1, counts },
      history: { items: [], total: 0 }, transactions: txCounts,
    });
    expect(o.warnings.map((w) => `${w.severity}:${w.scope}:${w.code}`)).toEqual([
      'ERROR:JOB:E_JOB',
      'WARNING:ANALYSIS:A_ANALYSIS',
      'WARNING:ANALYSIS:B_ANALYSIS',
      'WARNING:JOB:Z_JOB',
    ]);
  });

  it('merges the same job warning code across jobs and lists the affected job ids', () => {
    const o = buildOverview({
      analysis, report: { summary: null, details: null, summaryStale: false },
      jobs: { items: [job('j1', { warnings: [issue('UNVERIFIED_PARSER')] }), job('j2', { warnings: [issue('UNVERIFIED_PARSER')] }), job('j3')], total: 3, counts },
      history: { items: [], total: 0 }, transactions: txCounts,
    });
    expect(o.warnings).toEqual([{ code: 'UNVERIFIED_PARSER', message: 'msg UNVERIFIED_PARSER', severity: 'WARNING', scope: 'JOB', jobIds: ['j1', 'j2'] }]);
    expect(o.details).toBeNull();
  });

  it('keeps an error and a warning with the same code separate', () => {
    const o = buildOverview({
      analysis, report: { summary: null, details: null, summaryStale: false },
      jobs: { items: [job('j1', { errors: [issue('X', 'ERROR')] }), job('j2', { warnings: [issue('X')] })], total: 2, counts },
      history: { items: [], total: 0 }, transactions: txCounts,
    });
    expect(o.warnings.map((w) => [w.severity, w.jobIds])).toEqual([['ERROR', ['j1']], ['WARNING', ['j2']]]);
  });
});

describe('buildBreakdown', () => {
  const cats = [
    category('SALARY', 'INCOME', 1_200_000, 1_200_000, 3),
    category('BUSINESS_INCOME', 'INCOME', 900_000, 765_000, 3),
    category('CASH_INCOME', 'INCOME', 0, 0, 0),
    category('LOAN_PAYMENT', 'EXPENSE', 400_000, 400_000, 3),
    category('OTHER_EXPENSE', 'EXPENSE', 333.333, 333.333, 1),
    category('BANK_FEE', 'EXPENSE', 0, 0, 0),
  ];

  it('splits by direction, hides empty categories and totals the monthly figures', () => {
    const b = buildBreakdown(details({ categories: cats }), false, false);
    expect(b.income.categories.map((c) => c.code)).toEqual(['SALARY', 'BUSINESS_INCOME']);
    expect([b.income.monthlyAvgTotal, b.income.weightedMonthlyTotal, b.income.txnCount]).toEqual([2_100_000, 1_965_000, 6]);
    expect(b.expense.categories.map((c) => c.code)).toEqual(['LOAN_PAYMENT', 'OTHER_EXPENSE']);
    expect([b.expense.monthlyAvgTotal, b.expense.txnCount]).toEqual([400_333.33, 4]); // 2 орны нарийвчлалд бөөрөнхийлнө
    expect(b.summaryStale).toBe(false);
  });

  it('includes empty categories on request and passes the methodology through', () => {
    const b = buildBreakdown(details({ categories: cats }), true, true);
    expect(b.income.categories).toHaveLength(3);
    expect(b.expense.categories).toHaveLength(3);
    expect(b.summaryStale).toBe(true);
    expect(b.methodology).toEqual([{ step: 1, key: 'period_months', value: 3 }]);
    expect(b.period).toEqual({ from: '2026-04-01', to: '2026-06-30', months: 3 });
  });
});
