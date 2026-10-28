// BSA DTI тооцооллын тест (docs/02 §4, §7; docs/04 Модуль 8 AC). БҮХ ӨГӨГДӨЛ СИНТЕТИК — бодит хуулга/хүн байхгүй.
// Босго, жин (lowMax, reliabilityWeights…) нь ЗӨВХӨН тестийн fixture; бизнесийн анхдагч биш (admin-аас ирнэ).
import { describe, it, expect } from 'vitest';
import type { BsaScoringInput } from '@los/contracts';
import {
  classifyDtiLevel, computeBsaDti, DTI_PERCENT_CAP, incomeReliability, monthKeysBetween, periodMonthsBetween, toScoringPatch,
  type BsaCategoryMonthly, type BsaDtiParams, type BsaDtiResult, type BsaDtiRole,
} from './bsa-dti';

// ───────────── fixture helpers ─────────────
const PARAMS: BsaDtiParams = {
  periodFrom: '2026-03-10',
  periodTo: '2026-09-10',
  proposedMonthlyPayment: 0,
  costOfGoodsRate: 0.1, // BSA-BR-1
  maxDti: 0.55, // BSA-BR-2
  levelThresholds: { lowMax: 0.35, mediumMax: 0.55 },
  businessIncomeCodes: ['INC_BUSINESS'],
  irregularIncomeCodes: ['INC_IRREGULAR', 'INC_ABNORMAL', 'INC_SUSPICIOUS'],
  reliabilityWeights: { frequency: 0.4, consistency: 0.4, cleanliness: 0.2 },
};
const params = (over: Partial<BsaDtiParams> = {}): BsaDtiParams => ({ ...PARAMS, ...over });

const inc = (code: string, weight: number, monthly: Record<string, number>, dtiRole: BsaDtiRole = 'INCOME'): BsaCategoryMonthly => ({
  code, name: `${code} нэр`, direction: 'INCOME', groupCode: 'T', weight, dtiRole, monthly, txnCount: Object.keys(monthly).length * 3,
});
const exp = (code: string, dtiRole: BsaDtiRole, monthly: Record<string, number>): BsaCategoryMonthly => ({
  code, name: `${code} нэр`, direction: 'EXPENSE', groupCode: 'T', weight: 1, dtiRole, monthly, txnCount: Object.keys(monthly).length * 2,
});
/** Бүх сард ижил дүн */
const flat = (keys: string[], amount: number): Record<string, number> => Object.fromEntries(keys.map((k) => [k, amount]));

const GOLDEN_KEYS = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
/** Хугацаа сарын дундаас эхэлж төгсөх тул эхний/сүүлийн сар хагас: нийт = 6 × avg (6 сарын дундаж avg) */
const edge = (avg: number): Record<string, number> =>
  Object.fromEntries(GOLDEN_KEYS.map((k, i) => [k, i === 0 || i === 6 ? avg / 2 : avg]));

/** docs/02 §7 жишээний тоонуудыг (синтетик) гаргадаг ангиллууд */
function goldenCategories(): BsaCategoryMonthly[] {
  return [
    inc('INC_SALARY', 1, edge(600_000)),
    inc('INC_CASH', 0.5, edge(200_000)),
    inc('INC_BUSINESS', 0.85, edge(18_180_156.47)),
    inc('INC_PASSIVE', 1, edge(100_000)),
    inc('INC_CONTRACT', 0.7, edge(75_000)),
    inc('INC_OTHER', 0.1, edge(102_330)),
    inc('INC_IRREGULAR', 0, edge(4_000_000)),
    inc('INC_LOAN', 0, edge(10_000_000)),
    inc('INC_NONINCOME', 0, edge(3_000_000)),
    inc('INC_ABNORMAL', 0, edge(1_500_000)),
    inc('INC_SUSPICIOUS', 0, edge(562_984.53)),
    inc('INC_OWN_TRANSFER', 1, edge(250_000_000), 'EXCLUDE'), // өөрийн данс — юунд ч нөлөөлөхгүй
    exp('EXP_LOAN', 'DEBT_SERVICE', edge(700_000)),
    exp('EXP_DEBT', 'DEBT_SERVICE', edge(300_000)),
    exp('EXP_FIXED', 'HOUSEHOLD', edge(800_000)),
    exp('EXP_ESSENTIAL', 'HOUSEHOLD', edge(1_200_000)),
    exp('EXP_DISCRETIONARY', 'INFO', edge(500_000)),
    exp('EXP_BUSINESS', 'BUSINESS_EXPENSE', edge(247_311)),
    exp('EXP_BANK_FEE', 'INFO', edge(12_000)),
    exp('EXP_NON_EXPENSE', 'EXCLUDE', edge(180_000_000)),
  ];
}

const without = (cats: BsaCategoryMonthly[], ...codes: string[]): BsaCategoryMonthly[] => cats.filter((c) => !codes.includes(c.code));

/** Тоон талбар бүрийг k-аар үржүүлнэ (мөнгөн дүн л) */
function scaled(cats: BsaCategoryMonthly[], k: number): BsaCategoryMonthly[] {
  return cats.map((c) => ({ ...c, monthly: Object.fromEntries(Object.entries(c.monthly).map(([m, v]) => [m, v * k])) }));
}

const MONEY_FIELDS = [
  'totalMonthlyIncome', 'verifiedMonthlyIncome', 'dtiIncome', 'businessIncomeMonthly', 'businessExpenseMonthly', 'netCashFlowMonthly',
  'existingDebtServiceMonthly', 'householdExpenseMonthly',
] as const;

// ───────────── periodMonthsBetween / monthKeysBetween ─────────────
describe('periodMonthsBetween', () => {
  it('docs/02 §7: 2026-03-10..2026-09-10 → 6 (185 өдөр)', () => {
    expect(periodMonthsBetween('2026-03-10', '2026-09-10')).toBe(6);
  });

  it.each([
    ['нэг өдөр', '2026-04-15', '2026-04-15', 1],
    ['нэг бүтэн сар (30 өдөр)', '2026-04-01', '2026-04-30', 1],
    ['45 өдөр = 1.478 → 1', '2026-01-01', '2026-02-14', 1],
    ['46 өдөр = 1.511 → 2', '2026-01-01', '2026-02-15', 2],
    ['3 сар', '2026-01-01', '2026-03-31', 3],
    ['жилийн хоёр үзүүр оролцоно: 365 өдөр → 12', '2025-10-01', '2026-09-30', 12],
    ['үсрэх жил 366 өдөр → 12', '2024-01-01', '2024-12-31', 12],
    ['хоёр жил', '2024-01-01', '2025-12-31', 24],
    ['үсрэх өдөр: 2024-02-01..2024-02-29 (29 өдөр) → 1', '2024-02-01', '2024-02-29', 1],
  ])('%s', (_name, from, to, expected) => {
    expect(periodMonthsBetween(from, to)).toBe(expected);
  });

  it('from > to → RangeError', () => {
    expect(() => periodMonthsBetween('2026-09-10', '2026-03-10')).toThrow(RangeError);
    expect(() => periodMonthsBetween('2026-09-10', '2026-03-10')).toThrow(/after period end/);
  });

  it.each([
    '', '2026/03/10', '2026-3-10', '26-03-10', '2026-13-01', '2026-00-10', '2026-03-00', '2026-03-32',
    '2026-02-30', '2025-02-29', 'not-a-date',
  ])(
    'буруу огноо "%s" → RangeError',
    (bad) => {
      expect(() => periodMonthsBetween(bad, '2026-12-31')).toThrow(RangeError);
      expect(() => periodMonthsBetween('2026-01-01', bad)).toThrow(RangeError);
    },
  );

  it('2024-02-29 (үсрэх жил) зөв огноо, 2025-02-29 буруу', () => {
    expect(periodMonthsBetween('2024-02-29', '2024-02-29')).toBe(1);
    expect(() => periodMonthsBetween('2025-02-29', '2025-03-01')).toThrow(/not a calendar date/);
  });
});

describe('monthKeysBetween', () => {
  it('хоёр үзүүрийн сар оролцоно', () => {
    expect(monthKeysBetween('2026-03-10', '2026-09-10')).toEqual(GOLDEN_KEYS);
  });
  it('нэг өдөр, нэг сар', () => {
    expect(monthKeysBetween('2026-04-15', '2026-04-15')).toEqual(['2026-04']);
    expect(monthKeysBetween('2026-04-01', '2026-04-30')).toEqual(['2026-04']);
  });
  it('оны хил: 12 → 01', () => {
    expect(monthKeysBetween('2025-11-15', '2026-02-14')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });
  it('12 сар, 24 сар', () => {
    expect(monthKeysBetween('2025-10-01', '2026-09-30')).toHaveLength(12);
    expect(monthKeysBetween('2024-01-01', '2025-12-31')).toHaveLength(24);
  });
  it('from > to болон буруу огноо → RangeError', () => {
    expect(() => monthKeysBetween('2026-09-10', '2026-03-10')).toThrow(RangeError);
    expect(() => monthKeysBetween('2026-02-30', '2026-03-10')).toThrow(RangeError);
  });
});

// ───────────── classifyDtiLevel ─────────────
describe('classifyDtiLevel', () => {
  const t = { lowMax: 0.35, mediumMax: 0.55 };
  it('заагууд хоёр талдаа: ≤ lowMax LOW, ≤ mediumMax MEDIUM, дээш HIGH', () => {
    expect(classifyDtiLevel(0, t)).toBe('LOW');
    expect(classifyDtiLevel(0.35, t)).toBe('LOW');
    expect(classifyDtiLevel(0.3500001, t)).toBe('MEDIUM');
    expect(classifyDtiLevel(0.55, t)).toBe('MEDIUM');
    expect(classifyDtiLevel(0.5500001, t)).toBe('HIGH');
    expect(classifyDtiLevel(12, t)).toBe('HIGH');
  });
  it('Infinity → HIGH', () => {
    expect(classifyDtiLevel(Infinity, t)).toBe('HIGH');
  });
  it('lowMax = mediumMax үед MEDIUM байхгүй', () => {
    expect(classifyDtiLevel(0.4, { lowMax: 0.4, mediumMax: 0.4 })).toBe('LOW');
    expect(classifyDtiLevel(0.41, { lowMax: 0.4, mediumMax: 0.4 })).toBe('HIGH');
  });
  it('сөрөг / NaN харьцаа → RangeError', () => {
    expect(() => classifyDtiLevel(-0.01, t)).toThrow(RangeError);
    expect(() => classifyDtiLevel(NaN, t)).toThrow(RangeError);
  });
  it('буруу босго → RangeError', () => {
    expect(() => classifyDtiLevel(0.1, { lowMax: -0.1, mediumMax: 0.5 })).toThrow(RangeError);
    expect(() => classifyDtiLevel(0.1, { lowMax: 0.1, mediumMax: NaN })).toThrow(RangeError);
    expect(() => classifyDtiLevel(0.1, { lowMax: 0.6, mediumMax: 0.5 })).toThrow(/must not exceed/);
  });
});

// ───────────── Golden 1: docs/02 §7 ─────────────
describe('computeBsaDti — golden: docs/02 §7 жишээ', () => {
  const result = computeBsaDti(goldenCategories(), params({ proposedMonthlyPayment: 0 }));

  it('хугацаа: 6 сар, 7 хуанлийн сар', () => {
    expect(result.periodMonths).toBe(6);
    expect(result.monthKeys).toEqual(GOLDEN_KEYS);
  });

  it('INT-4 гэрээний тоонууд', () => {
    expect(result.totalMonthlyIncome).toBe(38_320_471);
    expect(result.verifiedMonthlyIncome).toBe(16_315_866);
    expect(Math.abs(result.dtiIncome - 14_684_279)).toBeLessThanOrEqual(1);
    expect(result.dtiIncome).toBe(14_684_279.4); // 16,315,865.9995 × 0.9 = 14,684,279.39955
    expect(result.businessIncomeMonthly).toBe(15_453_133);
    expect(result.businessExpenseMonthly).toBe(247_311);
    expect(result.netCashFlowMonthly).toBe(15_205_822);
    expect(result.existingDebtServiceMonthly).toBe(1_000_000);
    expect(result.householdExpenseMonthly).toBe(2_000_000);
  });

  it('DTI 6.8% → LOW, хязгаарт нийцнэ', () => {
    expect(result.dtiPercent).toBe(6.8);
    expect(result.dtiRatio).toBeCloseTo(0.068100039, 9);
    expect(result.dtiLevel).toBe('LOW');
    expect(result.meetsLimit).toBe(true);
  });

  it('найдвар 95.2: хэсэгчилсэн эхний/сүүлийн сар (3, 9-р сар) хасагдаж 4–8-р сар үнэлэгдэнэ — давтамж 1, тогтвортой 1, цэвэр 0.7606 (жин 0.4/0.4/0.2)', () => {
    // 100 × (0.4×1 + 0.4×1 + 0.2×(1 − 6,062,984.53 / (19,257,486.47 + 6,062,984.53))) = 95.2 — гараар тусад нь бодсон
    expect(result.incomeReliability).toBe(95.2);
  });

  it('өөрийн данс (EXCLUDE) орлого/зарлага нийлбэр, share, найдварт огт орохгүй', () => {
    const base = computeBsaDti(without(goldenCategories(), 'INC_OWN_TRANSFER', 'EXP_NON_EXPENSE'), PARAMS);
    for (const f of MONEY_FIELDS) expect(result[f]).toBe(base[f]);
    expect(result.incomeReliability).toBe(base.incomeReliability);
    expect(result.dtiRatio).toBe(base.dtiRatio);
    const own = result.categories.find((c) => c.code === 'INC_OWN_TRANSFER');
    expect(own).toMatchObject({ share: 0, weightedMonthly: 0, totalAmount: 1_500_000_000, monthlyAvg: 250_000_000 });
  });

  it('санал болгосон төлбөр нэмэхэд зөвхөн DTI өөрчлөгдөнө', () => {
    const r = computeBsaDti(goldenCategories(), params({ proposedMonthlyPayment: 2_000_000 }));
    expect(r.dtiPercent).toBe(20.4); // 3,000,000 / 14,684,279.39955 = 0.20430
    expect(r.dtiLevel).toBe('LOW');
    expect(r.verifiedMonthlyIncome).toBe(result.verifiedMonthlyIncome);
    expect(r.netCashFlowMonthly).toBe(result.netCashFlowMonthly);
  });

  it('ангиллын задаргаа: орлого түрүүлж totalAmount буурахаар, дараа нь зарлага', () => {
    const dirs = result.categories.map((c) => c.direction);
    expect(dirs.indexOf('EXPENSE')).toBe(dirs.filter((d) => d === 'INCOME').length);
    const business = result.categories.find((c) => c.code === 'INC_BUSINESS')!;
    expect(business).toMatchObject({
      totalAmount: 109_080_938.82, monthlyAvg: 18_180_156.47, weightedMonthly: 15_453_133, weight: 0.85, monthsPresent: 7, txnCount: 21,
    });
    // EXCLUDE-г хассан орлогын нийлбэр: 6 × 38,320,471
    expect(business.share).toBeCloseTo(109_080_938.82 / (38_320_471 * 6), 12);
  });
});

// ───────────── Golden 2: docs/04 Модуль 8 AC ─────────────
describe('computeBsaDti — golden: docs/04 Модуль 8 AC (ӨОХ 55.9%)', () => {
  const keys = ['2026-01', '2026-02', '2026-03'];
  const base = params({ periodFrom: '2026-01-01', periodTo: '2026-03-31', costOfGoodsRate: 0, proposedMonthlyPayment: 1_176_828 });
  const cats = [inc('INC_SALARY', 1, flat(keys, 3_000_000)), exp('EXP_LOAN', 'DEBT_SERVICE', flat(keys, 500_000))];

  it('цалин 3,000,000, идэвхтэй зээл 500,000, шинэ төлбөр 1,176,828 → 55.9%, хангаагүй', () => {
    const r = computeBsaDti(cats, base);
    expect(r.periodMonths).toBe(3);
    expect(r.dtiIncome).toBe(3_000_000);
    expect(r.dtiRatio).toBeCloseTo(1_676_828 / 3_000_000, 12);
    expect(r.dtiPercent).toBe(55.9);
    expect(r.meetsLimit).toBe(false);
    expect(r.dtiLevel).toBe('HIGH');
  });

  it('яг хязгаар (55.00%) хангана; хязгаараас 1₮ дээш бол dtiPercent 55.0 харагдаж ч хангахгүй', () => {
    const at = computeBsaDti(cats, { ...base, proposedMonthlyPayment: 1_150_000 }); // (1,150,000 + 500,000) / 3,000,000 = 0.55
    expect(at.dtiRatio).toBe(0.55);
    expect(at.dtiPercent).toBe(55);
    expect(at.meetsLimit).toBe(true);
    expect(at.dtiLevel).toBe('MEDIUM');
    const over = computeBsaDti(cats, { ...base, proposedMonthlyPayment: 1_150_001 });
    expect(over.dtiPercent).toBe(55);
    expect(over.meetsLimit).toBe(false);
    expect(over.dtiLevel).toBe('HIGH');
  });
});

// ───────────── Golden 3: орлого байхгүй ─────────────
describe('computeBsaDti — DTI орлого ≤ 0', () => {
  const p = params({ periodFrom: '2026-01-01', periodTo: '2026-03-31', proposedMonthlyPayment: 1_000_000 });

  it('орлого огт байхгүй + төлбөртэй → Infinity, dtiPercent хязгаарт, HIGH, хангаагүй', () => {
    const r = computeBsaDti([], p);
    expect(r.dtiRatio).toBe(Infinity);
    expect(r.dtiPercent).toBe(DTI_PERCENT_CAP);
    expect(r.dtiLevel).toBe('HIGH');
    expect(r.meetsLimit).toBe(false);
    expect(r.verifiedMonthlyIncome).toBe(0);
    expect(r.dtiIncome).toBe(0);
    expect(r.incomeReliability).toBe(0);
    expect(Number.isFinite(r.dtiPercent)).toBe(true);
    expect(JSON.parse(JSON.stringify({ dtiPercent: r.dtiPercent })).dtiPercent).toBe(999.9);
  });

  it('зөвхөн дайчлагдахгүй (жин 0) орлого → мөн Infinity', () => {
    const r = computeBsaDti([inc('INC_LOAN', 0, flat(['2026-01', '2026-02', '2026-03'], 5_000_000))], p);
    expect(r.totalMonthlyIncome).toBe(5_000_000);
    expect(r.verifiedMonthlyIncome).toBe(0);
    expect(r.dtiRatio).toBe(Infinity);
    expect(r.dtiPercent).toBe(999.9);
  });

  it('ББӨ = 100% → DTI орлого 0 → Infinity', () => {
    const r = computeBsaDti([inc('INC_SALARY', 1, flat(['2026-01', '2026-02', '2026-03'], 2_000_000))], { ...p, costOfGoodsRate: 1 });
    expect(r.verifiedMonthlyIncome).toBe(2_000_000);
    expect(r.dtiIncome).toBe(0);
    expect(r.dtiRatio).toBe(Infinity);
    expect(r.dtiLevel).toBe('HIGH');
  });

  it('төлбөр өрийн үйлчилгээ ч байхгүй (0/0) → 0%, LOW, хангана — шийдвэр: үүргийн ачаалал 0', () => {
    const r = computeBsaDti([], { ...p, proposedMonthlyPayment: 0 });
    expect(r.dtiRatio).toBe(0);
    expect(r.dtiPercent).toBe(0);
    expect(r.dtiLevel).toBe('LOW');
    expect(r.meetsLimit).toBe(true);
    expect(r.incomeReliability).toBe(0);
  });

  it('орлогогүй, санал болгосон төлбөр 0 ч одоогийн өр байвал Infinity', () => {
    const debtOnly = [exp('EXP_LOAN', 'DEBT_SERVICE', flat(['2026-01', '2026-02', '2026-03'], 100_000))];
    const r = computeBsaDti(debtOnly, { ...p, proposedMonthlyPayment: 0 });
    expect(r.existingDebtServiceMonthly).toBe(100_000);
    expect(r.dtiRatio).toBe(Infinity);
    expect(r.dtiPercent).toBe(DTI_PERCENT_CAP);
  });

  it('хязгаартай ч хязгаарлагдах: орлого маш бага (төгсгөлөг ratio) бол мөн DTI_PERCENT_CAP', () => {
    const r = computeBsaDti([inc('INC_SALARY', 1, { '2026-01': 3 })], p); // сарын дундаж 1₮, төлбөр 1,000,000₮
    expect(Number.isFinite(r.dtiRatio)).toBe(true);
    expect(r.dtiRatio).toBeGreaterThan(100);
    expect(r.dtiPercent).toBe(DTI_PERCENT_CAP);
    expect(r.dtiLevel).toBe('HIGH');
  });

  it('JSON-д аюулгүй: methodology-д Infinity/NaN байхгүй', () => {
    const r = computeBsaDti([], p);
    expect(JSON.parse(JSON.stringify(r.methodology))).toEqual(r.methodology);
  });
});

// ───────────── Хугацаа: нэг сар, хэсэгчилсэн сар, бөөрөнхийлөлт ─────────────
describe('computeBsaDti — хугацаа ба дундаж', () => {
  it('нэг сарын хугацаа: хуваагч 1', () => {
    const p = params({ periodFrom: '2026-04-01', periodTo: '2026-04-30' });
    const r = computeBsaDti([inc('INC_SALARY', 1, { '2026-04': 1_234_567.89 })], p);
    expect(r.periodMonths).toBe(1);
    expect(r.monthKeys).toEqual(['2026-04']);
    expect(r.verifiedMonthlyIncome).toBe(1_234_567.89);
    expect(r.dtiIncome).toBe(1_111_111.1); // × 0.9 = 1,111,111.101
    expect(r.incomeReliability).toBe(100);
  });

  it('нэг өдрийн хугацаа ч хуваагч 1 (0 болохгүй)', () => {
    const r = computeBsaDti([inc('INC_SALARY', 1, { '2026-04': 900 })], params({ periodFrom: '2026-04-15', periodTo: '2026-04-15' }));
    expect(r.periodMonths).toBe(1);
    expect(r.totalMonthlyIncome).toBe(900);
  });

  it('хэсэгчилсэн сар: 3 хуанлийн сар хамрагдсан ч хуваагч round(50 / 30.4375) = 2', () => {
    const r = computeBsaDti(
      [inc('INC_SALARY', 1, { '2026-01': 600_000, '2026-02': 1_000_000, '2026-03': 400_000 })],
      params({ periodFrom: '2026-01-20', periodTo: '2026-03-10', costOfGoodsRate: 0 }),
    );
    expect(r.periodMonths).toBe(2);
    expect(r.monthKeys).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(r.categories[0]).toMatchObject({ totalAmount: 2_000_000, monthlyAvg: 1_000_000, monthsPresent: 3 });
    expect(r.dtiIncome).toBe(1_000_000);
  });

  it('ROUND_HALF_UP: 2.01 / 2 сар = 1.005 → 1.01 (float-д 1.00 гарч болно); 10 / 3 = 3.33', () => {
    const twoMonths = params({ periodFrom: '2026-01-01', periodTo: '2026-02-28' });
    const two = computeBsaDti([inc('INC_SALARY', 1, { '2026-01': 1.01, '2026-02': 1 })], twoMonths);
    expect(two.periodMonths).toBe(2);
    expect(two.totalMonthlyIncome).toBe(1.01);
    expect(two.verifiedMonthlyIncome).toBe(1.01);
    const three = computeBsaDti([inc('INC_SALARY', 1, { '2026-01': 10 })], params({ periodFrom: '2026-01-01', periodTo: '2026-03-31' }));
    expect(three.totalMonthlyIncome).toBe(3.33);
  });

  it('float drift байхгүй: 0.1 + 0.2 төрлийн дүнгүүд', () => {
    const r = computeBsaDti(
      [inc('INC_SALARY', 1, { '2026-01': 0.1 }), inc('INC_OTHER', 1, { '2026-01': 0.2 })],
      params({ periodFrom: '2026-01-01', periodTo: '2026-01-31', costOfGoodsRate: 0 }),
    );
    expect(r.verifiedMonthlyIncome).toBe(0.3);
  });

  it('dtiPercent ROUND_HALF_UP: 0.55% → 0.6 (Math.round/toFixed 0.5 өгдөг), 0.0285 → 2.9', () => {
    const p = params({ periodFrom: '2026-01-01', periodTo: '2026-01-31', costOfGoodsRate: 0 });
    const salary = [inc('INC_SALARY', 1, { '2026-01': 20_000_000 })];
    expect(computeBsaDti(salary, { ...p, proposedMonthlyPayment: 110_000 }).dtiPercent).toBe(0.6);
    expect(computeBsaDti(salary, { ...p, proposedMonthlyPayment: 570_000 }).dtiPercent).toBe(2.9);
    expect(computeBsaDti(salary, { ...p, proposedMonthlyPayment: 1_370_000 }).dtiPercent).toBe(6.9);
  });

  it('оролтыг өөрчлөхгүй (deep-freeze хийсэн ангилал, параметр дээр ажиллана)', () => {
    const cats = goldenCategories();
    const prm = params();
    cats.forEach((c) => { Object.freeze(c.monthly); Object.freeze(c); });
    Object.freeze(cats);
    [prm.businessIncomeCodes, prm.irregularIncomeCodes, prm.levelThresholds, prm.reliabilityWeights, prm].forEach((o) => Object.freeze(o));
    expect(computeBsaDti(cats, prm).dtiPercent).toBe(6.8);
    expect(cats.map((c) => c.code)).toEqual(goldenCategories().map((c) => c.code));
  });

  it('сөрөг ЦМУ (бизнесийн зардал > орлого) зөв тэмдэгтэй, -0 үүсэхгүй', () => {
    const keys = ['2026-01'];
    const loss = computeBsaDti(
      [inc('INC_BUSINESS', 0.85, flat(keys, 1000)), exp('EXP_BUSINESS', 'BUSINESS_EXPENSE', flat(keys, 2000))],
      params({ periodFrom: '2026-01-01', periodTo: '2026-01-31' }),
    );
    expect(loss.netCashFlowMonthly).toBe(-1150);
    // 0.001 × 0.5 − 0.002 = −0.0015 → 2 оронд бөөрөнхийлөхөд -0 биш 0 гарна
    const tiny = computeBsaDti(
      [inc('INC_BUSINESS', 0.5, { '2026-01': 0.001 }), exp('EXP_BUSINESS', 'BUSINESS_EXPENSE', { '2026-01': 0.002 })],
      params({ periodFrom: '2026-01-01', periodTo: '2026-01-31' }),
    );
    expect(Object.is(tiny.netCashFlowMonthly, 0)).toBe(true);
  });
});

// ───────────── role-ууд ─────────────
describe('computeBsaDti — dtiRole', () => {
  const keys = ['2026-01', '2026-02'];
  const p = params({ periodFrom: '2026-01-01', periodTo: '2026-02-28', costOfGoodsRate: 0 });

  it('INFO зөвхөн categories-д; нийлбэрт орохгүй', () => {
    const cats = [
      inc('INC_SALARY', 1, flat(keys, 1000)), inc('INC_INFO', 1, flat(keys, 777), 'INFO'),
      exp('EXP_INFO', 'INFO', flat(keys, 555)), exp('EXP_HOUSE', 'HOUSEHOLD', flat(keys, 100)),
    ];
    const r = computeBsaDti(cats, p);
    expect(r.totalMonthlyIncome).toBe(1000);
    expect(r.verifiedMonthlyIncome).toBe(1000);
    expect(r.householdExpenseMonthly).toBe(100);
    expect(r.existingDebtServiceMonthly).toBe(0);
    expect(r.businessExpenseMonthly).toBe(0);
    expect(r.categories.map((c) => c.code).sort()).toEqual(['EXP_HOUSE', 'EXP_INFO', 'INC_INFO', 'INC_SALARY']);
    // INFO share: чиглэлийн суурьт орно (EXCLUDE-ээс бусад)
    expect(r.categories.find((c) => c.code === 'INC_INFO')!.share).toBeCloseTo(777 / 1777, 12);
    expect(r.categories.find((c) => c.code === 'INC_SALARY')!.share).toBeCloseTo(1000 / 1777, 12);
    expect(r.categories.find((c) => c.code === 'EXP_INFO')!.share).toBeCloseTo(555 / 655, 12);
  });

  it('role бүр зөв нийлбэрт орно', () => {
    const cats = [
      inc('INC_A', 1, flat(keys, 1000)),
      exp('EXP_DEBT_1', 'DEBT_SERVICE', flat(keys, 10)), exp('EXP_DEBT_2', 'DEBT_SERVICE', flat(keys, 20)),
      exp('EXP_H', 'HOUSEHOLD', flat(keys, 30)), exp('EXP_B', 'BUSINESS_EXPENSE', flat(keys, 40)),
    ];
    const r = computeBsaDti(cats, p);
    expect(r.existingDebtServiceMonthly).toBe(30);
    expect(r.householdExpenseMonthly).toBe(30);
    expect(r.businessExpenseMonthly).toBe(40);
  });

  it('businessIncomeCodes: зөвхөн INCOME-role, жинлэсэн; бусад role-той код нөлөөгүй; код жагсаалтад байхгүй бол 0', () => {
    const cats = [
      inc('INC_BUSINESS', 0.85, flat(keys, 1000)), inc('INC_SALARY', 1, flat(keys, 500)),
      inc('INC_BUS_INFO', 0.85, flat(keys, 9999), 'INFO'),
    ];
    const r = computeBsaDti(cats, { ...p, businessIncomeCodes: ['INC_BUSINESS', 'INC_BUS_INFO', 'NOT_PRESENT'] });
    expect(r.businessIncomeMonthly).toBe(850);
    expect(r.verifiedMonthlyIncome).toBe(1350);
    const none = computeBsaDti(cats, { ...p, businessIncomeCodes: [] });
    expect(none.businessIncomeMonthly).toBe(0);
    expect(none.netCashFlowMonthly).toBe(0);
  });

  it('EXCLUDE өөрийн данс: weight 1 ч, ямар ч дүнтэй ч нэмэгдэхгүй', () => {
    const cats = [inc('INC_SALARY', 1, flat(keys, 1000)), inc('INC_OWN', 1, flat(keys, 5_000_000), 'EXCLUDE')];
    const r = computeBsaDti(cats, p);
    expect(r.totalMonthlyIncome).toBe(1000);
    expect(r.verifiedMonthlyIncome).toBe(1000);
    expect(r.categories.find((c) => c.code === 'INC_OWN')!.share).toBe(0);
    expect(r.categories.find((c) => c.code === 'INC_SALARY')!.share).toBe(1);
  });

  it('зарлагын weightedMonthly = monthlyAvg (дайчлах хувь орлогод л үйлчилнэ; зарлагад өгсөн жинг үл тооно)', () => {
    const r = computeBsaDti([exp('EXP_H', 'HOUSEHOLD', flat(keys, 300))], p);
    expect(r.categories[0]).toMatchObject({ monthlyAvg: 300, weightedMonthly: 300, weight: 1 });
    const halfWeight = { ...exp('EXP_D', 'DEBT_SERVICE', flat(keys, 300)), weight: 0.5 };
    const h = computeBsaDti([halfWeight], p);
    expect(h.categories[0]).toMatchObject({ monthlyAvg: 300, weightedMonthly: 300, weight: 0.5 });
    expect(h.existingDebtServiceMonthly).toBe(300);
  });
});

// ───────────── categories[] ─────────────
describe('computeBsaDti — categories[] эрэмбэ ба share', () => {
  const keys = ['2026-01', '2026-02'];
  const p = params({ periodFrom: '2026-01-01', periodTo: '2026-02-28' });
  const cats = [
    exp('EXP_Z', 'HOUSEHOLD', flat(keys, 9_000)), // зарлага том ч дараа
    inc('INC_B', 1, flat(keys, 100)),
    inc('INC_A', 1, flat(keys, 100)), // INC_B-тэй тэнцүү дүн → код өсөхөөр
    inc('INC_C', 0.5, flat(keys, 300)),
    exp('EXP_A', 'INFO', flat(keys, 1_000)),
    inc('INC_EMPTY', 0, {}), // дүн байхгүй ч жагсаалтад орно
  ];

  it('орлого түрүүлж; totalAmount буурахаар; тэнцвэл код өсөхөөр', () => {
    const r = computeBsaDti(cats, p);
    expect(r.categories.map((c) => c.code)).toEqual(['INC_C', 'INC_A', 'INC_B', 'INC_EMPTY', 'EXP_Z', 'EXP_A']);
  });

  it('оролтын дараалал үр дүнд нөлөөлөхгүй', () => {
    expect(computeBsaDti([...cats].reverse(), p)).toEqual(computeBsaDti(cats, p));
  });

  it('share чиглэл бүрт нийлээд 1; хоосон ангилал share 0, monthsPresent 0', () => {
    const r = computeBsaDti(cats, p);
    const sum = (d: 'INCOME' | 'EXPENSE') => r.categories.filter((c) => c.direction === d).reduce((s, c) => s + c.share, 0);
    expect(sum('INCOME')).toBeCloseTo(1, 12);
    expect(sum('EXPENSE')).toBeCloseTo(1, 12);
    expect(r.categories.find((c) => c.code === 'INC_EMPTY')).toMatchObject({ share: 0, totalAmount: 0, monthsPresent: 0, monthlyAvg: 0 });
    expect(r.categories.find((c) => c.code === 'INC_C')!.share).toBeCloseTo(600 / 1000, 12);
  });

  it('чиглэлийн нийт дүн 0 бол share бүгд 0 (0-д хуваахгүй)', () => {
    const r = computeBsaDti([inc('INC_X', 1, flat(keys, 0)), exp('EXP_X', 'INFO', { '2026-01': 0 })], p);
    expect(r.categories.every((c) => c.share === 0)).toBe(true);
  });

  it('monthsPresent зөвхөн дүн > 0 сарыг тоолно; txnCount хэвээр', () => {
    const r = computeBsaDti([{ ...inc('INC_S', 1, { '2026-01': 100, '2026-02': 0 }), txnCount: 7 }], p);
    expect(r.categories[0]).toMatchObject({
      monthsPresent: 1, txnCount: 7, name: 'INC_S нэр', groupCode: 'T', dtiRole: 'INCOME', direction: 'INCOME',
    });
  });

  it('хоосон оролт: бүх мөнгөн утга 0, categories хоосон', () => {
    const r = computeBsaDti([], p);
    expect(r.categories).toEqual([]);
    for (const f of MONEY_FIELDS) expect(r[f]).toBe(0);
  });
});

// ───────────── incomeReliability ─────────────
describe('incomeReliability (BSA-BR-4)', () => {
  const keys4 = ['2026-01', '2026-02', '2026-03', '2026-04'];
  const w = (frequency: number, consistency: number, cleanliness: number): BsaDtiParams =>
    params({ reliabilityWeights: { frequency, consistency, cleanliness } });
  // V = [100, 100, 0, 200]; тогтмол бус 100 (1-р сар, жин 0)
  const sample = (): BsaCategoryMonthly[] => [
    inc('INC_SALARY', 1, { '2026-01': 100, '2026-02': 100, '2026-04': 200 }),
    inc('INC_IRREGULAR', 0, { '2026-01': 100 }),
  ];

  it('гараар бодсон жишээ: 0.4·0.75 + 0.4·0.2929 + 0.2·0.8 = 57.7', () => {
    // frequency 3/4; CV = √5000 / 100 = 0.7071 → 0.2929; cleanliness 1 − 100/(400+100) = 0.8
    expect(incomeReliability(sample(), w(0.4, 0.4, 0.2), keys4)).toBe(57.7);
  });

  it('бүрдэл бүрийг тусад нь: давтамж 75.0, тогтвортой 29.3, цэвэр 80.0', () => {
    expect(incomeReliability(sample(), w(1, 0, 0), keys4)).toBe(75);
    expect(incomeReliability(sample(), w(0, 1, 0), keys4)).toBe(29.3);
    expect(incomeReliability(sample(), w(0, 0, 1), keys4)).toBe(80);
  });

  it('12 сар ижил цалин → 100', () => {
    const keys12 = monthKeysBetween('2025-10-01', '2026-09-30');
    expect(keys12).toHaveLength(12);
    expect(incomeReliability([inc('INC_SALARY', 1, flat(keys12, 2_500_000))], PARAMS, keys12)).toBe(100);
    const r = computeBsaDti([inc('INC_SALARY', 1, flat(keys12, 2_500_000))], params({ periodFrom: '2025-10-01', periodTo: '2026-09-30' }));
    expect(r.periodMonths).toBe(12);
    expect(r.incomeReliability).toBe(100);
  });

  it('жин нь 0.85 гэх мэт хэсэгчилсэн ч тогтмол орлого → 100 (CV жингээс хамаарахгүй)', () => {
    expect(incomeReliability([inc('INC_BUSINESS', 0.85, flat(keys4, 777_777.77))], PARAMS, keys4)).toBe(100);
  });

  it('тогтмол бус орлого (6): сар хоорондын хэлбэлзэл найдварыг бууруулна', () => {
    const steady = incomeReliability([inc('INC_S', 1, flat(keys4, 1000))], PARAMS, keys4);
    const lumpy = incomeReliability([inc('INC_S', 1, { '2026-01': 100, '2026-02': 2900, '2026-03': 700, '2026-04': 300 })], PARAMS, keys4);
    const gap = incomeReliability([inc('INC_S', 1, { '2026-01': 1000, '2026-02': 1000, '2026-04': 1000 })], PARAMS, keys4);
    const oneOff = incomeReliability([inc('INC_S', 1, { '2026-02': 4000 })], PARAMS, keys4);
    expect(steady).toBe(100);
    expect(lumpy).toBeLessThan(steady);
    expect(gap).toBeLessThan(steady);
    expect(oneOff).toBeLessThan(gap);
    expect(lumpy).toBeGreaterThan(0);
  });

  it('тогтмол бус/хэвийн бус орлого нэмэгдэх тусам цэвэр байдал буурна', () => {
    const base = [inc('INC_SALARY', 1, flat(keys4, 1000))];
    const none = incomeReliability(base, PARAMS, keys4);
    const some = incomeReliability([...base, inc('INC_IRREGULAR', 0, flat(keys4, 500))], PARAMS, keys4);
    const lots = incomeReliability([...base, inc('INC_IRREGULAR', 0, flat(keys4, 5000))], PARAMS, keys4);
    expect(none).toBe(100);
    expect(some).toBeCloseTo(100 - 20 * (1 / 3), 0); // cleanliness 1 − 500/1500
    expect(lots).toBeLessThan(some);
  });

  it('тогтмол бус кодтой ангилал жин > 0 байвал баталгаажсан дүнд (давтамж) орно, гэхдээ цэвэр байдалд зөвхөн irregular', () => {
    // зөвхөн irregular-аар орлого оруулсан: давтамж 1, тогтвортой 1, цэвэр 0
    const r = incomeReliability([inc('INC_IRREGULAR', 0.5, flat(keys4, 1000))], w(0.4, 0.4, 0.2), keys4);
    expect(r).toBe(80);
  });

  it('0-тэй сар CV-д оролцоно: [100,100,100,0] → тогтвортой 42.3 (0-г хасвал 100 болно)', () => {
    expect(incomeReliability([inc('INC_S', 1, { '2026-01': 100, '2026-02': 100, '2026-03': 100 })], w(0, 1, 0), keys4)).toBe(42.3);
  });

  it('CV ≥ 1 бол тогтвортой байдал 0 (сөрөг болохгүй)', () => {
    expect(incomeReliability([inc('INC_S', 1, { '2026-01': 4000 })], w(0, 1, 0), keys4)).toBe(0);
  });

  it('баталгаажсан орлого байхгүй бол 0 (хоосон, зөвхөн жин 0, зөвхөн зарлага/EXCLUDE/INFO)', () => {
    expect(incomeReliability([], PARAMS, keys4)).toBe(0);
    expect(incomeReliability([inc('INC_LOAN', 0, flat(keys4, 1_000_000))], PARAMS, keys4)).toBe(0);
    expect(incomeReliability([inc('INC_IRREGULAR', 0, flat(keys4, 1_000_000))], PARAMS, keys4)).toBe(0);
    const notCounted = [inc('INC_OWN', 1, flat(keys4, 1_000_000), 'EXCLUDE'), inc('INC_INFO', 1, flat(keys4, 5), 'INFO')];
    expect(incomeReliability(notCounted, PARAMS, keys4)).toBe(0);
    expect(incomeReliability([exp('EXP_H', 'HOUSEHOLD', flat(keys4, 1_000_000))], PARAMS, keys4)).toBe(0);
    expect(incomeReliability([inc('INC_S', 1, flat(keys4, 0))], PARAMS, keys4)).toBe(0);
  });

  it('EXCLUDE нөлөөгүй: өөрийн данс орж ирсэн сар "орлоготой сар" болохгүй', () => {
    const salary = inc('INC_S', 1, { '2026-01': 100, '2026-02': 100 });
    const own = inc('INC_OWN', 1, flat(keys4, 100_000), 'EXCLUDE');
    expect(incomeReliability([salary, own], PARAMS, keys4)).toBe(incomeReliability([salary], PARAMS, keys4));
  });

  it('1 орон: ROUND_HALF_UP', () => {
    // frequency = 1/8 → 12.5 (жин 1,0,0) — 1 оронд яг
    const keys8 = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];
    expect(incomeReliability([inc('INC_S', 1, { '2026-01': 5 })], w(1, 0, 0), keys8)).toBe(12.5);
    // 0.0625 хувь тэнцэх: frequency = 1/16 = 6.25 → 6.3
    const keys16 = monthKeysBetween('2025-01-01', '2026-04-30').slice(0, 16);
    expect(incomeReliability([inc('INC_S', 1, { '2025-01': 5 })], w(1, 0, 0), keys16)).toBe(6.3);
  });

  it('оролтын шалгалт: monthKeys, жин, ангилал', () => {
    expect(() => incomeReliability([], PARAMS, [])).toThrow(/must not be empty/);
    expect(() => incomeReliability([], PARAMS, ['2026-01', '2026-01'])).toThrow(/unique/);
    expect(() => incomeReliability([], PARAMS, ['2026-13'])).toThrow(/YYYY-MM/);
    expect(() => incomeReliability([], PARAMS, ['hello'])).toThrow(RangeError);
    expect(() => incomeReliability([], w(0.5, 0.5, 0.5), keys4)).toThrow(/sum to 1/);
    expect(() => incomeReliability([inc('X', 1.2, { '2026-01': 1 })], PARAMS, keys4)).toThrow(/within 0..1/);
  });

  it('үнэлэх саруудаас гадуурх сарын дүнг тооцохгүй (хэсэгчилсэн сар) — алдаа шидэхгүй', () => {
    const inside = inc('SAL', 1, { '2026-01': 100, '2026-02': 100, '2026-03': 100, '2026-04': 100 });
    const withPartial = inc('SAL', 1, { '2026-01': 100, '2026-02': 100, '2026-03': 100, '2026-04': 100, '2026-09': 7 });
    expect(incomeReliability([withPartial], PARAMS, keys4)).toBe(incomeReliability([inside], PARAMS, keys4));
  });
});

// ───────────── Оролтын шалгалт ─────────────
describe('computeBsaDti — буруу оролт RangeError', () => {
  const okKeys = ['2026-03', '2026-04'];
  const okCats = (): BsaCategoryMonthly[] => [inc('INC_SALARY', 1, flat(okKeys, 1000))];
  const p = params({ periodFrom: '2026-03-01', periodTo: '2026-04-30' });

  it('мөнгөн дүн сөрөг / NaN / Infinity', () => {
    expect(() => computeBsaDti([inc('INC_SALARY', 1, { '2026-03': -1 })], p)).toThrow(/amount for 2026-03/);
    expect(() => computeBsaDti([inc('INC_SALARY', 1, { '2026-03': NaN })], p)).toThrow(RangeError);
    expect(() => computeBsaDti([inc('INC_SALARY', 1, { '2026-03': Infinity })], p)).toThrow(RangeError);
    expect(() => computeBsaDti(okCats(), { ...p, proposedMonthlyPayment: -1 })).toThrow(/proposedMonthlyPayment/);
    expect(() => computeBsaDti(okCats(), { ...p, proposedMonthlyPayment: NaN })).toThrow(RangeError);
    expect(() => computeBsaDti(okCats(), { ...p, proposedMonthlyPayment: Infinity })).toThrow(RangeError);
  });

  it('ББӨ ∉ 0..1', () => {
    for (const bad of [-0.01, 1.01, NaN, Infinity]) {
      expect(() => computeBsaDti(okCats(), { ...p, costOfGoodsRate: bad })).toThrow(/costOfGoodsRate/);
    }
    expect(() => computeBsaDti(okCats(), { ...p, costOfGoodsRate: 0 })).not.toThrow();
    expect(() => computeBsaDti(okCats(), { ...p, costOfGoodsRate: 1 })).not.toThrow();
  });

  it('maxDti ∉ 0..1', () => {
    for (const bad of [-0.1, 1.5, NaN]) expect(() => computeBsaDti(okCats(), { ...p, maxDti: bad })).toThrow(/maxDti/);
  });

  it('дайчлах хувь ∉ 0..1', () => {
    for (const bad of [-0.01, 1.01, NaN]) expect(() => computeBsaDti([inc('INC_SALARY', bad, flat(okKeys, 1))], p)).toThrow(/weight/);
    expect(() => computeBsaDti([inc('INC_SALARY', 0, flat(okKeys, 1)), inc('INC_B', 1, flat(okKeys, 1))], p)).not.toThrow();
  });

  it('EXCLUDE ангиллын дүн/жин ч шалгагдана', () => {
    expect(() => computeBsaDti([inc('INC_OWN', 2, flat(okKeys, 1), 'EXCLUDE')], p)).toThrow(RangeError);
    expect(() => computeBsaDti([inc('INC_OWN', 1, { '2026-03': -5 }, 'EXCLUDE')], p)).toThrow(RangeError);
  });

  it('хугацаа: from > to, буруу формат, байхгүй өдөр', () => {
    expect(() => computeBsaDti(okCats(), { ...p, periodFrom: '2026-05-01' })).toThrow(/after period end/);
    expect(() => computeBsaDti(okCats(), { ...p, periodFrom: '01.03.2026' })).toThrow(/YYYY-MM-DD/);
    expect(() => computeBsaDti(okCats(), { ...p, periodTo: '2026-04-31' })).toThrow(/not a calendar date/);
  });

  it('reliabilityWeights нийлбэр 1 биш / жин ∉ 0..1 / 1e-9 хүртэл хазайлт зөвшөөрнө', () => {
    const rw = (frequency: number, consistency: number, cleanliness: number) =>
      ({ ...p, reliabilityWeights: { frequency, consistency, cleanliness } });
    expect(() => computeBsaDti(okCats(), rw(0.4, 0.4, 0.3))).toThrow(/sum to 1/);
    expect(() => computeBsaDti(okCats(), rw(0.4, 0.4, 0.1))).toThrow(/sum to 1/);
    expect(() => computeBsaDti(okCats(), rw(0.4, 0.4, 0.2 + 1e-8))).toThrow(/sum to 1/);
    expect(() => computeBsaDti(okCats(), rw(0.4, 0.4, 0.2 + 1e-10))).not.toThrow();
    expect(() => computeBsaDti(okCats(), rw(-0.2, 0.7, 0.5))).toThrow(/reliabilityWeights.frequency/);
    expect(() => computeBsaDti(okCats(), rw(0.5, 1.5, -1))).toThrow(/reliabilityWeights.consistency/);
    expect(() => computeBsaDti(okCats(), rw(0.5, 0.5, NaN))).toThrow(/reliabilityWeights.cleanliness/);
  });

  it('levelThresholds', () => {
    expect(() => computeBsaDti(okCats(), { ...p, levelThresholds: { lowMax: 0.6, mediumMax: 0.5 } })).toThrow(/must not exceed/);
    expect(() => computeBsaDti(okCats(), { ...p, levelThresholds: { lowMax: -1, mediumMax: 0.5 } })).toThrow(/lowMax/);
  });

  it('хугацаанаас гадуурх сарын дүн (дундажийг бүдгэрүүлнэ) → RangeError', () => {
    expect(() => computeBsaDti([inc('INC_SALARY', 1, { '2026-02': 100 })], p)).toThrow(/outside the analysis period/);
    expect(() => computeBsaDti([inc('INC_SALARY', 1, { '2026-05': 100 })], p)).toThrow(/outside the analysis period/);
    expect(() => computeBsaDti([inc('INC_SALARY', 1, { bad: 100 })], p)).toThrow(RangeError);
  });

  it('ангиллын код давхардвал (давхар тооцоо) RangeError', () => {
    const twice = [inc('INC_A', 1, { '2026-03': 1 }), inc('INC_A', 1, { '2026-04': 1 })];
    expect(() => computeBsaDti(twice, p)).toThrow(/duplicate category code/);
  });

  it('txnCount бүхэл тоо ≥ 0', () => {
    expect(() => computeBsaDti([{ ...inc('INC_A', 1, { '2026-03': 1 }), txnCount: -1 }], p)).toThrow(/txnCount/);
    expect(() => computeBsaDti([{ ...inc('INC_A', 1, { '2026-03': 1 }), txnCount: 1.5 }], p)).toThrow(/txnCount/);
  });

  it('dtiRole чиглэлтэйгээ зөрвөл (орлогыг зарлага болгох) RangeError', () => {
    expect(() => computeBsaDti([exp('X', 'INCOME', { '2026-03': 1 })], p)).toThrow(/requires direction INCOME/);
    expect(() => computeBsaDti([inc('X', 1, { '2026-03': 1 }, 'DEBT_SERVICE')], p)).toThrow(/requires direction EXPENSE/);
    expect(() => computeBsaDti([inc('X', 1, { '2026-03': 1 }, 'HOUSEHOLD')], p)).toThrow(RangeError);
    expect(() => computeBsaDti([inc('X', 1, { '2026-03': 1 }, 'BUSINESS_EXPENSE')], p)).toThrow(RangeError);
    // EXCLUDE/INFO аль ч чиглэлд зөвшөөрөгдөнө
    const neutral = [inc('X', 0, { '2026-03': 1 }, 'EXCLUDE'), exp('Y', 'EXCLUDE', { '2026-03': 1 }), exp('Z', 'INFO', {})];
    expect(() => computeBsaDti(neutral, p)).not.toThrow();
  });

  it('алдааны мессеж PII агуулахгүй (код, сар, тоо л)', () => {
    try {
      computeBsaDti([inc('INC_SALARY', 1, { '2026-03': -1 })], p);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toBe('category INC_SALARY amount for 2026-03 must be a finite number >= 0, got -1');
    }
  });
});

// ───────────── Property-style ─────────────
describe('computeBsaDti — property-style', () => {
  const Q1 = ['2026-01', '2026-02', '2026-03'];
  const fixtures: Array<[string, BsaCategoryMonthly[], BsaDtiParams]> = [
    ['golden', goldenCategories(), params({ proposedMonthlyPayment: 1_234_567 })],
    [
      'AC',
      [inc('INC_SALARY', 1, flat(Q1, 3_000_000)), exp('EXP_LOAN', 'DEBT_SERVICE', flat(Q1, 500_000))],
      params({ periodFrom: '2026-01-01', periodTo: '2026-03-31', costOfGoodsRate: 0, proposedMonthlyPayment: 1_176_828 }),
    ],
    [
      'lumpy',
      [
        inc('INC_BUSINESS', 0.85, { '2026-01': 1_300_000, '2026-02': 4_700_000, '2026-03': 900_000, '2026-04': 2_200_000 }),
        inc('INC_IRREGULAR', 0, { '2026-02': 800_000 }),
        exp('EXP_BUSINESS', 'BUSINESS_EXPENSE', { '2026-01': 400_000, '2026-03': 100_000 }),
        exp('EXP_FIXED', 'HOUSEHOLD', flat(['2026-01', '2026-02', '2026-03', '2026-04'], 333_333)),
      ],
      params({ periodFrom: '2026-01-01', periodTo: '2026-04-30', proposedMonthlyPayment: 777_777 }),
    ],
  ];

  describe.each(fixtures)('k-ээр үржүүлэхэд (%s)', (_name, cats, p) => {
    const one = computeBsaDti(cats, p);
    it.each([0.5, 2, 3, 10, 1000])('k = %s: мөнгө k-аар, хувь/найдвар/түвшин өөрчлөгдөхгүй', (k) => {
      const r = computeBsaDti(scaled(cats, k), { ...p, proposedMonthlyPayment: p.proposedMonthlyPayment * k });
      for (const f of MONEY_FIELDS) expect(Math.abs(r[f] - one[f] * k)).toBeLessThanOrEqual(0.005 * (k + 1) + 1e-6);
      expect(r.dtiPercent).toBe(one.dtiPercent);
      expect(r.dtiRatio).toBeCloseTo(one.dtiRatio, 10);
      expect(r.incomeReliability).toBe(one.incomeReliability);
      expect(r.dtiLevel).toBe(one.dtiLevel);
      expect(r.meetsLimit).toBe(one.meetsLimit);
      expect(r.periodMonths).toBe(one.periodMonths);
      expect(r.monthKeys).toEqual(one.monthKeys);
      expect(r.categories.map((c) => c.code)).toEqual(one.categories.map((c) => c.code));
      r.categories.forEach((c, i) => {
        expect(c.share).toBeCloseTo(one.categories[i].share, 10);
        expect(c.monthsPresent).toBe(one.categories[i].monthsPresent);
      });
    });
  });

  describe.each(fixtures)('EXCLUDE ангилал нэмэхэд юу ч өөрчлөгдөхгүй (%s)', (_name, cats, p) => {
    const one = computeBsaDti(cats, p);
    const months = Object.keys(cats[0].monthly);
    const noise: BsaCategoryMonthly[] = [
      inc('INC_OWN_X', 1, flat(months, 987_654_321), 'EXCLUDE'),
      exp('EXP_OWN_X', 'EXCLUDE', flat(months, 123_456_789)),
    ];
    it('бүх тоо, найдвар, өөр ангиллын share ижил', () => {
      // EXCLUDE ангиллыг бизнес/тогтмол бус кодод нэмж оруулсан ч нөлөөлөхгүй
      const r = computeBsaDti([...cats, ...noise], {
        ...p,
        businessIncomeCodes: [...p.businessIncomeCodes, 'INC_OWN_X'],
        irregularIncomeCodes: [...p.irregularIncomeCodes, 'INC_OWN_X', 'EXP_OWN_X'],
      });
      const { categories: rc, methodology: rm, ...rest } = r;
      const { categories: oc, methodology: om, ...restOne } = one;
      expect(rest).toEqual(restOne);
      expect(rc.filter((c) => !c.code.endsWith('_OWN_X'))).toEqual(oc);
      expect(rc.filter((c) => c.code.endsWith('_OWN_X')).every((c) => c.share === 0 && c.weightedMonthly === 0)).toBe(true);
      // аргачлалын дүнгүүд ижил (inputs-д categoryCount өөрчлөгдөж болохгүй)
      expect(rm.map((s) => [s.key, s.value])).toEqual(om.map((s) => [s.key, s.value]));
    });
  });

  it('seeded санамсаргүй багц: инвариантууд (deterministic)', () => {
    let seed = 20261028;
    const rand = (): number => { // mulberry32
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const roles: BsaDtiRole[] = ['DEBT_SERVICE', 'HOUSEHOLD', 'BUSINESS_EXPENSE', 'EXCLUDE', 'INFO'];
    for (let iter = 0; iter < 150; iter++) {
      const keys = monthKeysBetween('2025-06-15', '2026-02-10');
      const pick = (): Record<string, number> =>
        Object.fromEntries(keys.filter(() => rand() < 0.7).map((k) => [k, Math.round(rand() * 5_000_000) / 100]));
      const cats: BsaCategoryMonthly[] = [];
      for (let i = 0; i < 1 + Math.floor(rand() * 6); i++) {
        cats.push(inc(`I${i}`, Math.round(rand() * 100) / 100, pick(), rand() < 0.15 ? 'EXCLUDE' : 'INCOME'));
      }
      for (let i = 0; i < Math.floor(rand() * 5); i++) cats.push(exp(`E${i}`, roles[Math.floor(rand() * roles.length)], pick()));
      const p = params({
        periodFrom: '2025-06-15', periodTo: '2026-02-10',
        proposedMonthlyPayment: Math.round(rand() * 1_000_000), costOfGoodsRate: Math.round(rand() * 100) / 100,
        businessIncomeCodes: ['I0', 'I1'], irregularIncomeCodes: ['I2'],
      });
      const r = computeBsaDti(cats, p);
      expect(r.incomeReliability).toBeGreaterThanOrEqual(0);
      expect(r.incomeReliability).toBeLessThanOrEqual(100);
      expect(r.businessIncomeMonthly).toBeLessThanOrEqual(r.verifiedMonthlyIncome + 0.005);
      expect(r.verifiedMonthlyIncome).toBeLessThanOrEqual(r.totalMonthlyIncome + 0.005);
      expect(r.dtiIncome).toBeLessThanOrEqual(r.verifiedMonthlyIncome + 0.005);
      expect(Math.abs(r.netCashFlowMonthly - (r.businessIncomeMonthly - r.businessExpenseMonthly))).toBeLessThanOrEqual(0.0100001);
      expect(r.dtiPercent).toBeLessThanOrEqual(DTI_PERCENT_CAP);
      expect(r.meetsLimit).toBe(r.dtiRatio <= p.maxDti);
      expect(r.categories).toHaveLength(cats.length);
      for (const d of ['INCOME', 'EXPENSE'] as const) {
        const rows = r.categories.filter((c) => c.direction === d && c.dtiRole !== 'EXCLUDE');
        const total = rows.reduce((s, c) => s + c.totalAmount, 0);
        const shares = rows.reduce((s, c) => s + c.share, 0);
        expect(Math.abs(shares - (total > 0 ? 1 : 0))).toBeLessThan(1e-9);
      }
      expect(JSON.parse(JSON.stringify(r.methodology))).toEqual(r.methodology);
    }
  });
});

// ───────────── methodology (BSA-FR-4.3) ─────────────
describe('computeBsaDti — methodology', () => {
  const r: BsaDtiResult = computeBsaDti(goldenCategories(), params({ proposedMonthlyPayment: 2_000_000 }));
  const byKey = (key: string) => r.methodology.find((s) => s.key === key)!;

  it('алхам дарааллаар, 1-ээс дугаарласан, түлхүүр давтагдахгүй', () => {
    expect(r.methodology.map((s) => s.key)).toEqual([
      'period_months', 'total_income', 'total_expense', 'weighted_income', 'cogs_adjustment', 'business_income', 'business_expense',
      'net_cash_flow', 'debt_service', 'household_expense', 'dti_numerator', 'dti_ratio', 'dti_level', 'income_reliability',
    ]);
    expect(r.methodology.map((s) => s.step)).toEqual(r.methodology.map((_s, i) => i + 1));
  });

  it('алхам бүр монгол нэр, томьёотой; оролт/утга төгсгөлөг тоо', () => {
    for (const s of r.methodology) {
      expect(s.label).toMatch(/[Ѐ-ӿ]/);
      expect(s.formula).toMatch(/[Ѐ-ӿ]/);
      expect(Number.isFinite(s.value)).toBe(true);
      for (const v of Object.values(s.inputs)) if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('утгууд үр дүнгийн талбартай таарна', () => {
    expect(byKey('period_months').value).toBe(r.periodMonths);
    expect(byKey('total_income').value).toBe(r.totalMonthlyIncome);
    expect(byKey('weighted_income').value).toBe(r.verifiedMonthlyIncome);
    expect(byKey('cogs_adjustment').value).toBe(r.dtiIncome);
    expect(byKey('business_income').value).toBe(r.businessIncomeMonthly);
    expect(byKey('business_expense').value).toBe(r.businessExpenseMonthly);
    expect(byKey('net_cash_flow').value).toBe(r.netCashFlowMonthly);
    expect(byKey('debt_service').value).toBe(r.existingDebtServiceMonthly);
    expect(byKey('household_expense').value).toBe(r.householdExpenseMonthly);
    expect(byKey('dti_ratio').value).toBe(r.dtiPercent);
    expect(byKey('dti_level').value).toBe(r.dtiPercent);
    expect(byKey('income_reliability').value).toBe(r.incomeReliability);
  });

  it('оролтууд тооцоог дахин хийхэд хангалттай (аудит)', () => {
    expect(byKey('period_months').inputs).toEqual({ periodFrom: '2026-03-10', periodTo: '2026-09-10', days: 185, daysPerMonth: 30.4375 });
    expect(byKey('total_income').inputs).toMatchObject({ incomeTotal: 229_922_826, periodMonths: 6, categoryCount: 11 });
    expect(byKey('total_expense').inputs).toMatchObject({ expenseTotal: 22_555_866, periodMonths: 6 });
    expect(byKey('total_expense').value).toBe(3_759_311); // 700k+300k+800k+1.2M+500k+247,311+12k; EXCLUDE (180M) орохгүй
    expect(byKey('cogs_adjustment').inputs).toEqual({ verifiedMonthlyIncome: 16_315_866, costOfGoodsRate: 0.1 });
    expect(byKey('business_income').inputs).toEqual({ businessIncomeCodes: 'INC_BUSINESS', categoryCount: 1 });
    expect(byKey('dti_numerator')).toMatchObject({
      inputs: { proposedMonthlyPayment: 2_000_000, existingDebtServiceMonthly: 1_000_000 }, value: 3_000_000,
    });
    expect(byKey('dti_ratio').inputs).toEqual({ totalMonthlyPayment: 3_000_000, dtiIncome: 14_684_279.4 });
    expect(byKey('dti_level').inputs).toEqual({
      dtiPercent: 20.4, lowMaxPercent: 35, mediumMaxPercent: 55, maxDtiPercent: 55, level: 'LOW', meetsLimit: 'true',
    });
    expect(byKey('income_reliability').inputs).toMatchObject({
      frequencyPercent: 100, consistencyPercent: 100, cleanlinessPercent: 76.1, wFrequency: 0.4, monthsAssessed: 5,
    });
  });

  it('weighted_income: жин > 0 орлогын ангиллын тоо', () => {
    expect(byKey('weighted_income').inputs).toEqual({ totalMonthlyIncome: 38_320_471, weightedCategoryCount: 6 });
  });

  it('бүтэлгүй хязгаарт: dti_level meetsLimit "false", HIGH', () => {
    const bad = computeBsaDti(goldenCategories(), params({ proposedMonthlyPayment: 20_000_000 }));
    expect(bad.methodology.find((s) => s.key === 'dti_level')!.inputs).toMatchObject({ level: 'HIGH', meetsLimit: 'false' });
  });

  it('businessIncomeCodes олон бол таслалаар', () => {
    const multi = computeBsaDti(goldenCategories(), params({ businessIncomeCodes: ['INC_BUSINESS', 'INC_CONTRACT'] }));
    expect(multi.methodology.find((s) => s.key === 'business_income')!.inputs)
      .toEqual({ businessIncomeCodes: 'INC_BUSINESS,INC_CONTRACT', categoryCount: 2 });
    expect(multi.businessIncomeMonthly).toBe(15_505_633); // 15,453,132.9995 + 52,500
  });
});

// ───────────── BSA-BR-4: хэсэгчилсэн сарууд найдварт нөлөөлөхгүй ─────────────
describe('income reliability — partial edge months', () => {
  const salaryOn25th = (keys: string[]) => inc('SALARY', 1, flat(keys, 1_000_000));
  const reliabilityOf = (from: string, to: string, cats: BsaCategoryMonthly[]) => computeBsaDti(cats, params({ periodFrom: from, periodTo: to }));

  it('сарын 25-нд цалин авдаг хүн, 2026-03-10..2026-09-10 → 100 (9-р сарын 1–10 цалингүй байх нь «дутуу сар» биш)', () => {
    const r = reliabilityOf('2026-03-10', '2026-09-10', [salaryOn25th(['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'])]);
    expect(r.incomeReliability).toBe(100);
    expect(r.methodology.find((m) => m.key === 'income_reliability')?.inputs).toMatchObject({ monthsAssessed: 5 });
  });

  it('хугацаа сарын 1-нд эхэлж сүүлийн өдөр дуусвал бүх сар үнэлэгдэнэ (тасарсан сар найдварыг бууруулна)', () => {
    const keys = ['2026-03', '2026-04', '2026-05', '2026-06'];
    const full = reliabilityOf('2026-03-01', '2026-06-30', [inc('SALARY', 1, { '2026-03': 1_000_000, '2026-04': 1_000_000, '2026-06': 1_000_000 })]);
    expect(full.methodology.find((m) => m.key === 'income_reliability')?.inputs).toMatchObject({ monthsAssessed: keys.length });
    expect(full.incomeReliability).toBeLessThan(100); // 5-р сар хоосон
  });

  it('бүтэн сар 2-оос цөөн бол бүх хуанлийн сарыг үнэлнэ (илүү мэдээлэл байхгүй)', () => {
    const none = reliabilityOf('2026-03-10', '2026-04-20', [inc('SALARY', 1, { '2026-03': 500_000, '2026-04': 500_000 })]);
    expect(none.methodology.find((m) => m.key === 'income_reliability')?.inputs).toMatchObject({ monthsAssessed: 2 });
    const one = reliabilityOf('2026-02-20', '2026-04-10', [inc('SALARY', 1, { '2026-02': 1, '2026-03': 1_000_000, '2026-04': 1 })]);
    expect(one.methodology.find((m) => m.key === 'income_reliability')?.inputs).toMatchObject({ monthsAssessed: 3 });
  });

  it('хугацаа сарын дундаас эхэлж сарын сүүлийн өдөр дуусвал зөвхөн эхний сар хасагдана', () => {
    const r = reliabilityOf('2026-03-10', '2026-06-30', [salaryOn25th(['2026-03', '2026-04', '2026-05', '2026-06'])]);
    expect(r.methodology.find((m) => m.key === 'income_reliability')?.inputs).toMatchObject({ monthsAssessed: 3 });
    expect(r.incomeReliability).toBe(100);
  });
});

// ───────────── toScoringPatch (INT-5) ─────────────
describe('toScoringPatch', () => {
  const g = computeBsaDti(goldenCategories(), params());
  const input: BsaScoringInput = {
    analysisId: 'a-1', loanApplicationId: '4118', borrowerId: '1', version: 2, status: 'ANALYZED',
    periodMonths: g.periodMonths, transactionCount: 2483,
    businessIncomeMonthly: g.businessIncomeMonthly, businessExpenseMonthly: g.businessExpenseMonthly,
    businessNcfMonthly: g.netCashFlowMonthly,
    householdExpenseMonthly: g.householdExpenseMonthly, existingDebtServiceMonthly: g.existingDebtServiceMonthly,
    verifiedMonthlyIncome: g.verifiedMonthlyIncome, dtiIncomeMonthly: g.dtiIncome, dtiPercent: g.dtiPercent,
    incomeReliability: g.incomeReliability, pendingSuspiciousCount: 250,
  };

  it('ScoreRequest болон Sosco оролтын хэсэг рүү зураглана', () => {
    expect(toScoringPatch(input)).toEqual({
      scoreRequest: { businessNcfMonthly: 15_205_822, existingDebtServiceMonthly: 1_000_000, householdExpenseMonthly: 2_000_000 },
      sosco: { dtiPercent: 6.8, incomeReliability: 95.2, pendingSuspiciousCount: 250 },
    });
  });

  it('зөвхөн заасан талбарууд (илүү талбар алдагдахгүй), оролтыг өөрчлөхгүй', () => {
    const frozen = Object.freeze({ ...input });
    const patch = toScoringPatch(frozen);
    expect(Object.keys(patch.scoreRequest).sort()).toEqual(['businessNcfMonthly', 'existingDebtServiceMonthly', 'householdExpenseMonthly']);
    expect(Object.keys(patch.sosco).sort()).toEqual(['dtiPercent', 'incomeReliability', 'pendingSuspiciousCount']);
    expect(frozen).toEqual(input);
  });

  it('хязгаарласан DTI 999.9, сөрөг ЦМУ, 0 дохио хэвээр дамжина', () => {
    const patch = toScoringPatch({ ...input, dtiPercent: DTI_PERCENT_CAP, businessNcfMonthly: -500, pendingSuspiciousCount: 0 });
    expect(patch.sosco).toEqual({ dtiPercent: 999.9, incomeReliability: 95.2, pendingSuspiciousCount: 0 });
    expect(patch.scoreRequest.businessNcfMonthly).toBe(-500);
  });
});
