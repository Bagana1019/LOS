import { describe, expect, it } from 'vitest';
import { DecisionRisk, type CollateralListResponse } from '@los/contracts';
import type { CalcSnapshot } from '../score/score.rules';
import { buildDecisionRisk, type DecisionRiskInput } from './decision-risk';

// F3-1: батлагчид эрсдэлийн үзүүлэлт харагдах ёстой. Энэ нь ЦЭВЭР уншигч: хадгалагдсан үр дүнг (тооцооллын товч, барьцааны хураангуй, орлого) хөрвүүлнэ, юу ч тооцохгүй.
const snapshot = (o: Partial<CalcSnapshot> = {}): CalcSnapshot => ({
  calculationId: 'calc-1', selectedMethod: 'A_SALARY', selection: 'AUTO', ratioKind: 'DTI', ratio: 0.4321, limit: 0.55, pass: true, eligible: true, ltv: 0.5,
  soscoScore: 712, soscoGrade: 'B', computedAt: '2026-11-20T03:00:00.000Z', syncedAt: '2026-11-20T03:00:00.000Z', ...o,
});
const collateral = (o: { summary?: Partial<CollateralListResponse['summary']>; issues?: CollateralListResponse['gate']['issues']; warnings?: CollateralListResponse['warnings'] } = {}): DecisionRiskInput['collateral'] => ({
  summary: { count: 2, totalMarketValue: 100_000_000, totalCollateralValue: 80_000_000, loanAmount: 40_000_000, ltv: 0.5, ltvLimit: 0.7, ltvPass: true, requiresCollateral: true, ...o.summary },
  gate: { complete: !o.issues?.length, skipped: false, issues: o.issues ?? [], evaluatedAt: '2026-11-21T00:00:00.000Z' },
  warnings: o.warnings ?? [],
});
const input = (o: Partial<DecisionRiskInput> = {}): DecisionRiskInput => ({
  snapshot: snapshot(), scoreStep: { status: 'COMPLETED', staleReason: null }, collateral: collateral(),
  income: { salaryMonthly: 2_500_000, businessNcfMonthly: 0, householdExpenseMonthly: 400_000 }, ...o,
});

describe('buildDecisionRisk (F3-1)', () => {
  it('хадгалагдсан үзүүлэлтүүдийг шууд дамжуулна: арга, ӨОХ, LTV, Sosco, барьцаа, орлого', () => {
    const r = buildDecisionRisk(input());
    expect(r).toMatchObject({
      method: 'A_SALARY', selection: 'AUTO', computedAt: '2026-11-20T03:00:00.000Z', stale: false,
      ratio: { kind: 'DTI', value: 0.4321, limit: 0.55, pass: true },
      ltv: { value: 0.5, limit: 0.7, pass: true },
      sosco: { score: 712, grade: 'B' },
      collateral: { count: 2, totalValue: 80_000_000, required: true },
      income: { salaryMonthly: 2_500_000, businessNcfMonthly: 0, householdExpenseMonthly: 400_000 },
      flags: [],
    });
    expect(DecisionRisk.safeParse(r).success).toBe(true);
  });

  it('B/C арга: ӨТЧХ (DSCR) харьцаа ба хязгаар', () => {
    const r = buildDecisionRisk(input({ snapshot: snapshot({ selectedMethod: 'B_BUSINESS', selection: 'MANUAL', ratioKind: 'DSCR', ratio: 1.8, limit: 1.25 }) }));
    expect(r.method).toBe('B_BUSINESS');
    expect(r.selection).toBe('MANUAL');
    expect(r.ratio).toEqual({ kind: 'DSCR', value: 1.8, limit: 1.25, pass: true });
  });

  it('ӨОХ хязгаараас хэтэрвэл error анхааруулга (DTI_ABOVE_LIMIT), ӨТЧХ доод хязгаараас бага бол DSCR_BELOW_MIN', () => {
    const dti = buildDecisionRisk(input({ snapshot: snapshot({ ratio: 0.61, pass: false, eligible: false }) }));
    expect(dti.flags).toEqual([{ code: 'DTI_ABOVE_LIMIT', level: 'error', message: expect.any(String) }]);
    const dscr = buildDecisionRisk(input({ snapshot: snapshot({ selectedMethod: 'C_COMBINED', ratioKind: 'DSCR', ratio: 1.1, limit: 1.25, pass: false, eligible: false }) }));
    expect(dscr.flags.map((f) => f.code)).toEqual(['DSCR_BELOW_MIN']);
  });

  it('score алхам STALE бол stale=true ба CALCULATION_STALE анхааруулга (шалтгаантай)', () => {
    const r = buildDecisionRisk(input({ scoreStep: { status: 'STALE', staleReason: 'Дүн өөрчлөгдсөн' } }));
    expect(r.stale).toBe(true);
    expect(r.flags).toEqual([{ code: 'CALCULATION_STALE', level: 'warning', message: expect.stringContaining('Дүн өөрчлөгдсөн') }]);
  });

  it('арга сонгогдоогүй (ratio байхгүй) бол ratio=null ба METHOD_NOT_SELECTED анхааруулга', () => {
    const r = buildDecisionRisk(input({ snapshot: snapshot({ selectedMethod: null, selection: null, ratioKind: null, ratio: null, limit: null, pass: null, eligible: null }) }));
    expect(r.method).toBeNull();
    expect(r.ratio).toBeNull();
    expect(r.flags.map((f) => f.code)).toEqual(['METHOD_NOT_SELECTED']);
  });

  it('барьцааны G0 issue-үүд error, анхааруулгууд warning болж дамжина; ижил код+мессеж давхардахгүй', () => {
    const issue = { code: 'LTV_EXCEEDED' as const, collateralId: null, message: 'LTV 80% хэтэрсэн' };
    const r = buildDecisionRisk(input({
      collateral: collateral({ summary: { ltv: 0.8, ltvPass: false }, issues: [issue, issue], warnings: [{ code: 'INSURANCE_EXPIRING', collateralId: 'c1', message: 'Даатгал дуусна' }] }),
    }));
    expect(r.ltv).toEqual({ value: 0.8, limit: 0.7, pass: false });
    expect(r.flags).toEqual([
      { code: 'LTV_EXCEEDED', level: 'error', message: 'LTV 80% хэтэрсэн' },
      { code: 'INSURANCE_EXPIRING', level: 'warning', message: 'Даатгал дуусна' },
    ]);
  });

  it('LTV тооцох боломжгүй (барьцаа шаардахгүй, хөрөнгөгүй) бол value/pass=null; Sosco байхгүй бол null', () => {
    const r = buildDecisionRisk(input({
      snapshot: snapshot({ soscoScore: null, soscoGrade: null, ltv: null }),
      collateral: collateral({ summary: { count: 0, totalCollateralValue: 0, ltv: null, ltvPass: null, requiresCollateral: false } }),
    }));
    expect(r.ltv).toEqual({ value: null, limit: 0.7, pass: null });
    expect(r.sosco).toEqual({ score: null, grade: null });
    expect(r.collateral).toEqual({ count: 0, totalValue: 0, required: false });
  });

  it('оролтыг өөрчлөхгүй (immutable)', () => {
    const i = input({ collateral: collateral({ issues: [{ code: 'NOT_VALUED', collateralId: 'c1', message: 'Үнэлээгүй' }] }) });
    const before = JSON.stringify(i);
    buildDecisionRisk(i);
    expect(JSON.stringify(i)).toBe(before);
  });
});
