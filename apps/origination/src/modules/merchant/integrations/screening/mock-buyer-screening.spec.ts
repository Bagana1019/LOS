import { decidePosLease } from '@los/calc';
import { PosScreeningResponse, POS_POLICY_DEFAULTS } from '@los/contracts';
import { quotePosLease } from '@los/calc';
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../testing/fake-clock';
import { birthDateFromRegister, MockBuyerScreening, mockScreeningFor, MOCK_FIRST_NAME, MOCK_LAST_NAME } from './mock-buyer-screening';

const at = new Date('2026-10-28T04:00:00.000Z');
const reg = (digit: number, ymd = '900515') => `УЕ${ymd}0${digit}`;
const quote = quotePosLease({ planCode: 'LAPTOP', goodsPrice: 3_000_000, downPayment: 600_000, termMonths: 12, annualRate: 0.24, feeRate: 0.01, commissionRate: 0.03 });
const decide = (digit: number) => decidePosLease({ quote, screening: mockScreeningFor(reg(digit), at), policy: POS_POLICY_DEFAULTS, today: '2026-10-28' });

describe('birthDateFromRegister', () => {
  it('derives the birth date from YYMMDD', () => {
    expect(birthDateFromRegister('УЕ90051500')).toBe('1990-05-15');
    expect(birthDateFromRegister('УЕ99123100')).toBe('1999-12-31');
  });
  it('month > 20 means the 2000s with month - 20', () => {
    expect(birthDateFromRegister('УЕ05210100')).toBe('2005-01-01');
    expect(birthDateFromRegister('УЕ08323100')).toBe('2008-12-31');
    expect(birthDateFromRegister('УЕ00220100')).toBe('2000-02-01');
  });
  it('returns null for impossible dates or malformed registers', () => {
    expect(birthDateFromRegister('УЕ90023000')).toBeNull(); // 30 Feb
    expect(birthDateFromRegister('УЕ90131500')).toBeNull(); // month 13
    expect(birthDateFromRegister('УЕ90001500')).toBeNull(); // month 0
    expect(birthDateFromRegister('AB12345678')).toBeNull();
    expect(birthDateFromRegister('УЕ9005150')).toBeNull();
  });
});

describe('mock screening scenarios by the last digit (docs/05 §11.1)', () => {
  it('every response satisfies the kyc contract', () => {
    for (let d = 0; d <= 9; d++) expect(PosScreeningResponse.safeParse(mockScreeningFor(reg(d), at)).success, `digit ${d}`).toBe(true);
  });
  it.each([0, 9])('digit %i is normal: income 2,500,000, debt 150,000, FICO 700 -> APPROVE', (d) => {
    const s = mockScreeningFor(reg(d), at);
    expect(s.identity).toEqual({ found: true, lastName: MOCK_LAST_NAME, firstName: MOCK_FIRST_NAME, birthDate: '1990-05-15', phoneMatches: true });
    expect(s.income).toEqual({ monthlyAmount: 2_500_000, source: 'NDSH', months: 12 });
    expect(s.cib).toEqual({ available: true, activeLoanCount: 1, monthlyDebtService: 150_000, maxDpdDays: 0, ficoScore: 700 });
    expect(s.blacklist.hit).toBe(false);
    expect(s.pep).toBe(false);
    expect(s.fetchedAt).toBe(at.toISOString());
    expect(decide(d).decision).toBe('APPROVE');
  });
  it('digit 1: low income 700,000 -> DTI based REFER or DECLINE depending on the payment', () => {
    expect(mockScreeningFor(reg(1), at).income.monthlyAmount).toBe(700_000);
    const withPrice = (goodsPrice: number, downPayment: number) => decidePosLease({
      quote: quotePosLease({ planCode: 'LAPTOP', goodsPrice, downPayment, termMonths: 12, annualRate: 0.24, feeRate: 0.01, commissionRate: 0.03 }),
      screening: mockScreeningFor(reg(1), at), policy: POS_POLICY_DEFAULTS, today: '2026-10-28',
    });
    expect(decide(1).decision).toBe('APPROVE'); // 229k сарын төлбөр: ӨОХ 54%
    const refer = withPrice(3_500_000, 700_000); // ӨОХ ≈ 60%
    expect(refer.decision).toBe('REFER');
    expect(refer.reasons.map((x) => x.code)).toContain('DTI_EXCEEDED');
    const decline = withPrice(5_000_000, 500_000); // ӨОХ > 65%
    expect(decline.decision).toBe('DECLINE');
    expect(decline.reasons.map((x) => x.code)).toContain('DTI_EXCEEDED_HARD');
  });
  it('digit 2: blacklist hit -> REFER (not a hard decline)', () => {
    const s = mockScreeningFor(reg(2), at);
    expect(s.blacklist).toEqual({ hit: true, reasonCode: 'MOCK_BLACKLIST' });
    expect(decide(2).decision).toBe('REFER');
  });
  it('digit 3: 120 days past due -> DECLINE', () => {
    expect(mockScreeningFor(reg(3), at).cib.maxDpdDays).toBe(120);
    expect(decide(3).decision).toBe('DECLINE');
  });
  it('digit 4: no NDSH income -> REFER', () => {
    expect(mockScreeningFor(reg(4), at).income).toEqual({ monthlyAmount: null, source: 'NONE', months: 0 });
    expect(decide(4).decision).toBe('REFER');
  });
  it('digit 5: PEP -> REFER', () => {
    expect(mockScreeningFor(reg(5), at).pep).toBe(true);
    expect(decide(5).decision).toBe('REFER');
  });
  it('digit 6: no credit bureau data -> REFER', () => {
    expect(mockScreeningFor(reg(6), at).cib).toEqual({ available: false, activeLoanCount: 0, monthlyDebtService: 0, maxDpdDays: 0, ficoScore: null });
    expect(decide(6).decision).toBe('REFER');
  });
  it('digit 7: FICO 480 -> REFER', () => {
    expect(mockScreeningFor(reg(7), at).cib.ficoScore).toBe(480);
    expect(decide(7).decision).toBe('REFER');
  });
  it('digit 8: identity not found -> REFER', () => {
    expect(mockScreeningFor(reg(8), at).identity).toEqual({ found: false, lastName: null, firstName: null, birthDate: null, phoneMatches: null });
    expect(decide(8).decision).toBe('REFER');
  });
  it('an impossible birth date behaves as identity not found', () => {
    expect(mockScreeningFor('УЕ90023000', at).identity.found).toBe(false);
  });
  it('is deterministic and uses the injected clock', async () => {
    const clock = new FakeClock('2026-01-02T03:04:05.000Z');
    const svc = new MockBuyerScreening(clock);
    const req = { leaseId: 'x', registerNo: reg(0), phone: '99112212', consentVerifiedAt: '2026-01-02T03:04:05.000Z' };
    const a = await svc.screen(req);
    const b = await svc.screen(req);
    expect(a).toEqual(b);
    expect(a.fetchedAt).toBe('2026-01-02T03:04:05.000Z');
  });
});
