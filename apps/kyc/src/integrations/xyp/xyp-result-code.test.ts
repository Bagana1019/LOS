import { describe, expect, it } from 'vitest';
import { classifyXypResultCode, parseXypResultCode } from './xyp-result-code';

// Эх сурвалж: ХУР-ын албан ёсны resultCode хүснэгт (developer.xyp.gov.mn/docs/result-code, 2026-11-19-нд уншсан).
describe('classifyXypResultCode', () => {
  it.each([
    [0, 'OK'],
    [1, 'NOT_FOUND'],
    [1001, 'CODE_REJECTED'], // OTP_NOT_FOUND: иргэний код олдсонгүй
    [1002, 'CODE_REJECTED'], // OTP_NOT_MATCH
    [1005, 'CODE_NOT_SENT'], // OTP_NOT_SENT
    [1006, 'CODE_NOT_SENT'], // REG_PHONE_NOT_MATCH
  ] as const)('%i → %s', (code, expected) => {
    expect(classifyXypResultCode(code)).toBe(expected);
  });

  it.each([2, 3, 200, 201, 202, 203, 301, 302, 303, 304, 401, 402, 501, 601, 602, 603, 604, 605, 801, 802, 1003, 1004])('хүснэгтэд байгаа бусад алдааны код %i → FAILED', (code) => {
    expect(classifyXypResultCode(code)).toBe('FAILED');
  });

  it.each([5, 500, 999, 1007, -1, 2.5, Number.NaN])('хүснэгтэд байхгүй %s → UNKNOWN (дуудагч текстийн дүрмээр шийднэ)', (code) => {
    expect(classifyXypResultCode(code)).toBe('UNKNOWN');
  });
});

describe('parseXypResultCode', () => {
  it.each([[0, 0], [1005, 1005], ['1006', 1006], [' 3 ', 3]])('%j → %j', (raw, expected) => {
    expect(parseXypResultCode(raw)).toBe(expected);
  });

  it.each([[undefined], [null], [''], ['abc'], ['12abc'], [1.5], [{}], [[]], [true]])('тоон код биш %j → undefined', (raw) => {
    expect(parseXypResultCode(raw)).toBeUndefined();
  });
});
