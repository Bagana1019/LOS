import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { ReasonCode, ReasonStep, UnderwriteResult } from '@los/contracts';
import type { CalcMethod, MethodVerdict, ScoreRequest } from '@los/contracts';
import { annuityPayment } from './schedule';
import { REASON_CATALOG, maxPrincipalForPayment, underwrite } from './underwriting';

// docs/05-scoring-sosco.md §2 · docs/04 Модуль 8 AC · FR-8.1…8.6, BR-1…BR-5

const POLICY = { maxDti: 0.55, minDscr: 1.25, maxLtv: 0.7, weightThreshold: 0.7 };

const baseReq = (over: Partial<ScoreRequest> = {}): ScoreRequest => ({
  applicationId: 'APP-1',
  amount: 30_000_000,
  termMonths: 36,
  interestRate: 23.99,
  monthlyPayment: 1_176_828,
  salaryMonthly: 0,
  businessNcfMonthly: 0,
  householdExpenseMonthly: 0,
  existingDebtServiceMonthly: 0,
  collateralValueTotal: 100_000_000,
  collateralRequired: true,
  policy: POLICY,
  ...over,
});

/** underwrite + гэрээний (zod) шалгалт: гаралт UnderwriteResult-тэй яг таарч, JSON-д алдагдалгүй сериалчлагдана */
const run = (over: Partial<ScoreRequest> = {}) => {
  const result = underwrite(baseReq(over));
  expect(UnderwriteResult.parse(result)).toEqual(result);
  expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  return result;
};

const pick = (methods: MethodVerdict[], id: CalcMethod): MethodVerdict => methods.find((m) => m.method === id) as MethodVerdict;
const codes = (m: { reasons: { code: string }[] }): string[] => m.reasons.map((r) => r.code);

describe('docs/04 Модуль 8 AC (үгчлэн)', () => {
  it('AC-1: цалин 3,000,000, идэвхтэй зээл 500,000, шинэ төлбөр 1,176,828 → ӨОХ 0.559 (55.9%) → хангаагүй', () => {
    const r = run({ salaryMonthly: 3_000_000, existingDebtServiceMonthly: 500_000, monthlyPayment: 1_176_828 });
    const a = pick(r.methods, 'A_SALARY');
    expect(a.applicable).toBe(true);
    expect(a.baseIncome).toBe(3_000_000);
    expect(a.totalDebtService).toBe(1_676_828);
    expect(a.ratioKind).toBe('DTI');
    // 1,676,828 ÷ 3,000,000 = 0.558942… → дээш 4 орон = 0.559
    expect(a.ratio).toBe(0.559);
    expect(`${((a.ratio as number) * 100).toFixed(1)}%`).toBe('55.9%');
    expect(a.burdenPercent).toBe(55.9);
    expect(a.limit).toBe(0.55);
    expect(a.pass).toBe(false);
    expect(a.eligible).toBe(false);
    expect(codes(a)).toEqual(['DTI_ABOVE_LIMIT']);
    expect(a.reasons[0].step).toBe('loan');
  });

  it('AC-2: бизнес ЦМУ 15,205,822, өрийн үйлчилгээ 2,176,828 → ӨТЧХ 6.98 → хангасан', () => {
    const r = run({ businessNcfMonthly: 15_205_822, existingDebtServiceMonthly: 1_000_000, monthlyPayment: 1_176_828 });
    const b = pick(r.methods, 'B_BUSINESS');
    expect(b.applicable).toBe(true);
    expect(b.baseIncome).toBe(15_205_822);
    expect(b.totalDebtService).toBe(2_176_828);
    expect(b.ratioKind).toBe('DSCR');
    // 15,205,822 ÷ 2,176,828 = 6.9853… → доош 2 орон = 6.98
    expect(b.ratio).toBe(6.98);
    expect(b.limit).toBe(1.25);
    expect(b.pass).toBe(true);
    expect(b.eligible).toBe(true);
    expect(b.reasons).toEqual([]);
    expect(b.maxPayment).toBe(11_164_657.6);
    expect(r.autoSelected).toBe('B_BUSINESS');
    expect(r.autoSelectReason).toBe('BUSINESS_DOMINANT');
  });

  it('AC-3: цалин 0 бол A арга хэрэглэгдэхгүй — "Цалингийн орлого байхгүй"', () => {
    const r = run({ salaryMonthly: 0, businessNcfMonthly: 5_000_000 });
    const a = pick(r.methods, 'A_SALARY');
    expect(a.applicable).toBe(false);
    expect(a.pass).toBe(false);
    expect(a.eligible).toBe(false);
    expect(a.reasons).toEqual([{ code: 'NO_SALARY_INCOME', step: 'income', message: 'Цалингийн орлого байхгүй' }]);
  });
});

describe('гаралтын бүтэц ба тоймлолт', () => {
  it('methods үргэлж [A, B, C] дараалалтай, policy шууд эхоолно', () => {
    const r = run({ salaryMonthly: 3_000_000, businessNcfMonthly: 1_000_000 });
    expect(r.methods.map((m) => m.method)).toEqual(['A_SALARY', 'B_BUSINESS', 'C_COMBINED']);
    expect(r.policy).toEqual(POLICY);
    expect(r.applicationId).toBe('APP-1');
    expect(r.methods.map((m) => [m.ratioKind, m.limit])).toEqual([['DTI', 0.55], ['DSCR', 1.25], ['DSCR', 1.25]]);
  });

  it('зээлийн хураангуй: totalPayable = сарын төлбөр × хугацаа, totalInterest = totalPayable − дүн', () => {
    const r = run({});
    expect(r.loan).toEqual({ amount: 30_000_000, termMonths: 36, interestRate: 23.99, monthlyPayment: 1_176_828, totalPayable: 42_365_808, totalInterest: 12_365_808 });
  });

  it('мөнгө 2 орон ROUND_HALF_UP', () => {
    const r = run({ monthlyPayment: 1000.005, salaryMonthly: 1000.005, amount: 100.005, termMonths: 12 });
    expect(r.loan.monthlyPayment).toBe(1000.01);
    expect(r.loan.totalPayable).toBe(12_000.06);
    expect(r.loan.amount).toBe(100.01);
    expect(r.loan.totalInterest).toBe(11_900.05);
    const a = pick(r.methods, 'A_SALARY');
    expect(a.baseIncome).toBe(1000.01);
    expect(a.totalDebtService).toBe(1000.01);
  });

  it('burdenPercent дээш 1 орон; суурь ≤ 0 бол null', () => {
    const r = run({ salaryMonthly: 10_000, monthlyPayment: 5001, amount: 5001, termMonths: 1, interestRate: 0, collateralValueTotal: 1_000_000 });
    const a = pick(r.methods, 'A_SALARY');
    expect(a.ratio).toBe(0.5001);
    expect(a.burdenPercent).toBe(50.1);
    const none = run({ salaryMonthly: 0, businessNcfMonthly: -5_000_000 });
    expect(none.methods.map((m) => m.burdenPercent)).toEqual([null, null, null]);
  });

  it('вход мутацид орохгүй, дахин дуудахад ижил (цэвэр функц)', () => {
    const input = baseReq({ salaryMonthly: 3_000_000, businessNcfMonthly: 2_000_000, stress: { rateDeltaPoints: 5, incomeChange: -0.2 } });
    const frozen = Object.freeze({ ...input, policy: Object.freeze({ ...input.policy }), stress: Object.freeze({ ...input.stress! }) }) as ScoreRequest;
    const first = underwrite(frozen);
    expect(underwrite(frozen)).toEqual(first);
    expect(frozen).toEqual(input);
  });
});

describe('ӨОХ (A, BR-1) — хязгаарын нарийвчлал', () => {
  const dti = (payment: number) => pick(run({ salaryMonthly: 1_000_000, monthlyPayment: payment, amount: 1_000_000, collateralValueTotal: 10_000_000 }).methods, 'A_SALARY');

  it('яг хязгаарт (0.55) хангана', () => {
    const a = dti(550_000);
    expect(a.ratio).toBe(0.55);
    expect(a.pass).toBe(true);
    expect(a.reasons).toEqual([]);
  });

  it('1 цент хэтэрвэл ratio дээш (0.5501) ба хангаахгүй — харуулах утга pass-тай нийцнэ', () => {
    const a = dti(550_000.01);
    expect(a.ratio).toBe(0.5501);
    expect(a.pass).toBe(false);
    expect(codes(a)).toEqual(['DTI_ABOVE_LIMIT']);
  });

  it('хязгаарын доор 1 цент → дээш тоймлоход 0.55 ч хангана', () => {
    const a = dti(549_999.99);
    expect(a.ratio).toBe(0.55);
    expect(a.pass).toBe(true);
  });

  it('maxDti = 1 хүртэл зөвшөөрнө', () => {
    const r = run({ salaryMonthly: 1_000_000, monthlyPayment: 1_000_000, policy: { ...POLICY, maxDti: 1 }, amount: 1_000_000, collateralValueTotal: 10_000_000 });
    expect(pick(r.methods, 'A_SALARY').pass).toBe(true);
  });
});

describe('ӨТЧХ (B/C, BR-2) — хязгаарын нарийвчлал', () => {
  const dscr = (payment: number) => pick(run({ businessNcfMonthly: 1_250_000, monthlyPayment: payment, amount: 1_000_000, collateralValueTotal: 10_000_000 }).methods, 'B_BUSINESS');

  it('яг хязгаарт (1.25) хангана', () => {
    const b = dscr(1_000_000);
    expect(b.ratio).toBe(1.25);
    expect(b.pass).toBe(true);
  });

  it('1.2499… → доош 1.24, хангахгүй, DSCR_BELOW_MIN (алхам loan)', () => {
    const b = dscr(1_000_001);
    expect(b.ratio).toBe(1.24);
    expect(b.pass).toBe(false);
    expect(b.eligible).toBe(false);
    expect(b.reasons).toEqual([{ code: 'DSCR_BELOW_MIN', step: 'loan', message: REASON_CATALOG.DSCR_BELOW_MIN.message }]);
  });

  it('1.25000001 → доош 1.25, хангана', () => {
    const b = dscr(999_999.99);
    expect(b.ratio).toBe(1.25);
    expect(b.pass).toBe(true);
  });

  it('өрийн үйлчилгээ = 0: ratio null, суурь > 0 бол хангана (B ба C)', () => {
    const r = run({ businessNcfMonthly: 2_000_000, monthlyPayment: 0, existingDebtServiceMonthly: 0, salaryMonthly: 1_000_000 });
    for (const id of ['B_BUSINESS', 'C_COMBINED'] as const) {
      const m = pick(r.methods, id);
      expect(m.ratio).toBeNull();
      expect(m.pass).toBe(true);
      expect(m.eligible).toBe(true);
      expect(m.totalDebtService).toBe(0);
    }
    expect(pick(r.methods, 'A_SALARY').ratio).toBe(0);
  });

  it('өрийн үйлчилгээ = 0 ба C суурь ≤ 0 бол хангахгүй', () => {
    const r = run({ salaryMonthly: 1_000_000, householdExpenseMonthly: 1_000_000, monthlyPayment: 0 });
    const c = pick(r.methods, 'C_COMBINED');
    expect(c.applicable).toBe(true);
    expect(c.baseIncome).toBe(0);
    expect(c.ratio).toBeNull();
    expect(c.pass).toBe(false);
    expect(codes(c)).toEqual(['NON_POSITIVE_BASE_INCOME']);
  });
});

describe('хэрэглэгдэх (applicable) байдал ба шалтгаан (FR-8.6)', () => {
  const cases: [string, number, number, [boolean, boolean, boolean]][] = [
    ['цалин > 0, ЦМУ = 0', 1_000_000, 0, [true, false, true]],
    ['цалин = 0, ЦМУ > 0', 0, 1_000_000, [false, true, true]],
    ['цалин > 0, ЦМУ > 0', 1_000_000, 1_000_000, [true, true, true]],
    ['цалин > 0, ЦМУ < 0', 1_000_000, -1, [true, false, true]],
    ['цалин = 0, ЦМУ < 0', 0, -1_000_000, [false, false, false]],
    ['цалин = 0, ЦМУ = 0', 0, 0, [false, false, false]],
  ];
  it.each(cases)('%s', (_name, salary, ncf, expected) => {
    const r = run({ salaryMonthly: salary, businessNcfMonthly: ncf });
    expect(r.methods.map((m) => m.applicable)).toEqual(expected);
    for (const m of r.methods) {
      if (!m.applicable) {
        // хэрэглэгдэхгүй: хангахгүй, дээд дүн 0, шалтгаантай, ratio/stress байхгүй
        expect(m.pass).toBe(false);
        expect(m.eligible).toBe(false);
        expect(m.maxPayment).toBe(0);
        expect(m.maxAffordable).toBe(0);
        expect(m.maxLoanAmount).toBe(0);
        expect(m.ratio).toBeNull();
        expect(m.reasons.length).toBeGreaterThan(0);
        expect(m.reasons.every((x) => x.step === 'income')).toBe(true);
      }
    }
  });

  it('B: ЦМУ = 0 → NO_BUSINESS_INCOME, ЦМУ < 0 → NEGATIVE_BUSINESS_NCF (түүхий суурь хэвээр)', () => {
    const zero = pick(run({ salaryMonthly: 1_000_000, businessNcfMonthly: 0 }).methods, 'B_BUSINESS');
    expect(zero.reasons).toEqual([{ code: 'NO_BUSINESS_INCOME', step: 'income', message: REASON_CATALOG.NO_BUSINESS_INCOME.message }]);
    const neg = pick(run({ salaryMonthly: 1_000_000, businessNcfMonthly: -250_000 }).methods, 'B_BUSINESS');
    expect(neg.baseIncome).toBe(-250_000);
    expect(neg.reasons).toEqual([{ code: 'NEGATIVE_BUSINESS_NCF', step: 'income', message: REASON_CATALOG.NEGATIVE_BUSINESS_NCF.message }]);
  });

  it('C: цалин, ЦМУ аль нь ч үгүй бол NO_INCOME ба autoSelected = null', () => {
    const r = run({ salaryMonthly: 0, businessNcfMonthly: -1_000_000 });
    const c = pick(r.methods, 'C_COMBINED');
    expect(c.applicable).toBe(false);
    expect(c.baseIncome).toBe(-1_000_000);
    expect(codes(c)).toEqual(['NO_INCOME']);
    expect(r.autoSelected).toBeNull();
    expect(r.autoSelectReason).toBe('NO_INCOME');
    expect(r.incomeMix).toEqual({ salaryShare: null, businessShare: null, weightThreshold: 0.7 });
  });

  it('C: суурь орлого ≤ 0 бол хэрэглэгдэнэ ч хангахгүй + NON_POSITIVE_BASE_INCOME', () => {
    const r = run({ salaryMonthly: 1_000_000, householdExpenseMonthly: 1_500_000, monthlyPayment: 100_000 });
    const c = pick(r.methods, 'C_COMBINED');
    expect(c.applicable).toBe(true);
    expect(c.baseIncome).toBe(-500_000);
    expect(c.pass).toBe(false);
    expect(c.eligible).toBe(false);
    expect(c.burdenPercent).toBeNull();
    expect(c.maxPayment).toBe(0);
    expect(c.maxAffordable).toBe(0);
    expect(c.maxLoanAmount).toBe(0);
    expect(c.reasons).toEqual([{ code: 'NON_POSITIVE_BASE_INCOME', step: 'income', message: REASON_CATALOG.NON_POSITIVE_BASE_INCOME.message }]);
  });

  it('C суурь орлого түүхий (сөрөг) ЦМУ-тэй: цалин + ЦМУ − өрхийн зардал (BR-5)', () => {
    const r = run({ salaryMonthly: 5_000_000, businessNcfMonthly: -1_000_000, householdExpenseMonthly: 500_000, monthlyPayment: 1_000_000, existingDebtServiceMonthly: 250_000 });
    const c = pick(r.methods, 'C_COMBINED');
    expect(c.baseIncome).toBe(3_500_000);
    expect(c.totalDebtService).toBe(1_250_000);
    expect(c.ratio).toBe(2.8);
    expect(c.pass).toBe(true);
    // хангаагүй C: ӨТЧХ
    const bad = pick(run({ salaryMonthly: 2_000_000, businessNcfMonthly: 1_000_000, householdExpenseMonthly: 1_500_000, monthlyPayment: 1_300_000 }).methods, 'C_COMBINED');
    expect(bad.baseIncome).toBe(1_500_000);
    expect(bad.ratio).toBe(1.15);
    expect(bad.pass).toBe(false);
    expect(codes(bad)).toEqual(['DSCR_BELOW_MIN']);
  });

  it('хангаагүй арга ба хэрэглэгдэхгүй арга хоёулаа eligible=false; зөвхөн applicable && pass && collateral.pass', () => {
    const r = run({ salaryMonthly: 3_000_000, monthlyPayment: 100_000, collateralValueTotal: 10_000_000, amount: 30_000_000 });
    // орлого хүрэлцэх ч LTV (3.0) хэтэрсэн → eligible=false, pass=true
    const a = pick(r.methods, 'A_SALARY');
    expect(a.pass).toBe(true);
    expect(r.collateral.pass).toBe(false);
    expect(a.eligible).toBe(false);
  });
});

describe('BR-4 автомат сонголт (хатуу «>» босго)', () => {
  const auto = (salary: number, ncf: number, weightThreshold = 0.7) => run({ salaryMonthly: salary, businessNcfMonthly: ncf, policy: { ...POLICY, weightThreshold } });

  it('цалин яг 70% → давдаггүй тул C (MIXED)', () => {
    const r = auto(7_000_000, 3_000_000);
    expect(r.incomeMix).toEqual({ salaryShare: 0.7, businessShare: 0.3, weightThreshold: 0.7 });
    expect([r.autoSelected, r.autoSelectReason]).toEqual(['C_COMBINED', 'MIXED']);
  });

  it('цалин 70%-аас 1 ₮-ээр давбал A', () => {
    const r = auto(7_000_001, 3_000_000);
    expect([r.autoSelected, r.autoSelectReason]).toEqual(['A_SALARY', 'SALARY_DOMINANT']);
  });

  it('бизнес яг 70% → C; 1 ₮-ээр давбал B', () => {
    expect(auto(3_000_000, 7_000_000).autoSelected).toBe('C_COMBINED');
    const r = auto(3_000_000, 7_000_001);
    expect([r.autoSelected, r.autoSelectReason]).toEqual(['B_BUSINESS', 'BUSINESS_DOMINANT']);
  });

  it('босго < 0.5 үед хоёулаа давбал A давамгайлна', () => {
    const r = auto(5_000_000, 5_000_000, 0.3);
    expect([r.autoSelected, r.autoSelectReason]).toEqual(['A_SALARY', 'SALARY_DOMINANT']);
  });

  it('босго = 0.5 ба 50/50 → C', () => {
    expect(auto(5_000_000, 5_000_000, 0.5).autoSelected).toBe('C_COMBINED');
  });

  it('босго 0: эерэг цалинтай бол A, цалингүй бизнестэй бол B', () => {
    expect(auto(1, 10_000_000, 0).autoSelected).toBe('A_SALARY');
    expect(auto(0, 10_000_000, 0).autoSelected).toBe('B_BUSINESS');
  });

  it('босго 1: хэзээ ч давахгүй тул цэвэр цалин/бизнес ч C', () => {
    const salaryOnly = auto(10_000_000, 0, 1);
    expect(salaryOnly.incomeMix.salaryShare).toBe(1);
    expect(salaryOnly.autoSelected).toBe('C_COMBINED');
    expect(auto(0, 10_000_000, 1).autoSelected).toBe('C_COMBINED');
  });

  it('сөрөг ЦМУ эерэг бүтцэд ордоггүй: цалин + сөрөг ЦМУ → цалин 100%', () => {
    const r = auto(5_000_000, -10_000_000);
    expect(r.incomeMix).toEqual({ salaryShare: 1, businessShare: 0, weightThreshold: 0.7 });
    expect([r.autoSelected, r.autoSelectReason]).toEqual(['A_SALARY', 'SALARY_DOMINANT']);
  });

  it('хувь 4 оронд бөөрөнхийлөгдөнө (1/3)', () => {
    const r = auto(1_000_000, 2_000_000, 0.9);
    expect(r.incomeMix.salaryShare).toBe(0.3333);
    expect(r.incomeMix.businessShare).toBe(0.6667);
    expect(r.autoSelected).toBe('C_COMBINED');
    const reversed = auto(2_000_000, 1_000_000, 0.9);
    expect(reversed.incomeMix.salaryShare).toBe(0.6667);
    expect(reversed.incomeMix.businessShare).toBe(0.3333);
  });
});

describe('барьцаа / LTV (BR-3, FR-6.4)', () => {
  it('шаардлагатай ба үнэлгээ 0 → NO_COLLATERAL_VALUE, maxAmount 0, бүх арга eligible=false, maxLoanAmount 0', () => {
    const r = run({ salaryMonthly: 10_000_000, businessNcfMonthly: 10_000_000, collateralValueTotal: 0, collateralRequired: true });
    expect(r.collateral).toEqual({
      required: true, valueTotal: 0, ltv: null, limit: 0.7, pass: false, maxAmount: 0,
      reasons: [{ code: 'NO_COLLATERAL_VALUE', step: 'collateral', message: REASON_CATALOG.NO_COLLATERAL_VALUE.message }],
    });
    for (const m of r.methods) {
      expect(m.eligible).toBe(false);
      expect(m.maxLoanAmount).toBe(0);
    }
    expect(pick(r.methods, 'A_SALARY').pass).toBe(true); // орлогын шалгуур тусдаа
  });

  it('collateralRequired өгөөгүй (undefined) бол zod default-тай адил шаардлагатай', () => {
    const r = run({ collateralValueTotal: 0, collateralRequired: undefined as unknown as boolean });
    expect(r.collateral.required).toBe(true);
    expect(r.collateral.pass).toBe(false);
  });

  it('шаардахгүй ба үнэлгээ 0 → ltv null, pass true, maxAmount null; maxLoanAmount = maxAffordable', () => {
    const r = run({ salaryMonthly: 3_000_000, collateralValueTotal: 0, collateralRequired: false });
    expect(r.collateral).toEqual({ required: false, valueTotal: 0, ltv: null, limit: 0.7, pass: true, maxAmount: null, reasons: [] });
    const a = pick(r.methods, 'A_SALARY');
    expect(a.maxAffordable).toBeGreaterThan(0);
    expect(a.maxLoanAmount).toBe(a.maxAffordable);
  });

  it('шаардахгүй ч хөрөнгө байвал LTV хэвийн хэрэгжинэ', () => {
    const r = run({ amount: 30_000_000, collateralValueTotal: 30_000_000, collateralRequired: false, salaryMonthly: 10_000_000 });
    expect(r.collateral.ltv).toBe(1);
    expect(r.collateral.pass).toBe(false);
    expect(r.collateral.maxAmount).toBe(21_000_000);
    expect(codes(r.collateral)).toEqual(['LTV_ABOVE_LIMIT']);
    expect(r.collateral.reasons[0].step).toBe('collateral');
    expect(pick(r.methods, 'A_SALARY').eligible).toBe(false);
  });

  it('LTV яг хязгаарт (0.7) хангана; 1 ₮ хэтэрвэл 0.7001 ба хангахгүй', () => {
    const at = run({ amount: 70_000_000, collateralValueTotal: 100_000_000 });
    expect(at.collateral).toMatchObject({ ltv: 0.7, pass: true, maxAmount: 70_000_000, reasons: [] });
    const over = run({ amount: 70_000_001, collateralValueTotal: 100_000_000 });
    expect(over.collateral).toMatchObject({ ltv: 0.7001, pass: false, maxAmount: 70_000_000 });
  });

  it('maxAmount доош бүхэл ₮, ltv дээш 4 орон', () => {
    const r = run({ amount: 1, collateralValueTotal: 100_000_001 });
    expect(r.collateral.maxAmount).toBe(70_000_000); // 70,000,000.7 → 70,000,000
    const third = run({ amount: 1_000_000, collateralValueTotal: 3_000_000 });
    expect(third.collateral.ltv).toBe(0.3334);
  });

  it('maxLoanAmount = min(төлбөрийн чадвар, барьцааны хязгаар)', () => {
    const limited = run({ salaryMonthly: 50_000_000, collateralValueTotal: 10_000_000, amount: 5_000_000, monthlyPayment: 200_000 });
    const a = pick(limited.methods, 'A_SALARY');
    expect(a.maxAffordable).toBeGreaterThan(7_000_000);
    expect(a.maxLoanAmount).toBe(7_000_000);
    const affordLimited = run({ salaryMonthly: 1_000_000, collateralValueTotal: 1_000_000_000, amount: 5_000_000, monthlyPayment: 200_000 });
    const a2 = pick(affordLimited.methods, 'A_SALARY');
    expect(a2.maxLoanAmount).toBe(a2.maxAffordable);
    expect(a2.maxLoanAmount).toBeLessThan(700_000_000);
  });
});

describe('боломжит дээд дүн (FR-8.3)', () => {
  it('A: maxDti × цалин − идэвхтэй төлбөр; maxAffordable нь annuity-ийн урвуу', () => {
    const r = run({ salaryMonthly: 3_000_000, existingDebtServiceMonthly: 500_000 });
    const a = pick(r.methods, 'A_SALARY');
    expect(a.maxPayment).toBe(1_150_000);
    expect(annuityPayment(a.maxAffordable, 23.99, 36)).toBeLessThanOrEqual(1_150_000);
    expect(annuityPayment(a.maxAffordable + 1000, 23.99, 36)).toBeGreaterThan(1_150_000);
    expect(a.maxAffordable).toBe(maxPrincipalForPayment(1_150_000, 23.99, 36));
    expect(a.maxAffordable).toBeGreaterThan(29_000_000);
    expect(a.maxAffordable).toBeLessThan(29_500_000);
  });

  it('maxPayment доош 2 орон — хязгаараас хэзээ ч хэтрэхгүй', () => {
    const a = pick(run({ salaryMonthly: 1_234_567.89 }).methods, 'A_SALARY');
    expect(a.maxPayment).toBe(679_012.33); // 679,012.3395
    const b = pick(run({ businessNcfMonthly: 1_000.01 }).methods, 'B_BUSINESS');
    expect(b.maxPayment).toBe(800); // 1000.01 ÷ 1.25 = 800.008
  });

  it('C: (цалин + ЦМУ − өрхийн зардал) ÷ minDscr − идэвхтэй төлбөр', () => {
    const c = pick(run({ salaryMonthly: 2_000_000, businessNcfMonthly: 3_000_000, householdExpenseMonthly: 1_000_000, existingDebtServiceMonthly: 400_000 }).methods, 'C_COMBINED');
    expect(c.baseIncome).toBe(4_000_000);
    expect(c.maxPayment).toBe(2_800_000);
  });

  it('идэвхтэй төлбөр хязгаараас их бол maxPayment = maxAffordable = maxLoanAmount = 0', () => {
    const a = pick(run({ salaryMonthly: 1_000_000, existingDebtServiceMonthly: 600_000, monthlyPayment: 0 }).methods, 'A_SALARY');
    expect(a.pass).toBe(false);
    expect([a.maxPayment, a.maxAffordable, a.maxLoanAmount]).toEqual([0, 0, 0]);
  });

  it('хүү 0 үед maxAffordable = maxPayment × хугацаа (доош бүхэл)', () => {
    const a = pick(run({ salaryMonthly: 1_000_000, interestRate: 0, termMonths: 12, collateralValueTotal: 1e12 }).methods, 'A_SALARY');
    expect(a.maxPayment).toBe(550_000);
    expect(a.maxAffordable).toBe(6_600_000);
  });
});

describe('stress test (FR-8.5)', () => {
  const stressInput = { rateDeltaPoints: 5, incomeChange: -0.2 };
  const stressed = (over: Partial<ScoreRequest> = {}, s = stressInput) => run({ stress: s, ...over });
  const dp = (x: Decimal, n: number, mode: Decimal.Rounding) => x.toDecimalPlaces(n, mode).toNumber();

  it('stress өгөөгүй бол result.stress ба метод бүрийн stress = null', () => {
    const r = run({ salaryMonthly: 3_000_000 });
    expect(r.stress).toBeNull();
    expect(r.methods.every((m) => m.stress === null)).toBe(true);
  });

  it('шинэ төлбөр = annuity(хүү + Δ); эерэг орлого ×(1+Δ); өрхийн зардал, идэвхтэй өр хэвээр', () => {
    const r = stressed({ salaryMonthly: 4_000_000, businessNcfMonthly: 6_000_000, householdExpenseMonthly: 1_000_000, existingDebtServiceMonthly: 500_000 });
    const sp = annuityPayment(30_000_000, 28.99, 36);
    expect(r.stress).toEqual({ rateDeltaPoints: 5, incomeChange: -0.2, stressedMonthlyPayment: sp });
    expect(sp).toBeGreaterThan(1_176_828);

    const [a, b, c] = r.methods.map((m) => m.stress!);
    const total = new Decimal(500_000).plus(sp);
    expect(a.baseIncome).toBe(3_200_000);
    expect(a.totalDebtService).toBe(total.toNumber());
    expect(a.ratio).toBe(dp(total.div(3_200_000), 4, Decimal.ROUND_CEIL));
    expect(a.pass).toBe(total.lte(new Decimal(3_200_000).mul(0.55)));
    expect(b.baseIncome).toBe(4_800_000);
    expect(b.ratio).toBe(dp(new Decimal(4_800_000).div(total), 2, Decimal.ROUND_FLOOR));
    expect(b.pass).toBe(new Decimal(4_800_000).gte(total.mul(1.25)));
    expect(c.baseIncome).toBe(7_000_000); // 3.2M + 4.8M − 1M
    expect(c.ratio).toBe(dp(new Decimal(7_000_000).div(total), 2, Decimal.ROUND_FLOOR));
    expect(c.pass).toBe(true);
    // суурь тооцоо stress-ээс үл хамаарна
    expect(r.methods[0].baseIncome).toBe(4_000_000);
    expect(r.methods[0].totalDebtService).toBe(1_676_828);
  });

  it('сөрөг ЦМУ stress-д өөрчлөгдөхгүй', () => {
    const r = stressed({ salaryMonthly: 5_000_000, businessNcfMonthly: -2_000_000, householdExpenseMonthly: 0 });
    const [, b, c] = r.methods.map((m) => m.stress!);
    expect(b.baseIncome).toBe(-2_000_000);
    expect(b.pass).toBe(false);
    expect(b.ratio).toBeNull();
    expect(c.baseIncome).toBe(2_000_000); // 4M − 2M (ЦМУ хэвээр)
  });

  it('орлого −100% бол бүх орлогын арга stress-д хэрэглэгдэхгүй (pass=false, ratio=null)', () => {
    const r = stressed({ salaryMonthly: 3_000_000, businessNcfMonthly: 3_000_000 }, { rateDeltaPoints: 0, incomeChange: -1 });
    for (const m of r.methods) expect(m.stress).toMatchObject({ baseIncome: 0, ratio: null, pass: false });
  });

  it('хэрэглэгдэхгүй арга stress-д ч хангахгүй', () => {
    const r = stressed({ salaryMonthly: 0, businessNcfMonthly: 3_000_000 });
    expect(r.methods[0].stress).toMatchObject({ baseIncome: 0, ratio: null, pass: false });
  });

  it('Δ = 0 ба төлбөр annuity-тай тэнцүү бол stress нь суурьтай ижил', () => {
    const payment = annuityPayment(30_000_000, 23.99, 36);
    const r = stressed({ salaryMonthly: 4_000_000, businessNcfMonthly: 5_000_000, existingDebtServiceMonthly: 300_000, monthlyPayment: payment }, { rateDeltaPoints: 0, incomeChange: 0 });
    expect(r.stress?.stressedMonthlyPayment).toBe(payment);
    for (const m of r.methods) expect(m.stress).toEqual({ baseIncome: m.baseIncome, totalDebtService: m.totalDebtService, ratio: m.ratio, pass: m.pass });
  });

  it('хүү 0 үед stress төлбөр 2 оронд бөөрөнхийлөгдөнө', () => {
    const r = stressed({ amount: 100, termMonths: 3, interestRate: 0, monthlyPayment: 33.33, salaryMonthly: 1000, collateralValueTotal: 1000 }, { rateDeltaPoints: 0, incomeChange: 0 });
    expect(r.stress?.stressedMonthlyPayment).toBe(33.33);
  });
});

describe('REASON_CATALOG', () => {
  it('ReasonCode бүрийг хамарсан, алхам зөв, мессеж монгол кирилл', () => {
    expect(Object.keys(REASON_CATALOG).sort()).toEqual([...ReasonCode.options].sort());
    for (const code of ReasonCode.options) {
      expect(ReasonStep.options).toContain(REASON_CATALOG[code].step);
      expect(REASON_CATALOG[code].message).toMatch(/[Ѐ-ӿ]/);
    }
    expect(REASON_CATALOG.NO_SALARY_INCOME).toEqual({ step: 'income', message: 'Цалингийн орлого байхгүй' });
  });
});

describe('maxPrincipalForPayment', () => {
  it('annuityPayment-тэй хоёр талдаа таарна: буцаасан дүнгийн төлбөр ≤ хүссэн, +1,000 ₮ бол давна', () => {
    const rates = [0, 0.5, 5, 12, 23.99, 36, 120];
    const terms = [1, 2, 6, 12, 36, 60, 120, 360, 600];
    const payments = [100_000, 333_333.33, 1_176_828, 1_176_828.55, 5_000_000.01, 50_000_000];
    for (const rate of rates) {
      for (const n of terms) {
        for (const payment of payments) {
          const p = maxPrincipalForPayment(payment, rate, n);
          expect(Number.isInteger(p)).toBe(true);
          expect(annuityPayment(p, rate, n)).toBeLessThanOrEqual(payment);
          expect(annuityPayment(p + 1000, rate, n)).toBeGreaterThan(payment);
        }
      }
    }
  });

  it('annuityPayment(30,000,000 @ 23.99% / 36)-ийн урвуу ≈ 30,000,000', () => {
    const pmt = annuityPayment(30_000_000, 23.99, 36);
    const p = maxPrincipalForPayment(pmt, 23.99, 36);
    expect(p).toBeGreaterThanOrEqual(29_999_990);
    expect(p).toBeLessThanOrEqual(30_000_000);
  });

  it('хүү 0 → payment × n (доош бүхэл)', () => {
    expect(maxPrincipalForPayment(100, 0, 12)).toBe(1200);
    expect(maxPrincipalForPayment(1_176_828.55, 0, 36)).toBe(42_365_827);
    expect(maxPrincipalForPayment(0.1, 0, 3)).toBe(0);
  });

  it('payment ≤ 0 → 0', () => {
    expect(maxPrincipalForPayment(0, 23.99, 36)).toBe(0);
    expect(maxPrincipalForPayment(-5, 0, 12)).toBe(0);
    expect(maxPrincipalForPayment(-5, 10, 12)).toBe(0);
  });

  it('хүчингүй оролтод RangeError', () => {
    expect(() => maxPrincipalForPayment(Number.NaN, 10, 12)).toThrow(RangeError);
    expect(() => maxPrincipalForPayment(100, -1, 12)).toThrow(/annualRatePct/);
    expect(() => maxPrincipalForPayment(100, Number.POSITIVE_INFINITY, 12)).toThrow(RangeError);
    expect(() => maxPrincipalForPayment(100, 10, 0)).toThrow(/termMonths/);
    expect(() => maxPrincipalForPayment(100, 10, 1.5)).toThrow(RangeError);
  });
});

describe('оролтын шалгалт (RangeError)', () => {
  const policy = (over: Partial<ScoreRequest['policy']>) => ({ policy: { ...POLICY, ...over } });
  const bad: [string, string, Partial<ScoreRequest>][] = [
    ['amount', 'amount = 0', { amount: 0 }],
    ['amount', 'amount < 0', { amount: -1 }],
    ['amount', 'amount NaN', { amount: Number.NaN }],
    ['amount', 'amount Infinity', { amount: Number.POSITIVE_INFINITY }],
    ['termMonths', 'term = 0', { termMonths: 0 }],
    ['termMonths', 'term < 0', { termMonths: -3 }],
    ['termMonths', 'term бүхэл биш', { termMonths: 1.5 }],
    ['termMonths', 'term NaN', { termMonths: Number.NaN }],
    ['interestRate', 'rate < 0', { interestRate: -0.01 }],
    ['interestRate', 'rate NaN', { interestRate: Number.NaN }],
    ['interestRate', 'rate Infinity', { interestRate: Number.POSITIVE_INFINITY }],
    ['monthlyPayment', 'payment < 0', { monthlyPayment: -1 }],
    ['monthlyPayment', 'payment NaN', { monthlyPayment: Number.NaN }],
    ['salaryMonthly', 'salary < 0', { salaryMonthly: -1 }],
    ['salaryMonthly', 'salary Infinity', { salaryMonthly: Number.POSITIVE_INFINITY }],
    ['businessNcfMonthly', 'ncf NaN', { businessNcfMonthly: Number.NaN }],
    ['businessNcfMonthly', 'ncf Infinity', { businessNcfMonthly: Number.POSITIVE_INFINITY }],
    ['businessNcfMonthly', 'ncf -Infinity', { businessNcfMonthly: Number.NEGATIVE_INFINITY }],
    ['householdExpenseMonthly', 'household < 0', { householdExpenseMonthly: -1 }],
    ['existingDebtServiceMonthly', 'existing < 0', { existingDebtServiceMonthly: -1 }],
    ['collateralValueTotal', 'collateral < 0', { collateralValueTotal: -1 }],
    ['collateralValueTotal', 'collateral NaN', { collateralValueTotal: Number.NaN }],
    ['policy.maxDti', 'maxDti = 0', policy({ maxDti: 0 })],
    ['policy.maxDti', 'maxDti > 1', policy({ maxDti: 1.01 })],
    ['policy.maxDti', 'maxDti NaN', policy({ maxDti: Number.NaN })],
    ['policy.minDscr', 'minDscr = 0', policy({ minDscr: 0 })],
    ['policy.minDscr', 'minDscr < 0', policy({ minDscr: -1.25 })],
    ['policy.minDscr', 'minDscr Infinity', policy({ minDscr: Number.POSITIVE_INFINITY })],
    ['policy.maxLtv', 'maxLtv = 0', policy({ maxLtv: 0 })],
    ['policy.maxLtv', 'maxLtv > 1', policy({ maxLtv: 1.5 })],
    ['policy.weightThreshold', 'threshold < 0', policy({ weightThreshold: -0.1 })],
    ['policy.weightThreshold', 'threshold > 1', policy({ weightThreshold: 1.1 })],
    ['stress.rateDeltaPoints', 'stress Δхүү < 0', { stress: { rateDeltaPoints: -1, incomeChange: -0.2 } }],
    ['stress.rateDeltaPoints', 'stress Δхүү NaN', { stress: { rateDeltaPoints: Number.NaN, incomeChange: -0.2 } }],
    ['stress.incomeChange', 'stress Δорлого > 0', { stress: { rateDeltaPoints: 5, incomeChange: 0.1 } }],
    ['stress.incomeChange', 'stress Δорлого < −1', { stress: { rateDeltaPoints: 5, incomeChange: -1.1 } }],
    ['stress.incomeChange', 'stress Δорлого NaN', { stress: { rateDeltaPoints: 5, incomeChange: Number.NaN } }],
    ['amount', 'тоо биш төрөл', { amount: '30000000' as unknown as number }],
  ];
  it.each(bad)('%s: %s → RangeError', (field, _name, over) => {
    const call = () => underwrite(baseReq(over));
    expect(call).toThrow(RangeError);
    expect(call).toThrow(new RegExp(field.replace('.', '\\.')));
  });

  it('хилийн хүчинтэй утгууд зөвшөөрөгдөнө', () => {
    expect(() => run({ termMonths: 1, interestRate: 0, policy: { ...POLICY, maxDti: 1, maxLtv: 1, weightThreshold: 0 } })).not.toThrow();
    expect(() => run({ policy: { ...POLICY, weightThreshold: 1 }, stress: { rateDeltaPoints: 0, incomeChange: 0 } })).not.toThrow();
    expect(() => run({ stress: { rateDeltaPoints: 100, incomeChange: -1 } })).not.toThrow();
    expect(() => run({ businessNcfMonthly: -9e13, salaryMonthly: 9e13, collateralValueTotal: 9e13, amount: 9e13, monthlyPayment: 9e13 })).not.toThrow();
  });
});
