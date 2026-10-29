import { describe, expect, it } from 'vitest';
import { Prisma } from '.prisma/client-origination';
import { annuityPayment } from '@los/calc';
import { ScoreRequest, SoscoInput, type ScoreLimits } from '@los/contracts';
import {
  aggregateIncome, buildScoreRequest, buildSoscoInput, existingDebtService, limitViolations, newMonthlyPayment, readBsaFacts, resolveLimits, resolvePolicy, resolveStress, resolveTerms,
  sanitizeCreditHistory, SOSCO_UNSERVICEABLE_DTI_PERCENT, termsBlockers, LOAN_TERMS_MISSING_REASON, type BsaFacts, type ProductRow,
} from './score-input.assembler';
import { methodVerdict, underwriteResult } from './testing/scoring-fixtures';

const D = (v: string | number) => new Prisma.Decimal(v);
const BASE = { dtiMax: 0.55, dscrMin: 1.25, ltvMax: 0.7, weightThreshold: 0.7 };
const PRODUCT: ProductRow = {
  minAmount: D('100000'), maxAmount: D('50000000.00'), minTerm: 1, maxTerm: 36, minRate: D('18.0000'), maxRate: D('42.0000'),
  requiresCollateral: false, maxLtv: null, maxDti: null, minDscr: null, calcWeightThreshold: null,
};
const NO_BSA: BsaFacts = { analyzed: false, existingDebtServiceMonthly: null, dtiPercent: null, incomeReliability: null, pendingSuspiciousCount: null };

describe('resolveTerms · зээлийн нөхцөл (FR-8.3, LOAN_TERMS_MISSING)', () => {
  it('бүрэн хадгалагдсан нөхцөл → terms = saved, override-гүй', () => {
    const r = resolveTerms({ amount: D('10000000.00'), termMonths: 12, interestRate: D('23.9900') });
    expect(r.terms).toEqual({ amount: 10_000_000, termMonths: 12, interestRate: 23.99 });
    expect(r.saved).toEqual(r.terms);
    expect(r.overridden).toBe(false);
  });

  it.each([
    ['дүн дутуу', { amount: null, termMonths: 12, interestRate: D(24) }],
    ['хугацаа дутуу', { amount: D(1000), termMonths: null, interestRate: D(24) }],
    ['хүү дутуу', { amount: D(1000), termMonths: 12, interestRate: null }],
    ['дүн 0', { amount: D(0), termMonths: 12, interestRate: D(24) }],
    ['хугацаа 0', { amount: D(1000), termMonths: 0, interestRate: D(24) }],
    ['бүгд хоосон', { amount: null, termMonths: null, interestRate: null }],
  ])('%s → terms=null ба саад LOAN_TERMS_MISSING (алхам loan)', (_n, saved) => {
    const r = resolveTerms(saved);
    expect(r.terms).toBeNull();
    expect(termsBlockers(r.terms)).toEqual([LOAN_TERMS_MISSING_REASON]);
    expect(LOAN_TERMS_MISSING_REASON).toMatchObject({ code: 'LOAN_TERMS_MISSING', step: 'loan' });
  });

  it('хүү 0 зөвшөөрөгдөнө (хүүгүй зээл)', () => {
    expect(resolveTerms({ amount: D(1000), termMonths: 3, interestRate: D(0) }).terms).toEqual({ amount: 1000, termMonths: 3, interestRate: 0 });
  });

  it('preview override: өгөөгүй талбар = хадгалагдсан; ялгаатай бол overridden', () => {
    const saved = { amount: D(10_000_000), termMonths: 12, interestRate: D(24) };
    expect(resolveTerms(saved, { amount: 5_000_000 })).toMatchObject({ terms: { amount: 5_000_000, termMonths: 12, interestRate: 24 }, overridden: true });
    expect(resolveTerms(saved, { termMonths: 24, interestRate: 20 }).terms).toEqual({ amount: 10_000_000, termMonths: 24, interestRate: 20 });
    expect(resolveTerms(saved, { amount: 10_000_000, termMonths: 12, interestRate: 24 }).overridden).toBe(false); // ижил утга override биш
  });

  it('хадгалагдсан нөхцөл дутуу ч override бүрэн болговол preview хийж болно (saved=null)', () => {
    const r = resolveTerms({ amount: null, termMonths: null, interestRate: null }, { amount: 2_000_000, termMonths: 6, interestRate: 30 });
    expect(r.saved).toBeNull();
    expect(r.terms).toEqual({ amount: 2_000_000, termMonths: 6, interestRate: 30 });
    expect(r.overridden).toBe(true);
  });
});

describe('resolveLimits / limitViolations · BR-6', () => {
  const limits = resolveLimits(PRODUCT) as ScoreLimits;

  it('product → ScoreLimits (Decimal → number); бүтээгдэхүүнгүй бол null', () => {
    expect(limits).toEqual({ minAmount: 100_000, maxAmount: 50_000_000, minTermMonths: 1, maxTermMonths: 36, minRate: 18, maxRate: 42 });
    expect(resolveLimits(null)).toBeNull();
  });

  it('зөвхөн ӨГСӨН талбарыг шалгана; хил (min/max) зөвшөөрөгдөнө', () => {
    expect(limitViolations({}, limits)).toEqual([]);
    expect(limitViolations({ amount: 100_000, termMonths: 36, interestRate: 18 }, limits)).toEqual([]);
    expect(limitViolations({ amount: 50_000_000, termMonths: 1, interestRate: 42 }, limits)).toEqual([]);
  });

  it('хязгаараас гарсан талбар бүрийг жагсаана', () => {
    expect(limitViolations({ amount: 99_999, termMonths: 37, interestRate: 17.99 }, limits)).toEqual([
      { field: 'amount', value: 99_999, min: 100_000, max: 50_000_000 },
      { field: 'termMonths', value: 37, min: 1, max: 36 },
      { field: 'interestRate', value: 17.99, min: 18, max: 42 },
    ]);
    expect(limitViolations({ amount: 50_000_001 }, limits)).toHaveLength(1);
  });

  it('хязгаар байхгүй (бүтээгдэхүүнгүй) бол шалгахгүй', () => {
    expect(limitViolations({ amount: 1 }, null)).toEqual([]);
  });
});

describe('resolvePolicy · BR-1…BR-4 (setting, product override)', () => {
  it('бүтээгдэхүүнгүй / override-гүй бол setting', () => {
    const expected = { maxDti: 0.55, minDscr: 1.25, maxLtv: 0.7, weightThreshold: 0.7 };
    expect(resolvePolicy(BASE, null)).toEqual(expected);
    expect(resolvePolicy(BASE, PRODUCT)).toEqual(expected);
  });

  it('бүтээгдэхүүний өөрийн утга (null биш) давамгайлна — талбар бүр тусдаа', () => {
    expect(resolvePolicy(BASE, { ...PRODUCT, maxDti: D('0.4'), minDscr: D('1.5'), maxLtv: D('0.6'), calcWeightThreshold: D('0.8') })).toEqual({ maxDti: 0.4, minDscr: 1.5, maxLtv: 0.6, weightThreshold: 0.8 });
    expect(resolvePolicy(BASE, { ...PRODUCT, maxLtv: D('0.5') })).toEqual({ maxDti: 0.55, minDscr: 1.25, maxLtv: 0.5, weightThreshold: 0.7 });
  });

  it('setting өөр утгатай бол (BR hardcode биш) тэр утга гарна', () => {
    expect(resolvePolicy({ dtiMax: 0.5, dscrMin: 1.4, ltvMax: 0.65, weightThreshold: 0.75 }, null)).toEqual({ maxDti: 0.5, minDscr: 1.4, maxLtv: 0.65, weightThreshold: 0.75 });
  });

  it('схемд нийцэхгүй override-ыг (0, >1) үл тоож setting-ээр орлуулна', () => {
    expect(resolvePolicy(BASE, { ...PRODUCT, maxDti: D('0'), maxLtv: D('1.5'), calcWeightThreshold: D('2'), minDscr: D('0') })).toEqual({ maxDti: 0.55, minDscr: 1.25, maxLtv: 0.7, weightThreshold: 0.7 });
  });

  it('weightThreshold 0 хүчинтэй (бүх орлого "давамгайлна")', () => {
    expect(resolvePolicy(BASE, { ...PRODUCT, calcWeightThreshold: D('0') }).weightThreshold).toBe(0);
  });
});

describe('resolveStress · FR-8.5', () => {
  it('stress.rate_delta (бутархай) × 100 = п.п.; income_delta хэвээр', () => {
    expect(resolveStress(0.05, -0.2)).toEqual({ rateDeltaPoints: 5, incomeChange: -0.2 });
  });
  it('float алдаагүй (0.07 × 100 = 7.000000000000001 биш)', () => {
    expect(resolveStress(0.07, -0.1)).toEqual({ rateDeltaPoints: 7, incomeChange: -0.1 });
    expect(resolveStress(0.035, -0.25)?.rateDeltaPoints).toBe(3.5);
  });
  it('0 / 0 хүчинтэй; контрактын мужаас гарвал stress-гүй (undefined)', () => {
    expect(resolveStress(0, 0)).toEqual({ rateDeltaPoints: 0, incomeChange: 0 });
    expect(resolveStress(-0.01, -0.2)).toBeUndefined();
    expect(resolveStress(0.05, 0.2)).toBeUndefined(); // орлого өсөх нь stress биш
    expect(resolveStress(0.05, -1.5)).toBeUndefined();
    expect(resolveStress(2, -0.2)).toBeUndefined(); // +200 п.п.
  });
});

describe('aggregateIncome · цалин/ЦМУ нэгтгэл, өрхийн зардал (Q-M8-10)', () => {
  const row = (customerId: string, salary: number | null, ncf: number | null, household: number | null = null) =>
    ({ customerId, avgSalaryMonthly: salary === null ? null : D(salary), businessNcfMonthly: ncf === null ? null : D(ncf), householdExpenseMonthly: household === null ? null : D(household) });
  const primary = { customerId: 'p', role: 'PRIMARY', incomeIncluded: true };

  it('зөвхөн үндсэн зээлдэгч', () => {
    expect(aggregateIncome([primary], [row('p', 3_000_000, 1_500_000, 800_000)])).toEqual({
      primaryCustomerId: 'p', salaryMonthly: 3_000_000, businessNcfMonthly: 1_500_000, householdExpenseMonthly: 800_000, contributors: ['p'],
    });
  });

  it('үндсэн зээлдэгчийн incomeIncluded=false ч үндсэн нь үргэлж орно', () => {
    expect(aggregateIncome([{ ...primary, incomeIncluded: false }], [row('p', 1_000_000, 0)]).salaryMonthly).toBe(1_000_000);
  });

  it('income_included=true хамтран зээлдэгчийн орлого нэмэгдэнэ; өрхийн зардал ЗӨВХӨН үндсэнийх', () => {
    const r = aggregateIncome(
      [primary, { customerId: 'c', role: 'CO_BORROWER', incomeIncluded: true }],
      [row('p', 3_000_000, 1_000_000, 800_000), row('c', 2_000_000, 500_000, 700_000)],
    );
    expect(r).toMatchObject({ salaryMonthly: 5_000_000, businessNcfMonthly: 1_500_000, householdExpenseMonthly: 800_000 });
    expect(r.contributors.sort()).toEqual(['c', 'p']);
  });

  it('income_included=false хамтран зээлдэгчийн орлого орохгүй', () => {
    const r = aggregateIncome([primary, { customerId: 'c', role: 'CO_BORROWER', incomeIncluded: false }], [row('p', 3_000_000, null), row('c', 2_000_000, 400_000)]);
    expect(r).toMatchObject({ salaryMonthly: 3_000_000, businessNcfMonthly: 0, contributors: ['p'] });
  });

  it('батлан даагч / барьцаалагчийн орлого incomeIncluded=true байсан ч орохгүй', () => {
    const r = aggregateIncome(
      [primary, { customerId: 'g', role: 'GUARANTOR', incomeIncluded: true }, { customerId: 'l', role: 'PLEDGOR', incomeIncluded: true }],
      [row('p', 1_000_000, 0), row('g', 9_000_000, 9_000_000), row('l', 9_000_000, 9_000_000)],
    );
    expect(r).toMatchObject({ salaryMonthly: 1_000_000, businessNcfMonthly: 0, contributors: ['p'] });
  });

  it('алдагдалтай бизнес (сөрөг ЦМУ) хадгалагдана; бусад оролцогчийн ЦМУ-тэй цэвэр нийлбэр', () => {
    expect(aggregateIncome([primary], [row('p', 0, -250_000)]).businessNcfMonthly).toBe(-250_000);
    const r = aggregateIncome([primary, { customerId: 'c', role: 'CO_BORROWER', incomeIncluded: true }], [row('p', 0, 1_000_000), row('c', 0, -400_000)]);
    expect(r.businessNcfMonthly).toBe(600_000);
  });

  it('null талбар = 0; орлогын мөр огт байхгүй бол бүгд 0', () => {
    expect(aggregateIncome([primary], [row('p', null, null, null)])).toMatchObject({ salaryMonthly: 0, businessNcfMonthly: 0, householdExpenseMonthly: 0 });
    expect(aggregateIncome([primary], [])).toMatchObject({ salaryMonthly: 0, businessNcfMonthly: 0, householdExpenseMonthly: 0 });
  });

  it('үндсэн зээлдэгчгүй: зөвхөн income_included хамтран зээлдэгч, өрхийн зардал 0', () => {
    const r = aggregateIncome([{ customerId: 'c', role: 'CO_BORROWER', incomeIncluded: true }], [row('c', 2_000_000, 0, 500_000)]);
    expect(r).toMatchObject({ primaryCustomerId: null, salaryMonthly: 2_000_000, householdExpenseMonthly: 0 });
    expect(aggregateIncome([], [])).toMatchObject({ primaryCustomerId: null, salaryMonthly: 0, contributors: [] });
  });

  it('Decimal нийлбэр float алдаагүй (0.1 + 0.2 = 0.3)', () => {
    const r = aggregateIncome([primary, { customerId: 'c', role: 'CO_BORROWER', incomeIncluded: true }], [row('p', 0.1, 0.1), row('c', 0.2, 0.2)]);
    expect(r.salaryMonthly).toBe(0.3);
    expect(r.businessNcfMonthly).toBe(0.3);
  });

  it('сөрөг цалин / өрхийн зардал (өгөгдлийн алдаа) 0 болно — Money схемийг эвдэхгүй', () => {
    expect(aggregateIncome([primary], [row('p', -5, 0, -9)])).toMatchObject({ salaryMonthly: 0, householdExpenseMonthly: 0 });
  });

  it('бусдын (оролцогч биш) орлого, өөр зээлдэгчийн өрхийн зардал орохгүй', () => {
    const r = aggregateIncome([primary], [row('x', 7_000_000, 7_000_000, 7_000_000), row('p', 1, 0, 2)]);
    expect(r).toMatchObject({ salaryMonthly: 1, householdExpenseMonthly: 2 });
  });
});

describe('readBsaFacts · bsa_summary_json (INT-4)', () => {
  const analyzed = { status: 'ANALYZED', existingDebtServiceMonthly: 400_000, dtiPercent: 41.5, incomeReliability: 87, pendingSuspiciousCount: 2 };

  it('ANALYZED → бүх талбар', () => {
    expect(readBsaFacts(analyzed)).toEqual({ analyzed: true, existingDebtServiceMonthly: 400_000, dtiPercent: 41.5, incomeReliability: 87, pendingSuspiciousCount: 2 });
  });
  it('DRAFT → зөвхөн идэвхтэй өрийн төлбөр (консерватив); dti/найдвар/сэжигтэй мэдэгдэхгүй', () => {
    expect(readBsaFacts({ ...analyzed, status: 'DRAFT' })).toEqual({ analyzed: false, existingDebtServiceMonthly: 400_000, dtiPercent: null, incomeReliability: null, pendingSuspiciousCount: null });
  });
  it.each([[null], [undefined], ['x'], [42], [[]]])('хүчингүй JSON (%j) → бүгд мэдэгдэхгүй', (json) => {
    expect(readBsaFacts(json)).toEqual({ analyzed: false, existingDebtServiceMonthly: null, dtiPercent: null, incomeReliability: null, pendingSuspiciousCount: null });
  });
  it('муу талбар зөвхөн өөрийгөө null болгоно; найдвар 0..100-д шахагдана; сэжигтэй бүхэлд тайрагдана', () => {
    expect(readBsaFacts({ ...analyzed, dtiPercent: 'x', existingDebtServiceMonthly: -5 })).toMatchObject({ dtiPercent: null, existingDebtServiceMonthly: null, incomeReliability: 87 });
    expect(readBsaFacts({ ...analyzed, incomeReliability: 140 }).incomeReliability).toBe(100);
    expect(readBsaFacts({ ...analyzed, incomeReliability: -3 }).incomeReliability).toBe(0);
    expect(readBsaFacts({ ...analyzed, pendingSuspiciousCount: 2.9 }).pendingSuspiciousCount).toBe(2);
    expect(readBsaFacts({ ...analyzed, pendingSuspiciousCount: -1 }).pendingSuspiciousCount).toBeNull();
    expect(readBsaFacts({ ...analyzed, dtiPercent: Number.NaN }).dtiPercent).toBeNull();
  });
});

describe('existingDebtService · ЗМС ба BSA-ийн ИХ нь (консерватив)', () => {
  const credit = (v: number | null) => ({ ficoScore: null, activeLoanCount: null, overdueHistoryMonths: null, existingDebtServiceMonthly: v });
  it.each([
    [credit(500_000), 300_000, 500_000],
    [credit(200_000), 600_000, 600_000],
    [credit(250_000), 250_000, 250_000], // нэмэхгүй: давхардаж болно
    [null, 600_000, 600_000],
    [credit(null), 600_000, 600_000],
    [credit(400_000), null, 400_000],
    [null, null, 0],
  ])('ЗМС=%j, BSA=%j → %j', (c, bsa, expected) => {
    expect(existingDebtService(c, { ...NO_BSA, existingDebtServiceMonthly: bsa })).toBe(expected);
  });
});

describe('newMonthlyPayment · annuity (TODO M07) / хуучраагүй ЭТХ', () => {
  const terms = { amount: 1_200_000, termMonths: 12, interestRate: 24 };
  const annuity = annuityPayment(1_200_000, 24, 12);
  const rows = (totals: number[], principalEach = 100_000) => totals.map((t) => ({ principal: D(principalEach), total: D(t) }));

  it('ЭТХ байхгүй → annuity', () => {
    expect(newMonthlyPayment(terms, null, true)).toEqual({ value: annuity, source: 'ANNUITY' });
    expect(annuity).toBeCloseTo(113_471.52, 1);
  });

  it('хуучраагүй, тэнцүү төлбөртэй, нөхцөлтэй таарах ЭТХ → эхний мөрийн total', () => {
    const totals = [...Array(11).fill(113_471.52), 113_470.1];
    expect(newMonthlyPayment(terms, { isStale: false, rows: rows(totals) }, true)).toEqual({ value: 113_471.52, source: 'SCHEDULE' });
  });

  it('хуучирсан ЭТХ → annuity', () => {
    expect(newMonthlyPayment(terms, { isStale: true, rows: rows(Array(12).fill(120_000)) }, true).source).toBe('ANNUITY');
  });

  it('override-тэй (slider) бол ЭТХ ашиглахгүй', () => {
    expect(newMonthlyPayment(terms, { isStale: false, rows: rows(Array(12).fill(120_000)) }, false).source).toBe('ANNUITY');
  });

  it('мөрийн тоо хугацаатай таарахгүй / үндсэн төлбөрийн нийлбэр дүнтэй таарахгүй → annuity', () => {
    expect(newMonthlyPayment(terms, { isStale: false, rows: rows(Array(11).fill(120_000)) }, true).source).toBe('ANNUITY');
    expect(newMonthlyPayment(terms, { isStale: false, rows: rows(Array(12).fill(120_000), 50_000) }, true).source).toBe('ANNUITY');
    expect(newMonthlyPayment(terms, { isStale: false, rows: [] }, true).source).toBe('ANNUITY');
  });

  it('тэнцүү биш (хөнгөлөлттэй, тэнцүү үндсэн төлбөр) ЭТХ → annuity', () => {
    const totals = [50_000, ...Array(11).fill(120_000)];
    expect(newMonthlyPayment(terms, { isStale: false, rows: rows(totals) }, true).source).toBe('ANNUITY');
    const declining = Array.from({ length: 12 }, (_, i) => 200_000 - i * 8_000);
    expect(newMonthlyPayment(terms, { isStale: false, rows: rows(declining) }, true).source).toBe('ANNUITY');
  });

  it('хүү 0 → дүн ÷ хугацаа, 2 орон', () => {
    expect(newMonthlyPayment({ amount: 1_000_000, termMonths: 3, interestRate: 0 }, null, true)).toEqual({ value: 333_333.33, source: 'ANNUITY' });
  });
});

describe('buildScoreRequest · ScoreRequest гэрээнд нийцнэ', () => {
  const income = { primaryCustomerId: 'p', salaryMonthly: 3_000_000, businessNcfMonthly: -100, householdExpenseMonthly: 800_000, contributors: ['p'] };
  const parts = {
    applicationId: 'app-1', terms: { amount: 10_000_000, termMonths: 12, interestRate: 24 }, monthlyPayment: 945_598.69, income,
    existingDebtServiceMonthly: 500_000, collateralValueTotal: 20_000_000, collateralRequired: true, policy: { maxDti: 0.55, minDscr: 1.25, maxLtv: 0.7, weightThreshold: 0.7 },
  };

  it('талбар бүр зөв байрлана; stress байвал орно, үгүй бол түлхүүр байхгүй', () => {
    const withStress = buildScoreRequest({ ...parts, stress: { rateDeltaPoints: 5, incomeChange: -0.2 } });
    expect(withStress).toEqual({
      applicationId: 'app-1', amount: 10_000_000, termMonths: 12, interestRate: 24, monthlyPayment: 945_598.69,
      salaryMonthly: 3_000_000, businessNcfMonthly: -100, householdExpenseMonthly: 800_000, existingDebtServiceMonthly: 500_000,
      collateralValueTotal: 20_000_000, collateralRequired: true, policy: parts.policy, stress: { rateDeltaPoints: 5, incomeChange: -0.2 },
    });
    expect(ScoreRequest.parse(withStress)).toEqual(withStress);
    const without = buildScoreRequest(parts);
    expect('stress' in without).toBe(false);
    expect(() => ScoreRequest.parse(without)).not.toThrow();
  });
});

describe('buildSoscoInput · docs/05 §3, §5', () => {
  const request = buildScoreRequest({
    applicationId: 'app-1', terms: { amount: 10_000_000, termMonths: 12, interestRate: 24 }, monthlyPayment: 1, income: { primaryCustomerId: 'p', salaryMonthly: 1, businessNcfMonthly: 0, householdExpenseMonthly: 0, contributors: ['p'] },
    existingDebtServiceMonthly: 0, collateralValueTotal: 0, collateralRequired: false, policy: { maxDti: 0.55, minDscr: 1.25, maxLtv: 0.7, weightThreshold: 0.7 },
  });
  const result = underwriteResult(request, { ltv: 0.4, burdenPercent: { A_SALARY: 33.3, B_BUSINESS: 12.5, C_COMBINED: 20 } });
  const credit = { ficoScore: 680, activeLoanCount: 2, overdueHistoryMonths: 1, existingDebtServiceMonthly: 300_000 };
  const analyzed: BsaFacts = { analyzed: true, existingDebtServiceMonthly: 100_000, dtiPercent: 41.5, incomeReliability: 87, pendingSuspiciousCount: 3 };

  it('BSA ANALYZED → dtiPercent/найдвар/сэжигтэй BSA-аас; ЗМС → fico/идэвхтэй зээл/хэтрэлт; ltv = тооцооллын LTV', () => {
    const input = buildSoscoInput(credit, analyzed, result, 'A_SALARY');
    expect(input).toEqual({ ficoScore: 680, dtiPercent: 41.5, incomeReliability: 87, pendingSuspiciousCount: 3, activeLoanCount: 2, overdueHistoryMonths: 1, ltv: 0.4 });
    expect(() => SoscoInput.parse(input)).not.toThrow();
  });

  it('BSA байхгүй → dtiPercent = сонгосон аргын burdenPercent, найдвар/сэжигтэй мэдэгдэхгүй', () => {
    expect(buildSoscoInput(credit, NO_BSA, result, 'A_SALARY')).toMatchObject({ dtiPercent: 33.3, incomeReliability: null, pendingSuspiciousCount: null });
    expect(buildSoscoInput(credit, NO_BSA, result, 'B_BUSINESS').dtiPercent).toBe(12.5); // carry-over гараар сонгосон арга
    expect(buildSoscoInput(credit, NO_BSA, result, 'C_COMBINED').dtiPercent).toBe(20);
  });

  it('арга сонгогдоогүй (орлого байхгүй) бол dtiPercent = хамгийн муу (мэдэгдэхгүй биш → жин дахин хуваарилагдахгүй)', () => {
    expect(buildSoscoInput(credit, NO_BSA, result, null).dtiPercent).toBe(SOSCO_UNSERVICEABLE_DTI_PERCENT);
    expect(() => SoscoInput.parse(buildSoscoInput(credit, NO_BSA, result, null))).not.toThrow();
  });

  it('ЗМС байхгүй (real горим) → fico/түүх мэдэгдэхгүй; ltv null (барьцаагүй) хэвээр', () => {
    const noCollateral = { ...result, collateral: { ...result.collateral, ltv: null } };
    expect(buildSoscoInput(null, NO_BSA, noCollateral, 'A_SALARY')).toEqual({
      ficoScore: null, dtiPercent: 33.3, incomeReliability: null, pendingSuspiciousCount: null, activeLoanCount: null, overdueHistoryMonths: null, ltv: null,
    });
  });

  it('арга хэрэглэгдэхгүй бол burdenPercent null → dtiPercent = хамгийн муу', () => {
    const r = { ...result, methods: [methodVerdict('A_SALARY', request, { applicable: false }), result.methods[1]!, result.methods[2]!] };
    expect(buildSoscoInput(credit, NO_BSA, r, 'A_SALARY').dtiPercent).toBe(SOSCO_UNSERVICEABLE_DTI_PERCENT);
  });
});

describe('sanitizeCreditHistory', () => {
  it('null → null; хүчинтэй утга хэвээр', () => {
    expect(sanitizeCreditHistory(null)).toBeNull();
    const ok = { ficoScore: 700, activeLoanCount: 1, overdueHistoryMonths: 0, existingDebtServiceMonthly: 150_000 };
    expect(sanitizeCreditHistory(ok)).toEqual(ok);
  });
  it('муж/бүхэл тоо зөрчвөл мэдэгдэхгүй (null) болгоно, зохиомол утга өгөхгүй', () => {
    expect(sanitizeCreditHistory({ ficoScore: 1200, activeLoanCount: -1, overdueHistoryMonths: 2.7, existingDebtServiceMonthly: -5 })).toEqual({
      ficoScore: null, activeLoanCount: null, overdueHistoryMonths: 2, existingDebtServiceMonthly: null,
    });
    expect(sanitizeCreditHistory({ ficoScore: Number.NaN, activeLoanCount: Number.POSITIVE_INFINITY, overdueHistoryMonths: null, existingDebtServiceMonthly: null })).toEqual({
      ficoScore: null, activeLoanCount: null, overdueHistoryMonths: null, existingDebtServiceMonthly: null,
    });
  });
});
