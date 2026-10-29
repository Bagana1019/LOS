import { describe, it, expect } from 'vitest';
import { POS_POLICY_DEFAULTS, type PosPolicy, type PosScreeningResponse } from '@los/contracts';
import {
  affordability, ageInMonths, decidePosLease, effectiveAnnualRate, isConsentChannelVerified, principalFromPayment, publicReasonOf, quotePosLease, suggestedDownPaymentFor,
  type PosDecisionInput, type PosSuggestionLimits,
} from './pos-lease';
import { annuityPayment } from './schedule';

const base = { planCode: 'LAPTOP-12', goodsPrice: 3_000_000, downPayment: 600_000, termMonths: 12, annualRate: 0.24, feeRate: 0, commissionRate: 0.02 };

describe('quotePosLease', () => {
  it('3,000,000₮ бараа, 600,000₮ урьдчилгаа, 12 сар, 24% → сарын төлбөр ≈ 226,943₮', () => {
    const q = quotePosLease(base);
    expect(q.financedAmount).toBe(2_400_000);
    expect(q.downPaymentRate).toBe(0.2);
    expect(q.feeAmount).toBe(0);
    expect(q.principal).toBe(2_400_000);
    expect(q.monthlyPayment).toBeCloseTo(226_943.03, 2);
    expect(q.totalRepayment).toBeCloseTo(226_943.03 * 12, 1);
    expect(q.totalInterestAndFees).toBeCloseTo(q.totalRepayment - 2_400_000, 2);
    expect(q.totalCostToBuyer).toBeCloseTo(600_000 + q.totalRepayment, 2);
    expect(q.effectiveAnnualRate).toBeCloseTo(Math.pow(1.02, 12) - 1, 4); // 0.2682
  });

  it('мерчантын шимтгэл ба цэвэр дүн санхүүжилтээс тооцогдоно', () => {
    const q = quotePosLease(base);
    expect(q.merchantCommissionRate).toBe(0.02);
    expect(q.merchantCommissionAmount).toBe(48_000);
    expect(q.merchantNetAmount).toBe(2_352_000);
  });

  it('олголтын шimтгэл зээлийн үндсэн дүнд нэмэгдэж, үр ашигт хүүг нэмэгдүүлнэ', () => {
    const q = quotePosLease({ ...base, feeRate: 0.01 });
    expect(q.feeAmount).toBe(24_000);
    expect(q.principal).toBe(2_424_000);
    expect(q.monthlyPayment).toBeCloseTo(226_943.03 * 1.01, 1);
    expect(q.effectiveAnnualRate).toBeGreaterThan(quotePosLease(base).effectiveAnnualRate);
  });

  it('0% хөтөлбөр: хүүгүй, үр ашигт хүү 0', () => {
    const q = quotePosLease({ ...base, goodsPrice: 1_200_000, downPayment: 0, annualRate: 0, commissionRate: 0 });
    expect(q.monthlyPayment).toBe(100_000);
    expect(q.totalInterestAndFees).toBe(0);
    expect(q.effectiveAnnualRate).toBe(0);
    expect(q.downPaymentRate).toBe(0);
  });

  it('0% хөтөлбөр: хуваагдахгүй дүнгийн мөнгөн бүтэн бус үлдэгдэл сөрөг хүү болохгүй', () => {
    const q = quotePosLease({ ...base, goodsPrice: 1_000_000, downPayment: 0, termMonths: 3, annualRate: 0, commissionRate: 0 });
    expect(q.monthlyPayment).toBe(333_333.33);
    expect(q.totalInterestAndFees).toBe(0);
  });

  it('0% хүүтэй ч шимтгэлтэй бол үр ашигт хүү эерэг', () => {
    const q = quotePosLease({ ...base, annualRate: 0, feeRate: 0.05 });
    expect(q.effectiveAnnualRate).toBeGreaterThan(0.05);
  });

  it.each([
    [{ goodsPrice: 0 }, 'goodsPrice'],
    [{ goodsPrice: -5 }, 'goodsPrice'],
    [{ downPayment: -1 }, 'downPayment'],
    [{ downPayment: 3_000_000 }, 'downPayment'],
    [{ termMonths: 0 }, 'termMonths'],
    [{ termMonths: 1.5 }, 'termMonths'],
    [{ annualRate: 1.2 }, 'rates'],
    [{ annualRate: -0.1 }, 'rates'],
    [{ feeRate: 1.1 }, 'rates'],
    [{ commissionRate: -1 }, 'rates'],
  ])('буруу оролт %o → RangeError', (patch, msg) => {
    expect(() => quotePosLease({ ...base, ...patch })).toThrow(RangeError);
    expect(() => quotePosLease({ ...base, ...patch })).toThrow(msg);
  });
});

describe('effectiveAnnualRate', () => {
  it('нийт төлөлт ≤ хүлээн авсан бол 0', () => {
    expect(effectiveAnnualRate(1000, 100, 10)).toBe(0);
    expect(effectiveAnnualRate(1000, 99, 10)).toBe(0);
  });
  it('сарын 2% → жилийн 26.82%', () => {
    const pmt = annuityPayment(1_000_000, 24, 12);
    expect(effectiveAnnualRate(1_000_000, pmt, 12)).toBeCloseTo(0.2682, 4);
  });
});

describe('principalFromPayment', () => {
  it('0% хүүтэй бол төлбөр × хугацаа', () => expect(principalFromPayment(100_000, 0, 12)).toBe(1_200_000));
  it('annuity-ийн урвуу (±1₮)', () => {
    const pmt = annuityPayment(30_000_000, 23.99, 36);
    expect(Math.abs(principalFromPayment(pmt, 0.2399, 36) - 30_000_000)).toBeLessThan(2);
  });
});

describe('ageInMonths', () => {
  it('төрсөн өдөр ирээгүй бол сарыг нэгээр хасна', () => {
    expect(ageInMonths('1990-06-15', '2026-06-14')).toBe(35 * 12 + 11);
    expect(ageInMonths('1990-06-15', '2026-06-15')).toBe(36 * 12);
    expect(ageInMonths('1990-06-15', '2026-07-01')).toBe(36 * 12);
  });
  it('ирээдүйн төрсөн огноо → 0', () => expect(ageInMonths('2030-01-01', '2026-01-01')).toBe(0));
  it('буруу формат → RangeError', () => {
    expect(() => ageInMonths('1990/06/15', '2026-06-14')).toThrow(RangeError);
    expect(() => ageInMonths('1990-06-15', 'today')).toThrow(RangeError);
  });
});

// ───────────── Шууд шийдвэр ─────────────
const policy: PosPolicy = { ...POS_POLICY_DEFAULTS };
const healthy: PosScreeningResponse = {
  identity: { found: true, lastName: 'Бат', firstName: 'Болд', birthDate: '1990-05-10', phoneMatches: true },
  blacklist: { hit: false, reasonCode: null },
  pep: false,
  cib: { available: true, activeLoanCount: 1, monthlyDebtService: 200_000, maxDpdDays: 0, ficoScore: 700 },
  income: { monthlyAmount: 2_000_000, source: 'NDSH', months: 12 },
  fetchedAt: '2026-10-28T09:00:00+08:00',
};
const quote = quotePosLease(base); // сарын төлбөр ≈ 226,943
const input = (patch: Partial<PosScreeningResponse> = {}, pol: Partial<PosPolicy> = {}, q = quote): PosDecisionInput => ({ quote: q, screening: { ...healthy, ...patch }, policy: { ...policy, ...pol }, today: '2026-10-28' });
const codes = (r: ReturnType<typeof decidePosLease>) => r.reasons.map((x) => `${x.code}:${x.severity}`);

describe('decidePosLease', () => {
  it('эрүүл худалдан авагч → APPROVE, ӨОХ тооцогдоно', () => {
    const r = decidePosLease(input());
    expect(r.decision).toBe('APPROVE');
    expect(r.reasons).toEqual([]);
    // (226,943.03 + 200,000) / 2,000,000 = 0.2135
    expect(r.dtiRatio).toBe(0.2135);
    expect(r.affordability).toBeNull();
  });

  it('насанд хүрээгүй → DECLINE', () => {
    expect(codes(decidePosLease(input({ identity: { ...healthy.identity, birthDate: '2010-01-01' } })))).toContain('UNDERAGE:DECLINE');
  });

  it('зээлийн хугацаа дуусахад нас хэтрэх → DECLINE', () => {
    const r = decidePosLease(input({ identity: { ...healthy.identity, birthDate: '1961-12-01' } }));
    expect(codes(r)).toEqual(['AGE_AT_MATURITY_EXCEEDED:DECLINE']);
    expect(r.decision).toBe('DECLINE');
  });

  it('регистрийн мэдээлэл олдохгүй → REFER (нас шалгахгүй)', () => {
    const r = decidePosLease(input({ identity: { found: false, lastName: null, firstName: null, birthDate: null, phoneMatches: null } }));
    expect(codes(r)).toEqual(['IDENTITY_NOT_FOUND:REFER']);
    expect(r.decision).toBe('REFER');
  });

  it('иргэн олдсон ч төрсөн огноо байхгүй → нас шалгах боломжгүй тул REFER (автоматаар батлахгүй)', () => {
    const r = decidePosLease(input({ identity: { ...healthy.identity, birthDate: null } }));
    expect(codes(r)).toEqual(['BIRTH_DATE_MISSING:REFER']);
    expect(r.decision).toBe('REFER');
    // төрсөн огноо байхгүй үед насны DECLINE шалгагдахгүй ч бусад DECLINE (ЗМС) давамгайлсаар байна
    expect(decidePosLease(input({ identity: { ...healthy.identity, birthDate: null }, cib: { ...healthy.cib, maxDpdDays: 120 } })).decision).toBe('DECLINE');
  });

  it('утасны дугаар таарахгүй (false) → PHONE_MISMATCH, тодорхойгүй (null) → PHONE_UNVERIFIED: хоёулаа REFER', () => {
    expect(codes(decidePosLease(input({ identity: { ...healthy.identity, phoneMatches: false } })))).toEqual(['PHONE_MISMATCH:REFER']);
    expect(codes(decidePosLease(input({ identity: { ...healthy.identity, phoneMatches: null } })))).toEqual(['PHONE_UNVERIFIED:REFER']);
    expect(decidePosLease(input({ identity: { ...healthy.identity, phoneMatches: null } })).decision).toBe('REFER');
  });

  it('ЗМС байхгүй → REFER, ӨОХ тооцохгүй', () => {
    const r = decidePosLease(input({ cib: { ...healthy.cib, available: false } }));
    expect(codes(r)).toEqual(['CREDIT_DATA_UNAVAILABLE:REFER']);
    expect(r.dtiRatio).toBeNull();
  });

  it('хугацаа хэтрэлт: ≥90 хоног DECLINE, ≥30 хоног REFER', () => {
    expect(codes(decidePosLease(input({ cib: { ...healthy.cib, maxDpdDays: 90 } })))).toEqual(['DPD_EXCEEDED:DECLINE']);
    expect(codes(decidePosLease(input({ cib: { ...healthy.cib, maxDpdDays: 30 } })))).toEqual(['DPD_WATCH:REFER']);
    expect(decidePosLease(input({ cib: { ...healthy.cib, maxDpdDays: 29 } })).decision).toBe('APPROVE');
  });

  it('FICO: <450 DECLINE, <550 REFER, байхгүй бол REFER', () => {
    expect(codes(decidePosLease(input({ cib: { ...healthy.cib, ficoScore: 449 } })))).toEqual(['FICO_TOO_LOW:DECLINE']);
    expect(codes(decidePosLease(input({ cib: { ...healthy.cib, ficoScore: 549 } })))).toEqual(['FICO_LOW:REFER']);
    expect(decidePosLease(input({ cib: { ...healthy.cib, ficoScore: 550 } })).decision).toBe('APPROVE');
    expect(codes(decidePosLease(input({ cib: { ...healthy.cib, ficoScore: null } })))).toEqual(['CREDIT_DATA_UNAVAILABLE:REFER']);
  });

  it('идэвхтэй зээл олон → REFER', () => {
    expect(codes(decidePosLease(input({ cib: { ...healthy.cib, activeLoanCount: 4 } })))).toEqual(['TOO_MANY_ACTIVE_LOANS:REFER']);
    expect(decidePosLease(input({ cib: { ...healthy.cib, activeLoanCount: 3 } })).decision).toBe('APPROVE');
  });

  it('BR-9: хар жагсаалт, PEP → зөвхөн REFER (хориг биш)', () => {
    expect(codes(decidePosLease(input({ blacklist: { hit: true, reasonCode: 'FRAUD' } })))).toEqual(['BLACKLISTED:REFER']);
    expect(codes(decidePosLease(input({ pep: true })))).toEqual(['PEP:REFER']);
  });

  it('орлого баталгаажаагүй → REFER', () => {
    for (const income of [{ monthlyAmount: null, source: 'NONE' as const, months: 0 }, { monthlyAmount: 0, source: 'NDSH' as const, months: 3 }, { monthlyAmount: 1_000_000, source: 'NONE' as const, months: 0 }]) {
      const r = decidePosLease(input({ income }));
      expect(codes(r)).toEqual(['INCOME_UNVERIFIED:REFER']);
      expect(r.dtiRatio).toBeNull();
    }
  });

  it('ӨОХ: 55% хүртэл APPROVE; 55–65% REFER + чадамж; 65%-аас дээш DECLINE', () => {
    // орлого 1,000,000; өр 200,000 → (226,943 + 200,000)/1,000,000 = 42.7% → APPROVE
    expect(decidePosLease(input({ income: { monthlyAmount: 1_000_000, source: 'NDSH', months: 12 } })).decision).toBe('APPROVE');
    // орлого 750,000 → 56.9% → REFER
    const refer = decidePosLease(input({ income: { monthlyAmount: 750_000, source: 'NDSH', months: 12 } }));
    expect(codes(refer)).toEqual(['DTI_EXCEEDED:REFER']);
    expect(refer.dtiRatio).toBe(0.5693);
    expect(refer.affordability?.maxMonthlyPayment).toBe(212_500); // 0.55×750,000 − 200,000
    expect(refer.affordability?.suggestedMinDownPayment).not.toBeNull();
    // орлого 600,000 → 71.2% → DECLINE
    const decline = decidePosLease(input({ income: { monthlyAmount: 600_000, source: 'NDSH', months: 12 } }));
    expect(codes(decline)).toEqual(['DTI_EXCEEDED_HARD:DECLINE']);
    expect(decline.decision).toBe('DECLINE');
  });

  it('санал болгосон урьдчилгаагаар дахин бодоход ӨОХ ≤ 55%', () => {
    const screening = { income: { monthlyAmount: 750_000, source: 'NDSH' as const, months: 12 } };
    const first = decidePosLease(input(screening));
    const down = first.affordability?.suggestedMinDownPayment as number;
    const q2 = quotePosLease({ ...base, downPayment: down });
    const second = decidePosLease(input(screening, {}, q2));
    expect(second.decision).toBe('APPROVE');
    expect(second.dtiRatio as number).toBeLessThanOrEqual(0.55);
  });

  it('санхүүжилт автомат батлах дээд дүнгээс их → REFER', () => {
    expect(codes(decidePosLease(input({}, { autoApproveMaxAmount: 2_000_000 })))).toEqual(['AMOUNT_ABOVE_AUTO_LIMIT:REFER']);
  });

  it('autoDeclineEnabled=false бол DECLINE → REFER болно', () => {
    const r = decidePosLease(input({ cib: { ...healthy.cib, maxDpdDays: 120 } }, { autoDeclineEnabled: false }));
    expect(r.decision).toBe('REFER');
    expect(codes(r)).toEqual(['DPD_EXCEEDED:REFER']);
  });

  it('олон шалтгаан: DECLINE нь REFER-ээс давамгайлна, бүх шалтгаан хадгалагдана', () => {
    const r = decidePosLease(input({ pep: true, cib: { ...healthy.cib, maxDpdDays: 100 } }));
    expect(r.decision).toBe('DECLINE');
    expect(codes(r)).toEqual(['DPD_EXCEEDED:DECLINE', 'PEP:REFER']);
  });
});

describe('affordability', () => {
  const q = { goodsPrice: 3_000_000, financedAmount: 2_400_000, monthlyPayment: 226_943.03, termMonths: 12, annualRate: 0.24, feeRate: 0 };
  it('өр орлогыг давсан бол чадамж 0, санал болгох урьдчилгаа байхгүй', () => {
    const a = affordability(q, 300_000, 500_000, 0.55);
    expect(a).toEqual({ maxMonthlyPayment: 0, maxFinancedAmount: 0, suggestedMinDownPayment: null });
  });
  it('урьдчилгаа 1,000₮-ийн нарийвчлалаар дээш бөөрлөгдөнө', () => {
    const a = affordability(q, 750_000, 200_000, 0.55);
    expect(a.suggestedMinDownPayment! % 1000).toBe(0);
    expect(a.suggestedMinDownPayment!).toBeGreaterThan(600_000);
    expect(a.maxFinancedAmount).toBeCloseTo(a.maxMonthlyPayment * (1 - Math.pow(1.02, -12)) / 0.02, 0);
  });
  it('шимтгэл санхүүжилтэд тусгагдана', () => {
    const noFee = affordability(q, 750_000, 200_000, 0.55);
    const fee = affordability({ ...q, feeRate: 0.1 }, 750_000, 200_000, 0.55);
    expect(fee.maxFinancedAmount).toBeCloseTo(noFee.maxFinancedAmount / 1.1, 0);
  });
  it('чадамж үнээс бага ч урьдчилгаа үнэд хүрэх тохиолдолд санал болгохгүй', () => {
    // maxMonthlyPayment = 0.55×363,700 − 200,000 = 35 → санхүүжилт ~370₮; урьдчилгаа 999,630 → 1,000,000 болж үнэтэй тэнцэнэ
    const tiny = affordability({ ...q, goodsPrice: 1_000_000 }, 363_700, 200_000, 0.55);
    expect(tiny.maxFinancedAmount).toBeGreaterThan(0);
    expect(tiny.maxFinancedAmount).toBeLessThan(1_000);
    expect(tiny.suggestedMinDownPayment).toBeNull();
  });
});

describe('publicReasonOf / suggestedDownPaymentFor', () => {
  const mk = (decision: 'APPROVE' | 'REFER' | 'DECLINE', reasons: Array<[string, string]>, afford: number | null = null) => ({
    decision,
    reasons: reasons.map(([code, severity]) => ({ code, severity })) as never,
    affordability: afford === null ? null : { maxMonthlyPayment: 1, maxFinancedAmount: 1, suggestedMinDownPayment: afford },
  });
  it('APPROVE → null; REFER → MANUAL_REVIEW', () => {
    expect(publicReasonOf(mk('APPROVE', []))).toBeNull();
    expect(publicReasonOf(mk('REFER', [['BLACKLISTED', 'REFER']]))).toBe('MANUAL_REVIEW');
  });
  it('DECLINE ангилал: ӨОХ → AFFORDABILITY, ЗМС → CREDIT_POLICY, нас → ELIGIBILITY', () => {
    expect(publicReasonOf(mk('DECLINE', [['DTI_EXCEEDED_HARD', 'DECLINE']]))).toBe('AFFORDABILITY');
    expect(publicReasonOf(mk('DECLINE', [['DPD_EXCEEDED', 'DECLINE'], ['DTI_EXCEEDED_HARD', 'DECLINE']]))).toBe('AFFORDABILITY');
    expect(publicReasonOf(mk('DECLINE', [['FICO_TOO_LOW', 'DECLINE']]))).toBe('CREDIT_POLICY');
    expect(publicReasonOf(mk('DECLINE', [['UNDERAGE', 'DECLINE']]))).toBe('ELIGIBILITY');
    expect(publicReasonOf(mk('DECLINE', []))).toBe('CREDIT_POLICY'); // хамгаалалтын fallback
  });
  it('урьдчилгааны санал зөвхөн ӨОХ-оос өөр саад байхгүй үед', () => {
    expect(suggestedDownPaymentFor(mk('REFER', [['DTI_EXCEEDED', 'REFER']], 900_000))).toBe(900_000);
    expect(suggestedDownPaymentFor(mk('DECLINE', [['DTI_EXCEEDED_HARD', 'DECLINE']], 1_200_000))).toBe(1_200_000);
    expect(suggestedDownPaymentFor(mk('REFER', [['DTI_EXCEEDED', 'REFER'], ['BLACKLISTED', 'REFER']], 900_000))).toBeNull();
    expect(suggestedDownPaymentFor(mk('APPROVE', [], null))).toBeNull();
    expect(suggestedDownPaymentFor(mk('REFER', [['DTI_EXCEEDED', 'REFER']], null))).toBeNull();
  });
});

// ───────────── n=2: зөвшөөрлийн суваг баталгаажаагүй (утас иргэнийх гэдэг нь тогтоогдоогүй) ─────────────
describe('unverified consent channel (identity.phoneMatches !== true)', () => {
  const ident = (phoneMatches: boolean | null, found = true) => ({ ...healthy.identity, found, phoneMatches });
  // Зээлийн үндэслэлтэй DECLINE-д хүргэх бүх шалтгаан
  const declineCauses: Array<[string, Partial<PosScreeningResponse>, string]> = [
    ['DPD >= 90', { cib: { ...healthy.cib, maxDpdDays: 120 } }, 'DPD_EXCEEDED'],
    ['FICO < 450', { cib: { ...healthy.cib, ficoScore: 400 } }, 'FICO_TOO_LOW'],
    ['underage', { identity: { ...healthy.identity, birthDate: '2012-01-01' } }, 'UNDERAGE'],
    ['age at maturity', { identity: { ...healthy.identity, birthDate: '1961-12-01' } }, 'AGE_AT_MATURITY_EXCEEDED'],
    ['hard DTI', { income: { monthlyAmount: 600_000, source: 'NDSH', months: 12 } }, 'DTI_EXCEEDED_HARD'],
  ];

  it('isConsentChannelVerified: зөвхөн found && phoneMatches === true', () => {
    expect(isConsentChannelVerified({ found: true, phoneMatches: true })).toBe(true);
    expect(isConsentChannelVerified({ found: true, phoneMatches: false })).toBe(false);
    expect(isConsentChannelVerified({ found: true, phoneMatches: null })).toBe(false);
    expect(isConsentChannelVerified({ found: false, phoneMatches: true })).toBe(false);
    expect(isConsentChannelVerified({ found: false, phoneMatches: null })).toBe(false);
  });

  it.each([[false], [null]])('phoneMatches=%s + DPD>=90: DECLINE биш REFER; мерчантад зөвхөн MANUAL_REVIEW, дотоод шалтгаан хадгалагдана', (phoneMatches) => {
    const r = decidePosLease(input({ identity: ident(phoneMatches), cib: { ...healthy.cib, maxDpdDays: 120 } }));
    expect(r.decision).toBe('REFER');
    expect(publicReasonOf(r)).toBe('MANUAL_REVIEW');
    expect(suggestedDownPaymentFor(r)).toBeNull();
    expect(r.reasons.some((x) => x.severity === 'DECLINE')).toBe(false);
    expect(codes(r)).toContain('DPD_EXCEEDED:REFER'); // lender-ийн харагдацад шалтгаан үлдэнэ
    expect(codes(r)).toContain(phoneMatches === false ? 'PHONE_MISMATCH:REFER' : 'PHONE_UNVERIFIED:REFER');
  });

  it.each([[false], [null]])('phoneMatches=%s: ямар ч DECLINE шалтгаан REFER/MANUAL_REVIEW болж, бүх профайлын үр дүн ижил (оракул байхгүй)', (phoneMatches) => {
    const outcomes = new Set<string>();
    for (const [label, patch, code] of declineCauses) {
      const r = decidePosLease(input({ ...patch, identity: { ...(patch.identity ?? healthy.identity), phoneMatches } }));
      expect(r.decision, label).toBe('REFER');
      expect(publicReasonOf(r), label).toBe('MANUAL_REVIEW');
      expect(suggestedDownPaymentFor(r), label).toBeNull();
      expect(codes(r).some((c) => c.startsWith(`${code}:`)), label).toBe(true);
      outcomes.add(`${r.decision}/${publicReasonOf(r)}`);
    }
    // эрүүл профайл ч APPROVE болохгүй → мерчант "батлагдсан" эсэхээр худлаа зээлийн байдлыг таах боломжгүй
    const healthyResult = decidePosLease(input({ identity: ident(phoneMatches) }));
    expect(healthyResult.decision).toBe('REFER');
    outcomes.add(`${healthyResult.decision}/${publicReasonOf(healthyResult)}`);
    expect([...outcomes]).toEqual(['REFER/MANUAL_REVIEW']);
  });

  it('иргэн олдоогүй (found=false) үед ч DECLINE шалтгаан REFER болно', () => {
    const r = decidePosLease(input({ identity: { found: false, lastName: null, firstName: null, birthDate: null, phoneMatches: null }, cib: { ...healthy.cib, maxDpdDays: 120 } }));
    expect(r.decision).toBe('REFER');
    expect(publicReasonOf(r)).toBe('MANUAL_REVIEW');
    expect(codes(r)).toEqual(['IDENTITY_NOT_FOUND:REFER', 'DPD_EXCEEDED:REFER']);
  });

  it('хяналт: суваг баталгаажсан (phoneMatches=true) үед DECLINE хэвээр, ангилал харагдана', () => {
    for (const [label, patch, code] of declineCauses) {
      const r = decidePosLease(input(patch));
      expect(r.decision, label).toBe('DECLINE');
      expect(codes(r), label).toContain(`${code}:DECLINE`);
    }
    expect(publicReasonOf(decidePosLease(input({ cib: { ...healthy.cib, maxDpdDays: 120 } })))).toBe('CREDIT_POLICY');
  });

  it('суваг баталгаажаагүй үед ӨОХ-ийн урьдчилгааны санал ч мерчантад гарахгүй (REFER-д ӨОХ-оос өөр саад байна)', () => {
    const r = decidePosLease(input({ identity: ident(false), income: { monthlyAmount: 750_000, source: 'NDSH', months: 12 } }));
    expect(codes(r)).toEqual(['PHONE_MISMATCH:REFER', 'DTI_EXCEEDED:REFER']);
    expect(r.affordability?.suggestedMinDownPayment).not.toBeNull(); // lender-ийн харагдацад чадамж үлдэнэ
    expect(suggestedDownPaymentFor(r)).toBeNull();
  });
});

// ───────────── n=17: ӨОХ-ийг тойруулаагүй утгаар шийднэ ─────────────
describe('DTI boundaries use the unrounded ratio', () => {
  // орлого 10,000,000, өргүй: maxDti 0.55 → 5,500,000₮; referDti 0.65 → 6,500,000₮
  const at = (monthlyPayment: number) => decidePosLease({
    quote: { ...quote, monthlyPayment }, screening: { ...healthy, cib: { ...healthy.cib, monthlyDebtService: 0 }, income: { monthlyAmount: 10_000_000, source: 'NDSH', months: 12 } }, policy, today: '2026-10-28',
  });

  it('яг maxDti-д APPROVE; нэг цент дээш REFER (4 оронд тойрох үед APPROVE болдог байсан)', () => {
    const on = at(5_500_000);
    expect(on.decision).toBe('APPROVE');
    expect(on.dtiRatio).toBe(0.55);
    for (const payment of [5_500_000.01, 5_500_100, 5_500_400, 5_500_499.99]) { // 0.55000000001 … 0.55004999 → хуучин код APPROVE
      const r = at(payment);
      expect(r.decision, String(payment)).toBe('REFER');
      expect(codes(r), String(payment)).toEqual(['DTI_EXCEEDED:REFER']);
      expect(r.dtiRatio, String(payment)).toBe(0.55); // хадгалах/харуулах утга л 4 оронд тойрно
    }
  });

  it('яг referDti-д REFER; нэг цент дээш DECLINE (хуучин код REFER хэвээр байдаг байсан)', () => {
    const on = at(6_500_000);
    expect(codes(on)).toEqual(['DTI_EXCEEDED:REFER']);
    expect(on.dtiRatio).toBe(0.65);
    for (const payment of [6_500_000.01, 6_500_400, 6_500_499.99]) {
      const r = at(payment);
      expect(codes(r), String(payment)).toEqual(['DTI_EXCEEDED_HARD:DECLINE']);
      expect(r.dtiRatio, String(payment)).toBe(0.65);
    }
  });

  it('хуучин тойруулсан босго шиг 0.55005 дээш: REFER, 0.55-аас нэг цент доош: APPROVE', () => {
    expect(at(5_499_999.99).decision).toBe('APPROVE');
    expect(at(5_500_500).decision).toBe('REFER');
  });

  it('өртэй үед ч affordability-ийн maxMonthlyPayment (income×maxDti − өр) яг шийдвэрийн хил', () => {
    const a = affordability(quote, 2_000_000, 200_000, 0.55);
    expect(a.maxMonthlyPayment).toBe(900_000);
    const mk = (monthlyPayment: number) => decidePosLease({ quote: { ...quote, monthlyPayment }, screening: healthy, policy, today: '2026-10-28' });
    expect(mk(a.maxMonthlyPayment).decision).toBe('APPROVE');
    expect(mk(a.maxMonthlyPayment + 0.01).decision).toBe('REFER');
  });
});

// ───────────── n=16: урьдчилгааны санал нь хөтөлбөр/мерчантын хүрээнд хэрэгжих ёстой ─────────────
describe('suggested minimum down payment respects the plan range', () => {
  const limits: PosSuggestionLimits = { minAmount: 300_000, maxAmount: 20_000_000, maxTicketAmount: 15_000_000, minDownPaymentRate: 0.1 };
  const screeningOf = (income: number, debt: number): PosScreeningResponse => ({ ...healthy, cib: { ...healthy.cib, monthlyDebtService: debt }, income: { monthlyAmount: income, source: 'NDSH', months: 12 } });
  const q0 = (over: Partial<Parameters<typeof quotePosLease>[0]> = {}) => quotePosLease({ planCode: 'LAPTOP', goodsPrice: 3_000_000, downPayment: 600_000, termMonths: 12, annualRate: 0.24, feeRate: 0.01, commissionRate: 0.03, ...over });
  const decide = (q: ReturnType<typeof quotePosLease>, income: number, debt: number, lim?: PosSuggestionLimits) =>
    decidePosLease({ quote: q, screening: screeningOf(income, debt), policy, today: '2026-10-28', ...(lim ? { limits: lim } : {}) });

  it('хуучин алдаа: чадамж хөтөлбөрийн minAmount-аас бага бол санал null (хэрэгжих боломжгүй урьдчилгаа санал болгохгүй)', () => {
    const q = q0();
    const without = decide(q, 700_000, 370_000); // limits өгөөгүй → хуучин үр дүн (санхүүжилт ~157,000₮ < 300,000₮)
    expect(without.decision).toBe('DECLINE');
    expect(without.affordability?.maxFinancedAmount).toBeLessThan(300_000);
    expect(without.affordability?.suggestedMinDownPayment).not.toBeNull();
    const withLimits = decide(q, 700_000, 370_000, limits);
    expect(withLimits.decision).toBe('DECLINE');
    expect(withLimits.affordability?.maxFinancedAmount).toBe(without.affordability?.maxFinancedAmount); // чадамжийн дүн өөрчлөгдөхгүй
    expect(withLimits.affordability?.suggestedMinDownPayment).toBeNull();
    expect(suggestedDownPaymentFor(withLimits)).toBeNull();
  });

  it('санал нь хөтөлбөрийн доод урьдчилгааны хувиас бага байж болохгүй (max)', () => {
    const r = decide(q0(), 750_000, 200_000, { ...limits, minDownPaymentRate: 0.5 });
    expect(r.affordability?.suggestedMinDownPayment).toBeGreaterThanOrEqual(1_500_000);
    const loose = decide(q0(), 750_000, 200_000, limits);
    expect(loose.affordability!.suggestedMinDownPayment!).toBeLessThan(1_500_000);
  });

  it('мерчантын тасалбарын дээд хязгаар ба хөтөлбөрийн maxAmount нь урьдчилгааны доод хязгаарыг өсгөнө', () => {
    const base = decide(q0(), 750_000, 200_000, limits).affordability!.suggestedMinDownPayment!;
    const ticket = decide(q0(), 750_000, 200_000, { ...limits, maxTicketAmount: 1_000_000 }).affordability!.suggestedMinDownPayment!;
    expect(ticket).toBeGreaterThanOrEqual(2_000_000); // санхүүжилт ≤ 1,000,000 → урьдчилгаа ≥ 2,000,000
    expect(ticket).toBeGreaterThan(base);
    const planMax = decide(q0(), 750_000, 200_000, { ...limits, maxAmount: 800_000 }).affordability!.suggestedMinDownPayment!;
    expect(planMax).toBeGreaterThanOrEqual(2_200_000);
  });

  it('1,000₮-ийн алхам хүрээг давах үед санхүүжилт = minAmount байх хамгийн их урьдчилгааг санал болгоно', () => {
    // 0% хүү, 12 сар: чадамж = 12 × (income×0.55 − өр). 25,033.34₮/сар → ~300,400₮; minAmount 300,300₮ → урьдчилгаа ≤ 2,699,700₮ (алхам: 2,700,000₮ хэтэрнэ)
    const q = q0({ annualRate: 0, feeRate: 0 });
    const lim = { ...limits, minAmount: 300_300 };
    const a = affordability(q, 100_000, 29_966.66, 0.55, lim);
    expect(a.maxMonthlyPayment).toBe(25_033.34);
    expect(a.maxFinancedAmount).toBe(300_400.08);
    expect(a.suggestedMinDownPayment).toBe(2_699_700);
    // уг санал бодит quote болж, шийдвэр APPROVE болно
    const q2 = q0({ annualRate: 0, feeRate: 0, downPayment: 2_699_700 });
    expect(q2.financedAmount).toBe(300_300);
    expect(decidePosLease({ quote: q2, screening: screeningOf(100_000, 29_966.66), policy, today: '2026-10-28', limits: lim }).decision).toBe('APPROVE');
    // minAmount 300,500₮ > чадамж → ямар ч урьдчилгаа хүрэлцэхгүй
    expect(affordability(q, 100_000, 29_966.66, 0.55, { ...lim, minAmount: 300_500 }).suggestedMinDownPayment).toBeNull();
  });

  it('limits өгөөгүй үед хуучин үр дүн хэвээр (минимум дүнгийн шалгалтгүй, 1,000₮-ийн алхам)', () => {
    const a = affordability({ goodsPrice: 3_000_000, financedAmount: 2_400_000, monthlyPayment: 226_943.03, termMonths: 12, annualRate: 0.24, feeRate: 0 }, 750_000, 200_000, 0.55);
    expect(a.suggestedMinDownPayment! % 1000).toBe(0);
  });

  it('урьдчилгааны хувь бага (minDownPaymentRate=0) ба minAmount=0 үед санхүүжилт > 0 хэвээр шаардагдана', () => {
    const lim = { minAmount: 0, maxAmount: 20_000_000, maxTicketAmount: 15_000_000, minDownPaymentRate: 0 };
    const tiny = affordability({ goodsPrice: 1_000_000, financedAmount: 800_000, monthlyPayment: 1, termMonths: 12, annualRate: 0.24, feeRate: 0 }, 363_700, 200_000, 0.55, lim);
    expect(tiny.maxFinancedAmount).toBeGreaterThan(0);
    expect(tiny.suggestedMinDownPayment).toBeNull(); // 999,630 → 1,000,000 = үнэ: санхүүжилт үлдэхгүй
  });

  // Property-style: тор дээрх бүх хослолд санал → бодит quote хүчинтэй + APPROVE; null → хамгийн их боломжит урьдчилгаа ч хүрэлцэхгүй
  it('property: санал болгосон урьдчилгаагаар quote хийвэл хүчинтэй quote ба APPROVE; null бол ямар ч урьдчилгаа хүрэлцэхгүй', () => {
    let suggested = 0;
    let nullCases = 0;
    let fallbackCases = 0;
    const incomes = [600_000, 900_000, 1_200_000, 2_000_000, 3_500_000, 8_000_000];
    const debts = [0, 150_000, 370_000, 700_000];
    const prices = [1_200_000, 3_000_000, 7_770_000, 13_500_000];
    const terms = [3, 6, 12, 24];
    const fees = [0, 0.01, 0.025];
    const rates = [0, 0.24, 0.36];
    const rangeOk = (q: ReturnType<typeof quotePosLease>) =>
      q.financedAmount >= limits.minAmount && q.financedAmount <= limits.maxAmount && q.financedAmount <= limits.maxTicketAmount && q.downPayment >= Math.ceil(q.goodsPrice * limits.minDownPaymentRate);
    for (const income of incomes) for (const debt of debts) for (const goodsPrice of prices) for (const termMonths of terms) for (const feeRate of fees) for (const annualRate of rates) {
      const down0 = Math.ceil((goodsPrice * limits.minDownPaymentRate) / 1000) * 1000;
      const q = q0({ goodsPrice, downPayment: down0, termMonths, feeRate, annualRate });
      if (!rangeOk(q)) continue;
      const first = decide(q, income, debt, limits);
      const down = suggestedDownPaymentFor(first);
      const dtiOnly = first.reasons.length > 0 && first.reasons.every((x) => x.code === 'DTI_EXCEEDED' || x.code === 'DTI_EXCEEDED_HARD');
      if (!dtiOnly) continue;
      const label = JSON.stringify({ income, debt, goodsPrice, termMonths, feeRate, annualRate });
      if (down !== null) {
        suggested++;
        const q2 = q0({ goodsPrice, downPayment: down, termMonths, feeRate, annualRate });
        expect(rangeOk(q2), `quote range ${label} ${down}`).toBe(true);
        expect(down, label).toBeGreaterThan(down0);
        if (down % 1000 !== 0) { fallbackCases++; expect(q2.financedAmount, label).toBe(limits.minAmount); }
        const second = decide(q2, income, debt, limits);
        expect(second.decision, `${label} down=${down}`).toBe('APPROVE');
        expect(second.dtiRatio as number, label).toBeLessThanOrEqual(0.55);
        // хамгийн бага: 1,000₮ бага урьдчилгаа (хүрээнд байвал) APPROVE болохгүй
        const lower = down - 1000;
        if (lower >= down0 && lower > 0) {
          const q3 = q0({ goodsPrice, downPayment: lower, termMonths, feeRate, annualRate });
          if (rangeOk(q3)) expect(decide(q3, income, debt, limits).decision, `${label} minimal ${lower}`).not.toBe('APPROVE');
        }
      } else {
        nullCases++;
        // санхүүжилт = minAmount (хамгийн их урьдчилгаа) ч ӨОХ-д хүрэлцэхгүй
        const maxDown = goodsPrice - limits.minAmount;
        const q4 = q0({ goodsPrice, downPayment: maxDown, termMonths, feeRate, annualRate });
        expect(decide(q4, income, debt, limits).decision, `${label} maxDown`).not.toBe('APPROVE');
      }
    }
    expect(suggested).toBeGreaterThan(100);
    expect(nullCases).toBeGreaterThan(20);
    expect(fallbackCases).toBeGreaterThanOrEqual(0);
  });
});
