import { describe, expect, it } from 'vitest';
import { mn } from '@los/ui';
import {
  COMMENT_MAX,
  COMMENT_MIN,
  EXPIRES_MAX,
  EXPIRES_MIN,
  isValidExpiresInHours,
  textErrorMessage,
  validateText,
} from './validation';

describe('limits mirror @los/contracts', () => {
  it('has the documented values', () => {
    expect(COMMENT_MIN).toBe(3);
    expect(COMMENT_MAX).toBe(2000);
    expect([EXPIRES_MIN, EXPIRES_MAX]).toEqual([1, 720]);
  });
});

describe('validateText (required, min 3)', () => {
  const rules = { required: true, min: COMMENT_MIN };
  it('rejects empty and whitespace-only text as required', () => {
    expect(validateText('', rules)).toBe('required');
    expect(validateText('   \n\t ', rules)).toBe('required');
  });
  it('measures the trimmed length', () => {
    expect(validateText('ab', rules)).toBe('too_short');
    expect(validateText('  ab  ', rules)).toBe('too_short');
    expect(validateText('abc', rules)).toBeNull();
    expect(validateText('  abc  ', rules)).toBeNull();
  });
  it('counts Mongolian Cyrillic letters as one character each', () => {
    expect(validateText('Үгүй', rules)).toBeNull();
    expect(validateText('Үү', rules)).toBe('too_short');
  });
  it('counts code points like the server: two emoji are 2 characters, not 4', () => {
    expect(validateText('😀😀', rules)).toBe('too_short');
    expect(validateText('😀😀😀', rules)).toBeNull();
  });
  it('enforces the maximum', () => {
    expect(validateText('a'.repeat(COMMENT_MAX), rules)).toBeNull();
    expect(validateText('a'.repeat(COMMENT_MAX + 1), rules)).toBe('too_long');
  });
});

describe('validateText (optional)', () => {
  const rules = { required: false };
  it('accepts empty text and short text', () => {
    expect(validateText('', rules)).toBeNull();
    expect(validateText('  ', rules)).toBeNull();
    expect(validateText('ok', rules)).toBeNull();
  });
  it('still enforces the maximum', () => {
    expect(validateText('a'.repeat(COMMENT_MAX + 1), rules)).toBe('too_long');
  });
  it('honours a custom max', () => {
    expect(validateText('abcd', { required: false, max: 3 })).toBe('too_long');
  });
});

describe('textErrorMessage', () => {
  it('returns Mongolian texts with the limits filled in', () => {
    expect(textErrorMessage('required')).toBe(mn['maker_checker.comment.required']);
    expect(textErrorMessage('too_short')).toBe('Дор хаяж 3 тэмдэгт оруулна уу');
    expect(textErrorMessage('too_short', { min: 5 })).toBe('Дор хаяж 5 тэмдэгт оруулна уу');
    expect(textErrorMessage('too_long')).toBe('Хамгийн ихдээ 2000 тэмдэгт оруулж болно');
    expect(textErrorMessage('too_long', { max: 10 })).toBe('Хамгийн ихдээ 10 тэмдэгт оруулж болно');
  });
});

describe('isValidExpiresInHours', () => {
  it('accepts integers 1..720', () => {
    for (const n of [1, 24, 720]) expect(isValidExpiresInHours(n)).toBe(true);
  });
  it('rejects out of range, fractional and non-numbers', () => {
    for (const n of [0, -1, 721, 1.5, Number.NaN, '24', null, undefined]) expect(isValidExpiresInHours(n)).toBe(false);
  });
});
