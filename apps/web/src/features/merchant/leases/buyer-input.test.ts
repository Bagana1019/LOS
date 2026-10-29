import { MnMobile, RegisterNo } from '@los/contracts';
import { describe, expect, it } from 'vitest';
import { normalizePhone, normalizeRegister, PHONE_INPUT_MAXLENGTH, REGISTER_INPUT_MAXLENGTH } from './buyer-input';

// n=36: paste ('+976 9911-2233', '9911-2233', 'УЕ 90051500') нь maxLength-ээр тасрахгүй, баталгаажуулалтаас өмнө жигдэрнэ.

describe('normalizePhone', () => {
  it('strips separators and the +976 / 976 / 00976 country prefix from a complete number', () => {
    for (const raw of ['99112233', '9911 2233', '9911-2233', '+976 9911 2233', '+976-9911-2233', '(976) 99112233', '97699112233', '0097699112233', '00976 9911 2233', ' 99.11.22.33 ']) {
      expect(normalizePhone(raw), raw).toBe('99112233');
    }
  });
  it('normalised paste passes the contract MnMobile rule', () => {
    for (const raw of ['+976 9911 2233', '9911-2233', '97699112233']) expect(MnMobile.safeParse(normalizePhone(raw)).success, raw).toBe(true);
  });
  it('never eats the first digits of a genuine 8-digit number that happens to start with 976', () => {
    expect(normalizePhone('97612345')).toBe('97612345');
    expect(normalizePhone('976')).toBe('976');
    expect(normalizePhone('97699')).toBe('97699'); // бичиж байх үед
  });
  it('does not truncate too-long input (validation must show the error, not a silently cut number)', () => {
    expect(normalizePhone('991122334455')).toBe('991122334455');
    expect(MnMobile.safeParse(normalizePhone('991122334455')).success).toBe(false);
  });
  it('garbage and empty values', () => {
    expect(normalizePhone('abc')).toBe('');
    expect(normalizePhone('')).toBe('');
    expect(normalizePhone(undefined)).toBe('');
    expect(normalizePhone(null)).toBe('');
  });
});

describe('normalizeRegister', () => {
  it('upper-cases and removes spaces and separators from a pasted register', () => {
    for (const raw of ['УЕ90051500', 'УЕ 90051500', 'уе90051500', ' уе 9005 1500 ', 'УЕ-90051500', 'УЕ.90051500', 'УЕ 90051500', 'УЕ​90051500']) {
      expect(normalizeRegister(raw), raw).toBe('УЕ90051500');
    }
    expect(normalizeRegister('өү12345678')).toBe('ӨҮ12345678');
  });
  it('normalised paste passes the contract RegisterNo rule', () => {
    expect(RegisterNo.safeParse(normalizeRegister('уе 90051500')).success).toBe(true);
  });
  it('does not truncate or rewrite letters (Latin look-alikes stay invalid and are reported)', () => {
    expect(normalizeRegister('YE90051500')).toBe('YE90051500');
    expect(RegisterNo.safeParse(normalizeRegister('YE90051500')).success).toBe(false);
    expect(normalizeRegister('УЕ900515001')).toBe('УЕ900515001');
  });
  it('empty values', () => {
    expect(normalizeRegister(undefined)).toBe('');
    expect(normalizeRegister(null)).toBe('');
  });
});

describe('DOM maxLength is roomy enough for formatted paste', () => {
  it('fits the longest common formats before normalisation', () => {
    expect('+976 9911 2233'.length).toBeLessThanOrEqual(PHONE_INPUT_MAXLENGTH);
    expect('00976 9911-2233'.length).toBeLessThanOrEqual(PHONE_INPUT_MAXLENGTH);
    expect('УЕ 9005 1500'.length).toBeLessThanOrEqual(REGISTER_INPUT_MAXLENGTH);
    expect(PHONE_INPUT_MAXLENGTH).toBeGreaterThan(8);
    expect(REGISTER_INPUT_MAXLENGTH).toBeGreaterThan(10);
  });
});
