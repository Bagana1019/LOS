import { describe, expect, it } from 'vitest';
import {
  ErpFeeKind, ErpEventCancelBody, ErpEventListQuery, ErpEventStatus, ErpEventType, ErpEventRequeueBody, ErpEventRequeueDeadBody, ErpEventPayload, ErpMoneyInput, ErpMoneyString, ErpDisbursementInput, ErpFeeDeductionInput,
  ErpRepaymentInput, minorToErpMoney, erpMoneyToMinor, normalizeErpMoney,
} from './erp-sync';

// Deterministic PRNG (LCG) so property-style tests never flake
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
const orNull = <T>(f: () => T): T | null => { try { return f(); } catch { return null; } };

const base = { orgId: 'org-1', applicationId: 'app-1', sourceId: 'src-1', currency: 'MNT', businessDate: '2026-10-28' };
const parts = { principal: 0, interest: 0, penalty: 0, fee: 0, overpayment: 0 };

describe('enums', () => {
  it('exposes the expected, duplicate-free value lists', () => {
    expect([...ErpEventType]).toEqual(['DISBURSEMENT', 'FEE_DEDUCTION', 'REPAYMENT']);
    expect([...ErpEventStatus]).toEqual(['PENDING', 'SENT', 'DEAD', 'CANCELLED']);
    expect([...ErpFeeKind]).toEqual(['ORIGINATION', 'SERVICE', 'INSURANCE', 'OTHER']);
  });
});

describe('erpMoneyToMinor', () => {
  it.each([
    ['0.00', 0n], ['0.01', 1n], ['0.10', 10n], ['1.00', 100n], ['1250000.00', 125_000_000n], ['12.34', 1234n],
    ['9999999999999999.99', 999_999_999_999_999_999n], ['0000000000000001.50', 150n],
  ])('converts %s to %s minor units', (money, minor) => {
    expect(erpMoneyToMinor(money)).toBe(minor);
  });

  it.each([
    '', ' ', '1', '1.5', '1.500', '-1.00', '+1.00', ' 1.00', '1.00 ', '1.00\n', '.50', '5.', '1,000.00', '1e3', '1.0e2', 'NaN', 'Infinity',
    '0x10.00', '１.００', '12345678901234567.00', 'abc', '1.00.00', '--1.00', '١.٠٠',
  ])('rejects the malformed money string %j', (money) => {
    expect(() => erpMoneyToMinor(money)).toThrow(/invalid money string/);
  });
});

describe('minorToErpMoney', () => {
  it.each([
    [0n, '0.00'], [1n, '0.01'], [9n, '0.09'], [10n, '0.10'], [99n, '0.99'], [100n, '1.00'], [101n, '1.01'], [12345n, '123.45'],
    [125_000_000n, '1250000.00'], [999_999_999_999_999_999n, '9999999999999999.99'],
  ])('formats %s as %s', (minor, money) => {
    expect(minorToErpMoney(minor)).toBe(money);
  });

  it('rejects negative amounts', () => {
    expect(() => minorToErpMoney(-1n)).toThrow(/negative/);
    expect(() => minorToErpMoney(-100n)).toThrow(/negative/);
  });

  it('always yields a string accepted by ErpMoneyString for 16-digit-representable values', () => {
    for (const minor of [0n, 1n, 100n, 999_999_999_999_999_999n]) {
      expect(ErpMoneyString.safeParse(minorToErpMoney(minor)).success).toBe(true);
    }
  });
});

describe('money round trips', () => {
  it('minorToErpMoney -> erpMoneyToMinor is lossless for random 18-digit bigint values', () => {
    const rnd = lcg(42);
    for (let i = 0; i < 2000; i++) {
      const digits = 1 + Math.floor(rnd() * 18);
      let s = '';
      for (let d = 0; d < digits; d++) s += Math.floor(rnd() * 10);
      const minor = BigInt(s);
      expect(erpMoneyToMinor(minorToErpMoney(minor))).toBe(minor);
    }
  });

  it('erpMoneyToMinor -> minorToErpMoney returns canonical strings unchanged', () => {
    for (const money of ['0.00', '0.01', '10.10', '1250000.00', '9999999999999999.99', '1.05']) {
      expect(minorToErpMoney(erpMoneyToMinor(money))).toBe(money);
    }
  });

  it('normalizeErpMoney is idempotent on canonical strings', () => {
    for (const money of ['0.00', '0.01', '10.10', '1250000.00', '9999999999999999.99', '1.05']) {
      expect(normalizeErpMoney(money)).toBe(money);
      expect(normalizeErpMoney(normalizeErpMoney(money))).toBe(money);
    }
  });

  it('survives number -> normalizeErpMoney -> number for every cent amount below 100 000 000', () => {
    const rnd = lcg(7);
    for (let i = 0; i < 5000; i++) {
      const cents = Math.floor(rnd() * 100_000_000 * 100);
      const money = minorToErpMoney(BigInt(cents));
      expect(normalizeErpMoney(Number(money))).toBe(money);
    }
  });
});

describe('normalizeErpMoney', () => {
  describe('numbers', () => {
    it.each([
      [0, '0.00'], [1, '1.00'], [1250000, '1250000.00'], [1.5, '1.50'], [1.1, '1.10'], [19.99, '19.99'], [0.07, '0.07'], [0.29, '0.29'],
      [4.35, '4.35'], [1.15, '1.15'], [8.2, '8.20'], [-0, '0.00'], [100_000_000.01, '100000000.01'], [2 ** 44, '17592186044416.00'],
    ])('normalizes %s to %s', (input, expected) => {
      expect(normalizeErpMoney(input)).toBe(expected);
    });

    // Floating point arithmetic results are not money: rounding them silently would hide a bug in the caller's calculation
    it('rejects binary floating point noise such as 0.1 + 0.2 instead of rounding it', () => {
      expect(0.1 + 0.2).not.toBe(0.3);
      for (const noisy of [0.1 + 0.2, 0.1 * 3, 1.1 + 2.2]) expect(() => normalizeErpMoney(noisy), String(noisy)).toThrow(/more than 2 fraction digits/);
      expect(normalizeErpMoney(0.3)).toBe('0.30');
      expect(normalizeErpMoney('59.97')).toBe('59.97');
    });

    it('asks for a decimal string above 2^44 (17.5 trillion) where a double can no longer hold every cent', () => {
      expect(() => normalizeErpMoney(2 ** 44 + 1)).toThrow(/pass a decimal string/);
      expect(() => normalizeErpMoney(1e15)).toThrow(/pass a decimal string/);
      expect(normalizeErpMoney('1000000000000000')).toBe('1000000000000000.00');
    });

    it.each([[-1], [-0.01], [-1e-3], [-1e21]])('rejects the negative number %s', (input) => {
      expect(() => normalizeErpMoney(input)).toThrow(/invalid money amount/);
    });

    it.each([[NaN], [Infinity], [-Infinity]])('rejects the non-finite number %s', (input) => {
      expect(() => normalizeErpMoney(input)).toThrow(/invalid money amount/);
    });

    it.each([[1.005], [0.001], [0.015], [10.999], [1234.567], [0.5 / 3], [1 / 3]])('rejects %s because it has more than 2 fraction digits', (input) => {
      expect(() => normalizeErpMoney(input)).toThrow(/more than 2 fraction digits/);
    });

    it('rejects sub-cent amounts instead of silently rounding them to 0.00', () => {
      // 1e-9 currency units is not floating point noise: it is a third-and-beyond decimal digit
      expect(() => normalizeErpMoney(1e-9)).toThrow();
      expect(() => normalizeErpMoney(123456.000000001)).toThrow();
    });

    it('accepts valid 2-decimal amounts above 1 billion (cents must not be falsely rejected)', () => {
      // These are exact 2-decimal quantities; the float guard must not reject them as "more than 2 fraction digits"
      for (const money of ['1234567890.12', '560425185.82', '8908916587.38', '81004010154.68', '4651724933180.61']) {
        expect(normalizeErpMoney(Number(money))).toBe(money);
      }
    });

    it('neither rejects nor alters valid 2-decimal amounts with 8 to 13 integer digits', () => {
      const rnd = lcg(2026);
      const wrong: string[] = [];
      for (let i = 0; i < 4000; i++) {
        const exp = 8 + Math.floor(rnd() * 6); // 1e8 .. 1e13 integer parts
        const intPart = Math.floor(Math.pow(10, exp) * (1 + 9 * rnd()) / 10);
        const money = `${intPart}.${String(Math.floor(rnd() * 100)).padStart(2, '0')}`;
        const got = orNull(() => normalizeErpMoney(Number(money)));
        if (got !== money) wrong.push(`${money} -> ${got}`);
      }
      expect(wrong).toEqual([]);
    });

    it('does not silently return a different amount when cents are not exactly representable (>= 2^53 / 100)', () => {
      // 78703353921882.68 is a valid 2-decimal amount, but cannot be held as an exact double of cents: reject or return exactly it
      for (const money of ['78703353921882.68', '123456789012345.67', '938305948022753.80']) {
        const got = orNull(() => normalizeErpMoney(Number(money)));
        expect(got === null || got === money, `${money} -> ${got}`).toBe(true);
      }
    });

    it.each([[1e16], [1e17], [1e21], [Number.MAX_VALUE]])('rejects %s because it has more than 16 integer digits', (input) => {
      // erpMoneyToMinor/ErpMoneyString only accept up to 16 integer digits, so normalizeErpMoney must not emit a longer string
      expect(() => normalizeErpMoney(input)).toThrow();
    });

    it('output of the number path is always accepted by erpMoneyToMinor', () => {
      for (const input of [0, 1, 0.3, 1250000, 12345678.9, 2 ** 44]) {
        expect(() => erpMoneyToMinor(normalizeErpMoney(input))).not.toThrow();
      }
    });
  });

  describe('strings', () => {
    it.each([
      ['0', '0.00'], ['5', '5.00'], ['5.5', '5.50'], ['5.50', '5.50'], ['1250000', '1250000.00'], ['  12.5  ', '12.50'], ['\t7\n', '7.00'],
      ['9999999999999999', '9999999999999999.00'], ['9999999999999999.99', '9999999999999999.99'], ['0.1', '0.10'], ['0.01', '0.01'],
    ])('normalizes %j to %s', (input, expected) => {
      expect(normalizeErpMoney(input)).toBe(expected);
    });

    it('keeps the numeric value when the input has redundant leading zeros', () => {
      expect(erpMoneyToMinor(normalizeErpMoney('007.5'))).toBe(750n);
      expect(erpMoneyToMinor(normalizeErpMoney('0000000000000012'))).toBe(1200n);
    });

    it.each([
      '', ' ', '-1', '-0', '+1', '1.', '.5', '1.234', '1.005', '1,5', '1 000', '1_000', '1e3', 'abc', '12abc', 'NaN', 'Infinity', '0x10',
      '12345678901234567', '12345678901234567.00', '1.2.3', '１２', '1.00 USD',
    ])('rejects %j', (input) => {
      expect(() => normalizeErpMoney(input)).toThrow(/invalid money amount/);
    });

    it('enforces the 16-digit integer limit exactly at the boundary', () => {
      expect(normalizeErpMoney('9999999999999999.99')).toBe('9999999999999999.99');
      expect(() => normalizeErpMoney('10000000000000000.00')).toThrow();
    });
  });
});

describe('ErpMoneyString', () => {
  it.each(['0.00', '1.00', '1250000.00', '9999999999999999.99'])('accepts %s', (v) => {
    expect(ErpMoneyString.safeParse(v).success).toBe(true);
  });
  it.each(['0', '1.5', '1.500', '-1.00', ' 1.00', '1,00', '', '10000000000000000.00', 1.5, null])('rejects %j', (v) => {
    expect(ErpMoneyString.safeParse(v).success).toBe(false);
  });
});

describe('ErpMoneyInput', () => {
  it('transforms numbers and strings to canonical money strings', () => {
    expect(ErpMoneyInput.parse(1.5)).toBe('1.50');
    expect(ErpMoneyInput.parse(0.3)).toBe('0.30');
    expect(ErpMoneyInput.parse('  3 ')).toBe('3.00');
    expect(ErpMoneyInput.parse('12.5')).toBe('12.50');
  });

  it('reports invalid values as zod issues carrying the normalizeErpMoney message', () => {
    const neg = ErpMoneyInput.safeParse(-1);
    expect(neg.success).toBe(false);
    if (!neg.success) expect(neg.error.issues[0]?.message).toMatch(/invalid money amount/);
    const frac = ErpMoneyInput.safeParse(1.005);
    expect(frac.success).toBe(false);
    if (!frac.success) expect(frac.error.issues[0]?.message).toMatch(/more than 2 fraction digits/);
    expect(ErpMoneyInput.safeParse('abc').success).toBe(false);
  });

  it.each([[NaN], [null], [undefined], [true], [{}], [[]]])('rejects the non-number/non-string value %j', (v) => {
    expect(ErpMoneyInput.safeParse(v).success).toBe(false);
  });
});

describe('ErpDisbursementInput', () => {
  it('applies the documented defaults', () => {
    const r = ErpDisbursementInput.parse({ ...base, amount: 10_000_000 });
    expect(r).toEqual({
      orgId: 'org-1', branchId: null, applicationId: 'app-1', contractNo: null, coreLoanId: null, customerId: null,
      sourceId: 'src-1', currency: 'MNT', businessDate: '2026-10-28', actorId: null, amount: '10000000.00',
    });
    expect(r.correlationId).toBeUndefined();
  });

  it('keeps explicitly supplied optional fields and strips unknown keys', () => {
    const r = ErpDisbursementInput.parse({
      ...base, amount: '1.5', branchId: 'br', contractNo: 'C-1', coreLoanId: 'L-1', customerId: 'cu', currency: 'USD', correlationId: 'corr', actorId: 'u1', rogue: 1,
    });
    expect(r).toMatchObject({ branchId: 'br', contractNo: 'C-1', coreLoanId: 'L-1', customerId: 'cu', currency: 'USD', correlationId: 'corr', actorId: 'u1', amount: '1.50' });
    expect(r).not.toHaveProperty('rogue');
  });

  it('accepts null for the nullable ids but rejects empty strings', () => {
    expect(ErpDisbursementInput.safeParse({ ...base, amount: 1, branchId: null, contractNo: null, coreLoanId: null, customerId: null }).success).toBe(true);
    for (const k of ['branchId', 'contractNo', 'coreLoanId', 'customerId', 'orgId', 'applicationId', 'sourceId', 'correlationId']) {
      expect(ErpDisbursementInput.safeParse({ ...base, amount: 1, [k]: '' }).success, k).toBe(false);
    }
  });

  it('requires orgId, applicationId, sourceId, currency, businessDate and amount (the currency has no default so a wrong one is never booked silently)', () => {
    for (const k of ['orgId', 'applicationId', 'sourceId', 'currency', 'businessDate']) {
      const { [k]: _omitted, ...rest } = base as Record<string, string>;
      expect(ErpDisbursementInput.safeParse({ ...rest, amount: 1 }).success, k).toBe(false);
    }
    expect(ErpDisbursementInput.safeParse({ ...base }).success).toBe(false);
  });

  it('limits sourceId to 1..100 characters', () => {
    expect(ErpDisbursementInput.safeParse({ ...base, amount: 1, sourceId: 'x' }).success).toBe(true);
    expect(ErpDisbursementInput.safeParse({ ...base, amount: 1, sourceId: 'x'.repeat(100) }).success).toBe(true);
    expect(ErpDisbursementInput.safeParse({ ...base, amount: 1, sourceId: 'x'.repeat(101) }).success).toBe(false);
    expect(ErpDisbursementInput.safeParse({ ...base, amount: 1, sourceId: '' }).success).toBe(false);
  });

  // These values end up in HTTP headers (Idempotency-Key, X-Correlation-Id): anything that cannot be sent as a header would loop in the retry queue
  it.each([['sourceId', 'гэрээ-1'], ['sourceId', 'a b'], ['sourceId', 'a\r\nX-Evil: 1'], ['sourceId', '-leading'], ['orgId', 'org 1'], ['orgId', 'o'.repeat(41)],
    ['correlationId', 'хүсэлт'], ['correlationId', 'c\nX: 1'], ['correlationId', 'c'.repeat(101)]])('rejects the header-unsafe %s %j', (key, value) => {
    expect(ErpDisbursementInput.safeParse({ ...base, amount: 1, [key]: value }).success).toBe(false);
  });

  it.each([['QPAY:20261028-000123'], ['bank.txn_7-A'], ['550e8400-e29b-41d4-a716-446655440000']])('accepts the channel reference %j as a sourceId', (sourceId) => {
    expect(ErpDisbursementInput.safeParse({ ...base, amount: 1, sourceId }).success).toBe(true);
  });

  it('accepts Decimal-like amounts (Prisma.Decimal) via toFixed', () => {
    const decimal = { toFixed: () => '1250000.50', toString: () => '1250000.5' };
    expect(ErpDisbursementInput.parse({ ...base, amount: decimal }).amount).toBe('1250000.50');
  });

  it('rejects dates outside 2000..2100', () => {
    for (const businessDate of ['1999-12-31', '2101-01-01', '0001-01-01']) expect(ErpDisbursementInput.safeParse({ ...base, amount: 1, businessDate }).success, businessDate).toBe(false);
  });

  it.each([[0], ['0'], ['0.00'], ['  0 '], [0.0]])('rejects the zero amount %j', (amount) => {
    const r = ErpDisbursementInput.safeParse({ ...base, amount });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]).toMatchObject({ path: ['amount'], message: 'amount must be greater than zero' });
  });

  it.each([[0.01], ['0.01'], [1], ['9999999999999999.99'], [' 5 ']])('accepts the positive amount %j', (amount) => {
    expect(ErpDisbursementInput.safeParse({ ...base, amount }).success).toBe(true);
  });

  it.each([[-5], ['-5'], [-0.01], ['abc'], [''], [1.005], ['1.005'], [Infinity], ['1e3'], ['10000000000000000.00'], ['1,000.00']])(
    'reports the invalid amount %j as a failed parse (safeParse must not throw)', (amount) => {
      const r = ErpDisbursementInput.safeParse({ ...base, amount });
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues.some((i) => i.path[0] === 'amount')).toBe(true);
    });

  it.each([[NaN], [null], [undefined], [true], [{}]])('rejects the non-money amount %j', (amount) => {
    expect(ErpDisbursementInput.safeParse({ ...base, amount }).success).toBe(false);
  });

  it.each(['mnt', 'MN', 'MNTT', '', 'M1T', ' MNT'])('rejects the currency %j', (currency) => {
    expect(ErpDisbursementInput.safeParse({ ...base, amount: 1, currency }).success).toBe(false);
  });

  it.each(['USD', 'EUR', 'MNT'])('accepts the currency %s', (currency) => {
    expect(ErpDisbursementInput.parse({ ...base, amount: 1, currency }).currency).toBe(currency);
  });

  it.each(['28-10-2026', '2026/10/28', '2026-1-1', '20261028', '2026-10-28T00:00:00Z', ' 2026-10-28', '', 'today'])('rejects the malformed businessDate %j', (businessDate) => {
    expect(ErpDisbursementInput.safeParse({ ...base, amount: 1, businessDate }).success).toBe(false);
  });

  it.each(['2026-02-30', '2026-13-01', '2026-00-10', '2026-04-31', '2026-10-32', '2025-02-29', '0000-00-00', '2026-10-00'])(
    'rejects the impossible calendar date %j (Postgres would abort the caller transaction on ::date)', (businessDate) => {
      expect(ErpDisbursementInput.safeParse({ ...base, amount: 1, businessDate }).success).toBe(false);
    });

  it.each(['2026-02-28', '2028-02-29', '2026-12-31', '2026-01-01'])('accepts the real calendar date %s', (businessDate) => {
    expect(ErpDisbursementInput.safeParse({ ...base, amount: 1, businessDate }).success).toBe(true);
  });
});

describe('ErpFeeDeductionInput', () => {
  const fee = (over: Record<string, unknown> = {}) => ({ kind: 'SERVICE', amount: 100, ...over });

  it('normalizes each fee amount and applies the base defaults', () => {
    const r = ErpFeeDeductionInput.parse({ ...base, fees: [fee({ amount: '1.5' }), fee({ kind: 'INSURANCE', amount: 0.3, memo: 'ins' })] });
    expect(r.fees).toEqual([{ kind: 'SERVICE', amount: '1.50' }, { kind: 'INSURANCE', amount: '0.30', memo: 'ins' }]);
    expect(r).toMatchObject({ branchId: null, contractNo: null, currency: 'MNT', actorId: null });
  });

  it('requires between 1 and 20 fees', () => {
    expect(ErpFeeDeductionInput.safeParse({ ...base, fees: [] }).success).toBe(false);
    expect(ErpFeeDeductionInput.safeParse({ ...base }).success).toBe(false);
    expect(ErpFeeDeductionInput.safeParse({ ...base, fees: [fee()] }).success).toBe(true);
    expect(ErpFeeDeductionInput.safeParse({ ...base, fees: Array.from({ length: 20 }, () => fee()) }).success).toBe(true);
    expect(ErpFeeDeductionInput.safeParse({ ...base, fees: Array.from({ length: 21 }, () => fee()) }).success).toBe(false);
  });

  it('accepts every ErpFeeKind and rejects unknown kinds', () => {
    for (const kind of ErpFeeKind) expect(ErpFeeDeductionInput.safeParse({ ...base, fees: [fee({ kind })] }).success, kind).toBe(true);
    for (const kind of ['', 'service', 'TAX', undefined]) expect(ErpFeeDeductionInput.safeParse({ ...base, fees: [fee({ kind })] }).success, String(kind)).toBe(false);
  });

  it('limits memo to 200 characters', () => {
    expect(ErpFeeDeductionInput.safeParse({ ...base, fees: [fee({ memo: 'm'.repeat(200) })] }).success).toBe(true);
    expect(ErpFeeDeductionInput.safeParse({ ...base, fees: [fee({ memo: 'm'.repeat(201) })] }).success).toBe(false);
  });

  it('requires positive fee amounts', () => {
    for (const amount of [0, '0', '0.00']) {
      const r = ErpFeeDeductionInput.safeParse({ ...base, fees: [fee(), fee({ amount })] });
      expect(r.success, String(amount)).toBe(false);
      if (!r.success) expect(r.error.issues[0]).toMatchObject({ path: ['fees', 1, 'amount'], message: 'amount must be greater than zero' });
    }
  });

  it.each([[-1], ['abc'], [1.005], [Infinity]])('reports the invalid fee amount %j as a failed parse (safeParse must not throw)', (amount) => {
    const r = ErpFeeDeductionInput.safeParse({ ...base, fees: [fee({ amount })] });
    expect(r.success).toBe(false);
  });
});

describe('ErpRepaymentInput', () => {
  const full = (over: Record<string, unknown> = {}) => ({ ...base, ...parts, receivedAmount: 5, overpayment: 5, ...over });

  it('requires every part of the allocation explicitly, zero included, so a forgotten component can never become "overpayment"', () => {
    expect(ErpRepaymentInput.safeParse({ ...base, receivedAmount: 1000 }).success).toBe(false);
    for (const k of Object.keys(parts)) {
      const { [k]: _omitted, ...rest } = full();
      const r = ErpRepaymentInput.safeParse(rest);
      expect(r.success, k).toBe(false);
      if (!r.success) expect(r.error.issues.some((i) => i.path[0] === k), k).toBe(true);
    }
  });

  it('normalizes numeric and string parts', () => {
    const r = ErpRepaymentInput.parse({ ...base, receivedAmount: '1000', principal: 600.5, interest: '250.25', penalty: 0.3, fee: 0, overpayment: '149.0' });
    expect(r).toMatchObject({ receivedAmount: '1000.00', principal: '600.50', interest: '250.25', penalty: '0.30', fee: '0.00', overpayment: '149.00' });
  });

  it('requires a strictly positive receivedAmount', () => {
    for (const receivedAmount of [0, '0', '0.00']) {
      const r = ErpRepaymentInput.safeParse(full({ receivedAmount }));
      expect(r.success, String(receivedAmount)).toBe(false);
    }
    expect(ErpRepaymentInput.safeParse({ ...base }).success).toBe(false);
    expect(ErpRepaymentInput.safeParse(full({ receivedAmount: 0.01, overpayment: 0.01 })).success).toBe(true);
  });

  it('accepts zero parts but rejects negative, fractional and null parts', () => {
    for (const k of Object.keys(parts)) {
      expect(ErpRepaymentInput.safeParse(full({ [k]: 0 })).success, `${k}=0`).toBe(true);
      expect(ErpRepaymentInput.safeParse(full({ [k]: -1 })).success, `${k}=-1`).toBe(false);
      expect(ErpRepaymentInput.safeParse(full({ [k]: '-0.01' })).success, `${k}=-0.01`).toBe(false);
      expect(ErpRepaymentInput.safeParse(full({ [k]: 1.001 })).success, `${k}=1.001`).toBe(false);
      expect(ErpRepaymentInput.safeParse(full({ [k]: 'abc' })).success, `${k}=abc`).toBe(false);
      expect(ErpRepaymentInput.safeParse(full({ [k]: null })).success, `${k}=null`).toBe(false);
    }
  });

  it.each([[-1], ['abc'], [1.005], [Infinity], ['10000000000000000.00']])('reports the invalid receivedAmount %j as a failed parse (safeParse must not throw)', (receivedAmount) => {
    expect(ErpRepaymentInput.safeParse(full({ receivedAmount })).success).toBe(false);
  });

  it.each([[1e16], [1e21]])('rejects a part of %s that exceeds the 16-digit money limit', (principal) => {
    expect(ErpRepaymentInput.safeParse(full({ principal })).success).toBe(false);
  });
});

describe('ErpEventPayload', () => {
  const head = (over: Record<string, unknown> = {}) => ({
    schemaVersion: 1, eventId: '0b7e3d9e-1c6f-4a2b-8d5e-9f0a1b2c3d4e', idempotencyKey: 'org-1:DISBURSEMENT:src-1', eventType: 'DISBURSEMENT',
    orgId: 'org-1', branchId: null, applicationId: 'app-1', contractNo: null, coreLoanId: null, customerId: null,
    businessDate: '2026-10-28', currency: 'MNT', data: { amount: '100.00' }, correlationId: 'corr-1', createdAt: '2026-10-28T01:02:03.000Z', ...over,
  });
  const fee = (over: Record<string, unknown> = {}) => head({
    eventType: 'FEE_DEDUCTION', idempotencyKey: 'org-1:FEE_DEDUCTION:src-1',
    data: { fees: [{ kind: 'ORIGINATION', amount: '10.00' }, { kind: 'INSURANCE', amount: '5.50', memo: 'жилийн даатгал' }], totalAmount: '15.50' }, ...over,
  });
  const repayment = (data: Record<string, unknown> = {}) => head({
    eventType: 'REPAYMENT', idempotencyKey: 'org-1:REPAYMENT:src-1',
    data: { receivedAmount: '100.00', principal: '60.00', interest: '30.00', penalty: '5.00', fee: '2.00', overpayment: '3.00', ...data },
  });
  const messages = (v: unknown) => {
    const r = ErpEventPayload.safeParse(v);
    return r.success ? null : r.error.issues.map((i) => i.message);
  };

  it('accepts one payload per event type and returns it unchanged', () => {
    for (const p of [head(), fee(), repayment()]) {
      const r = ErpEventPayload.safeParse(p);
      expect(r.success).toBe(true);
      if (r.success) expect(r.data).toEqual(p);
    }
  });

  it('carries no ledger concepts: lines, account codes and totals are the ERP\'s business', () => {
    const r = ErpEventPayload.parse({ ...head(), lines: [{ accountCode: '1010' }], totals: { debit: '1.00', credit: '1.00' }, description: 'x' });
    expect(r).not.toHaveProperty('lines');
    expect(r).not.toHaveProperty('totals');
    expect(r).not.toHaveProperty('description');
  });

  it('rejects a repayment whose allocation does not equal receivedAmount', () => {
    expect(messages(repayment({ overpayment: '2.99' }))).toContain('allocation does not equal receivedAmount');
    expect(messages(repayment({ overpayment: '3.01' }))).toContain('allocation does not equal receivedAmount');
    expect(messages(repayment())).toBeNull();
  });

  it('requires every repayment part and a canonical money string', () => {
    for (const k of ['receivedAmount', 'principal', 'interest', 'penalty', 'fee', 'overpayment']) {
      const { [k]: _omitted, ...rest } = repayment().data;
      expect(ErpEventPayload.safeParse(repayment() && { ...repayment(), data: rest }).success, k).toBe(false);
    }
    expect(ErpEventPayload.safeParse(repayment({ principal: '60' })).success).toBe(false);
    expect(ErpEventPayload.safeParse(repayment({ principal: 60 })).success).toBe(false);
  });

  it('keeps the event data aligned with the eventType (discriminated union)', () => {
    expect(ErpEventPayload.safeParse(head({ eventType: 'FEE_DEDUCTION' })).success).toBe(false);
    expect(ErpEventPayload.safeParse(fee({ eventType: 'DISBURSEMENT' })).success).toBe(false);
    expect(ErpEventPayload.safeParse(head({ eventType: 'REPAYMENT' })).success).toBe(false);
    expect(ErpEventPayload.safeParse(head({ eventType: 'JOURNAL' })).success).toBe(false);
  });

  it('limits fees to 1..20 entries with known kinds and memo ≤ 200', () => {
    const withFees = (fees: unknown[]) => fee({ data: { fees, totalAmount: '1.00' } });
    expect(ErpEventPayload.safeParse(withFees([])).success).toBe(false);
    expect(ErpEventPayload.safeParse(withFees(Array.from({ length: 21 }, () => ({ kind: 'OTHER', amount: '1.00' })))).success).toBe(false);
    expect(ErpEventPayload.safeParse(withFees(Array.from({ length: 20 }, () => ({ kind: 'OTHER', amount: '1.00' })))).success).toBe(true);
    expect(ErpEventPayload.safeParse(withFees([{ kind: 'TAX', amount: '1.00' }])).success).toBe(false);
    expect(ErpEventPayload.safeParse(withFees([{ kind: 'OTHER', amount: '1.00', memo: 'm'.repeat(201) }])).success).toBe(false);
  });

  it('only accepts schemaVersion 1', () => {
    expect(ErpEventPayload.safeParse(head({ schemaVersion: 2 })).success).toBe(false);
    expect(ErpEventPayload.safeParse(head({ schemaVersion: '1' })).success).toBe(false);
  });

  it('requires a UUID eventId', () => {
    expect(ErpEventPayload.safeParse(head({ eventId: 'not-a-uuid' })).success).toBe(false);
    expect(ErpEventPayload.safeParse(head({ eventId: undefined })).success).toBe(false);
  });

  it('limits idempotencyKey to 1..200 characters', () => {
    expect(ErpEventPayload.safeParse(head({ idempotencyKey: '' })).success).toBe(false);
    expect(ErpEventPayload.safeParse(head({ idempotencyKey: 'k'.repeat(200) })).success).toBe(true);
    expect(ErpEventPayload.safeParse(head({ idempotencyKey: 'k'.repeat(201) })).success).toBe(false);
  });

  it('validates currency, businessDate and createdAt formats', () => {
    expect(ErpEventPayload.safeParse(head({ currency: 'mnt' })).success).toBe(false);
    expect(ErpEventPayload.safeParse(head({ businessDate: '2026-02-30' })).success).toBe(false);
    expect(ErpEventPayload.safeParse(head({ businessDate: '28-10-2026' })).success).toBe(false);
    expect(ErpEventPayload.safeParse(head({ createdAt: 'yesterday' })).success).toBe(false);
  });

  it('requires the nullable header fields to be present (null is allowed, undefined is not)', () => {
    for (const k of ['branchId', 'contractNo', 'coreLoanId', 'customerId']) {
      expect(ErpEventPayload.safeParse(head({ [k]: null })).success, `${k} null`).toBe(true);
      expect(ErpEventPayload.safeParse(head({ [k]: undefined })).success, `${k} undefined`).toBe(false);
    }
  });

  it('validates the disbursement amount as a canonical money string', () => {
    for (const amount of ['100', '1.5', '-1.00', 100, '', '10000000000000000.00']) {
      expect(ErpEventPayload.safeParse(head({ data: { amount } })).success, String(amount)).toBe(false);
    }
  });

  it('strips unknown top-level keys', () => {
    expect(ErpEventPayload.parse({ ...head(), extra: 1 })).toEqual(head());
  });
});

describe('ops schemas', () => {
  it('ErpEventListQuery applies defaults and coerces limit', () => {
    expect(ErpEventListQuery.parse({})).toEqual({ limit: 50 });
    expect(ErpEventListQuery.parse({ limit: '10', status: 'DEAD', eventType: 'REPAYMENT', applicationId: 'a', errorCode: 'REJECTED', cursor: '123' }))
      .toEqual({ limit: 10, status: 'DEAD', eventType: 'REPAYMENT', applicationId: 'a', errorCode: 'REJECTED', cursor: '123' });
  });
  it('ErpEventListQuery bounds the limit to 1..100 and validates enums and cursor', () => {
    expect(ErpEventListQuery.safeParse({ limit: '100' }).success).toBe(true);
    for (const limit of ['0', '101', '-1', '1.5', 'abc']) expect(ErpEventListQuery.safeParse({ limit }).success, limit).toBe(false);
    expect(ErpEventListQuery.safeParse({ status: 'NOPE' }).success).toBe(false);
    expect(ErpEventListQuery.safeParse({ eventType: 'NOPE' }).success).toBe(false);
    for (const cursor of ['abc', '-1', '1.5', '', '12a', '1'.repeat(19)]) expect(ErpEventListQuery.safeParse({ cursor }).success, cursor).toBe(false);
  });
  it('ErpEventCancelBody requires a trimmed 3..500 character note', () => {
    expect(ErpEventCancelBody.parse({ note: '  abc  ' })).toEqual({ note: 'abc' });
    for (const note of ['', 'ab', '  ab  ', '   ', 'n'.repeat(501), undefined]) expect(ErpEventCancelBody.safeParse({ note }).success, String(note)).toBe(false);
    expect(ErpEventCancelBody.safeParse({ note: 'n'.repeat(500) }).success).toBe(true);
  });
  it('ErpEventRequeueBody accepts an optional trimmed note up to 500 characters', () => {
    expect(ErpEventRequeueBody.parse({})).toEqual({});
    expect(ErpEventRequeueBody.parse({ note: '  retry  ' })).toEqual({ note: 'retry' });
    expect(ErpEventRequeueBody.safeParse({ note: 'n'.repeat(501) }).success).toBe(false);
  });
  it('ErpEventRequeueBody takes no amendments: the event content is immutable', () => {
    expect(ErpEventRequeueBody.parse({ businessDate: '2026-11-02', refreshAccounts: true, note: 'x' })).toEqual({ note: 'x' });
  });
  it('ErpEventRequeueDeadBody defaults the limit to 200 and bounds it to 1..500', () => {
    expect(ErpEventRequeueDeadBody.parse({})).toEqual({ limit: 200 });
    expect(ErpEventRequeueDeadBody.parse({ errorCode: 'REJECTED', limit: 500, note: ' fixed ' })).toEqual({ errorCode: 'REJECTED', limit: 500, note: 'fixed' });
    for (const limit of [0, 501, 1.5, '10']) expect(ErpEventRequeueDeadBody.safeParse({ limit }).success, String(limit)).toBe(false);
    expect(ErpEventRequeueDeadBody.safeParse({ errorCode: 'x'.repeat(65) }).success).toBe(false);
  });
});
