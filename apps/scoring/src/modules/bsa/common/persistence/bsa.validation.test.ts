import { describe, expect, it } from 'vitest';
import { BsaInvalidError, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './bsa.repository';
import {
  analysisPatchSchema, isIsoDate, mergeAccounts, newTxnSchema, normalizeAccount, normalizeRegisterNo, resolvePage, roundMoney, roundTo, toJson, validate,
} from './bsa.validation';

describe('roundTo / roundMoney', () => {
  it('rounds half away from zero on the decimal representation, not the binary one', () => {
    expect(roundMoney(1.005)).toBe(1.01); // Math.round(1.005 * 100) / 100 === 1
    expect(roundMoney(2.675)).toBe(2.68);
    expect(roundMoney(-1.005)).toBe(-1.01);
    expect(roundMoney(1234567.89)).toBe(1234567.89);
    expect(roundMoney(0.1 + 0.2)).toBe(0.3);
    expect(roundMoney(0.004)).toBe(0);
    expect(roundMoney(-0.004)).toBe(0);
    expect(Object.is(roundMoney(-0.004), 0)).toBe(true); // -0 биш
    expect(roundMoney(0.005)).toBe(0.01);
  });
  it('handles exponent notation and other precisions', () => {
    expect(roundMoney(1e-7)).toBe(0);
    expect(roundMoney(123456789012.345)).toBe(123456789012.35);
    expect(roundTo(0.85, 4)).toBe(0.85);
    expect(roundTo(0.123456, 4)).toBe(0.1235);
  });
});

describe('isIsoDate', () => {
  it('accepts only real calendar dates in YYYY-MM-DD', () => {
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(isIsoDate('2028-02-29')).toBe(true);
    for (const bad of ['2026-02-29', '2026-13-01', '2026-00-10', '2026-1-1', '20260101', '2026-01-01T00:00:00Z', '', ' 2026-01-01']) expect(isIsoDate(bad)).toBe(false);
  });
});

describe('normalizers', () => {
  it('normalizes accounts and register numbers (whitespace stripped, upper-case, Cyrillic aware)', () => {
    expect(normalizeAccount(' mn12 3456 ')).toBe('MN123456');
    expect(normalizeRegisterNo('уб 9001 0203')).toBe('УБ90010203');
  });
  it('merges accounts without duplicates, keeping order and dropping blanks', () => {
    expect(mergeAccounts(['A1', 'B2'], ['b2', ' c 3', '', '  '])).toEqual(['A1', 'B2', 'C3']);
    expect(mergeAccounts([], [])).toEqual([]);
  });
  it('toJson mimics a jsonb round trip', () => {
    expect(toJson({ a: 1, d: new Date('2026-01-01T00:00:00Z'), u: undefined, n: null })).toEqual({ a: 1, d: '2026-01-01T00:00:00.000Z', n: null });
    expect(toJson(undefined)).toBeUndefined();
  });
});

describe('resolvePage', () => {
  it('applies defaults, clamps the limit and rejects invalid paging', () => {
    expect(resolvePage()).toEqual({ limit: DEFAULT_PAGE_SIZE, offset: 0 });
    expect(resolvePage({ limit: 10, offset: 20 })).toEqual({ limit: 10, offset: 20 });
    expect(resolvePage({ limit: MAX_PAGE_SIZE + 1 }).limit).toBe(MAX_PAGE_SIZE);
    for (const bad of [{ limit: 0 }, { limit: -1 }, { limit: 2.5 }, { offset: -1 }, { offset: 0.5 }, { limit: Number.NaN }]) expect(() => resolvePage(bad)).toThrow(BsaInvalidError);
  });
});

describe('validate', () => {
  it('reports the failing path and zod code but never the offending value', () => {
    const secret = 'ПИИ-УТГА-123';
    let caught: unknown;
    try {
      validate(newTxnSchema, { seq: 1, txnDate: secret, direction: 'INCOME', amount: 1, description: 'x', statementKey: 's', dedupeKey: 'd' }, 'rows.4');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BsaInvalidError);
    expect((caught as BsaInvalidError).field).toBe('rows.4.txnDate');
    expect((caught as Error).message).not.toContain(secret);
  });

  it('applies defaults and rounding to transactions', () => {
    const v = validate(newTxnSchema, { seq: 1, txnDate: '2026-03-10', direction: 'EXPENSE', amount: 10.005, description: '', statementKey: 's', dedupeKey: 'd', confidence: 85.555 }, 'row');
    expect(v).toMatchObject({ amount: 10.01, channel: 'OTHER', confidence: 85.56, isOwnTransfer: false, categoryCode: null, txnTime: null, balanceAfter: null, counterpartyName: null });
  });

  it('rejects unknown patch keys (strict) and an inverted period', () => {
    expect(() => validate(analysisPatchSchema, { orgId: 'other' }, 'patch')).toThrow(BsaInvalidError);
    expect(() => validate(analysisPatchSchema, { periodFrom: '2026-05-01', periodTo: '2026-04-01' }, 'patch')).toThrow(BsaInvalidError);
    expect(validate(analysisPatchSchema, { periodFrom: '2026-05-01' }, 'patch')).toEqual({ periodFrom: '2026-05-01' });
  });
});
