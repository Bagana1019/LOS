// buildBsaSummary / buildScoringInput (INT-4, INT-5): contracts-ийн zod схемээр баталгаажна. Тооцоолол ЭНД ДУУДАГДАХГҮЙ — литерал үр дүн.
import { describe, expect, it } from 'vitest';
import type { BsaDtiResult } from '@los/calc';
import { BsaScoringInput, BsaSummary } from '@los/contracts';
import { buildBsaSummary, buildScoringInput, type BsaSummaryInput } from './summary.builder';

/** docs/02 §7-ийн жишээ тоонууд (синтетик) */
const DTI_RESULT: BsaDtiResult = {
  periodMonths: 6,
  monthKeys: ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'],
  totalMonthlyIncome: 38_320_471,
  verifiedMonthlyIncome: 16_315_866,
  dtiIncome: 14_684_279,
  businessIncomeMonthly: 15_453_133,
  businessExpenseMonthly: 247_311,
  netCashFlowMonthly: 15_205_822,
  existingDebtServiceMonthly: 1_000_000,
  householdExpenseMonthly: 2_100_500,
  incomeReliability: 100,
  dtiRatio: 0.068,
  dtiPercent: 6.8,
  dtiLevel: 'LOW',
  meetsLimit: true,
  categories: [],
  methodology: [],
};

const INPUT: BsaSummaryInput = {
  analysis: {
    analysisId: '7f1c2a9e-0000-4000-8000-000000000001', loanApplicationId: '4118', borrowerId: '1', status: 'ANALYZED', version: 2,
    periodFrom: '2026-03-10', periodTo: '2026-09-10',
  },
  dtiResult: DTI_RESULT,
  transactionCount: 2483,
  pendingSuspiciousCount: 250,
  reportPdfUrl: 'https://example.invalid/bsa/report.pdf',
};

describe('buildBsaSummary (INT-4)', () => {
  it('maps the DTI result onto the BSA → LOS contract and passes the zod schema', () => {
    const s = buildBsaSummary(INPUT);
    expect(BsaSummary.safeParse(s).success).toBe(true);
    expect(s).toEqual({
      analysisId: '7f1c2a9e-0000-4000-8000-000000000001', loanApplicationId: '4118', borrowerId: '1', status: 'ANALYZED', version: 2,
      periodMonths: 6, periodFrom: '2026-03-10', periodTo: '2026-09-10', transactionCount: 2483,
      totalMonthlyIncome: 38_320_471, verifiedMonthlyIncome: 16_315_866, dtiIncome: 14_684_279,
      businessIncomeMonthly: 15_453_133, businessExpenseMonthly: 247_311, netCashFlowMonthly: 15_205_822,
      existingDebtServiceMonthly: 1_000_000, incomeReliability: 100, dtiPercent: 6.8, dtiLevel: 'LOW',
      pendingSuspiciousCount: 250, reportPdfUrl: 'https://example.invalid/bsa/report.pdf',
    });
  });

  it('accepts a DRAFT analysis and a null PDF url', () => {
    const s = buildBsaSummary({ ...INPUT, analysis: { ...INPUT.analysis, status: 'DRAFT' }, reportPdfUrl: null });
    expect(s).toMatchObject({ status: 'DRAFT', reportPdfUrl: null });
    expect(BsaSummary.safeParse(s).success).toBe(true);
  });

  it('a capped DTI (Infinity ratio) still produces a valid, finite summary', () => {
    const s = buildBsaSummary({ ...INPUT, dtiResult: { ...DTI_RESULT, dtiRatio: Number.POSITIVE_INFINITY, dtiPercent: 999.9, dtiLevel: 'HIGH', meetsLimit: false } });
    expect(s).toMatchObject({ dtiPercent: 999.9, dtiLevel: 'HIGH' });
  });

  it('does not leak extra DTI result fields (categories, methodology) into the LOS contract', () => {
    const s = buildBsaSummary({ ...INPUT, dtiResult: { ...DTI_RESULT, categories: [{ code: 'X' } as never], methodology: [{ step: 1 } as never] } });
    expect(Object.keys(s)).not.toContain('categories');
    expect(Object.keys(s)).not.toContain('methodology');
    expect(Object.keys(s)).not.toContain('householdExpenseMonthly');
  });

  it('is pure: does not mutate its input', () => {
    const before = JSON.stringify(INPUT);
    buildBsaSummary(INPUT);
    expect(JSON.stringify(INPUT)).toBe(before);
  });

  it.each([
    ['negative transactionCount', { transactionCount: -1 }],
    ['fractional transactionCount', { transactionCount: 1.5 }],
    ['negative pendingSuspiciousCount', { pendingSuspiciousCount: -3 }],
    ['NaN pendingSuspiciousCount', { pendingSuspiciousCount: Number.NaN }],
  ])('rejects %s', (_n, over) => {
    expect(() => buildBsaSummary({ ...INPUT, ...over })).toThrow(RangeError);
    expect(() => buildScoringInput({ ...INPUT, ...over })).toThrow(RangeError);
  });

  it('rejects version < 1 and non-finite DTI figures', () => {
    expect(() => buildBsaSummary({ ...INPUT, analysis: { ...INPUT.analysis, version: 0 } })).toThrow(RangeError);
    expect(() => buildBsaSummary({ ...INPUT, dtiResult: { ...DTI_RESULT, dtiIncome: Number.NaN } })).toThrow(RangeError);
    expect(() => buildBsaSummary({ ...INPUT, dtiResult: { ...DTI_RESULT, dtiPercent: Number.POSITIVE_INFINITY } })).toThrow(RangeError);
  });

  it('the zod contract rejects an unsupported status or level (defence in depth)', () => {
    expect(() => buildBsaSummary({ ...INPUT, analysis: { ...INPUT.analysis, status: 'DONE' as never } })).toThrow();
    expect(() => buildBsaSummary({ ...INPUT, dtiResult: { ...DTI_RESULT, dtiLevel: 'EXTREME' as never } })).toThrow();
  });
});

describe('buildScoringInput (INT-5)', () => {
  it('maps onto BsaScoringInput: ЦМУ → businessNcfMonthly, DTI орлого → dtiIncomeMonthly, household expense included', () => {
    const s = buildScoringInput(INPUT);
    expect(BsaScoringInput.safeParse(s).success).toBe(true);
    expect(s).toEqual({
      analysisId: '7f1c2a9e-0000-4000-8000-000000000001', loanApplicationId: '4118', borrowerId: '1', version: 2, status: 'ANALYZED',
      periodMonths: 6, transactionCount: 2483,
      businessIncomeMonthly: 15_453_133, businessExpenseMonthly: 247_311, businessNcfMonthly: 15_205_822,
      householdExpenseMonthly: 2_100_500, existingDebtServiceMonthly: 1_000_000,
      verifiedMonthlyIncome: 16_315_866, dtiIncomeMonthly: 14_684_279, dtiPercent: 6.8, incomeReliability: 100, pendingSuspiciousCount: 250,
    });
  });

  it('shares its figures with the summary (one source of truth)', () => {
    const summary = buildBsaSummary(INPUT);
    const scoring = buildScoringInput(INPUT);
    expect(scoring.dtiPercent).toBe(summary.dtiPercent);
    expect(scoring.incomeReliability).toBe(summary.incomeReliability);
    expect(scoring.pendingSuspiciousCount).toBe(summary.pendingSuspiciousCount);
    expect(scoring.businessNcfMonthly).toBe(summary.netCashFlowMonthly);
    expect(scoring.dtiIncomeMonthly).toBe(summary.dtiIncome);
  });

  it('keeps a negative net cash flow (business loses money) as is', () => {
    const s = buildScoringInput({ ...INPUT, dtiResult: { ...DTI_RESULT, netCashFlowMonthly: -120_000.5 } });
    expect(s.businessNcfMonthly).toBe(-120_000.5);
  });
});
