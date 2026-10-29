import { describe, expect, it } from 'vitest';
import { sanitizeCorrelationId } from './correlation';

describe('sanitizeCorrelationId', () => {
  it('зөв хэлбэрийг хэвээр буцаана', () => {
    expect(sanitizeCorrelationId('req-123.abc_DEF:7')).toBe('req-123.abc_DEF:7');
    expect(sanitizeCorrelationId('a'.repeat(64))).toBe('a'.repeat(64));
  });

  it('массив толгойн эхний утгыг авна', () => {
    expect(sanitizeCorrelationId(['abc', 'def'])).toBe('abc');
  });

  it.each([
    ['хэт урт', 'a'.repeat(65)],
    ['хоосон', ''],
    ['шинэ мөр (log injection)', 'abc\n{"event":"fake"}'],
    ['зай', 'a b'],
    ['Кирилл', 'дугаар1'],
    ['тоо', 5],
    ['undefined', undefined],
    ['null', null],
    ['хоосон массив', []],
  ])('%s -> undefined', (_name, value) => {
    expect(sanitizeCorrelationId(value)).toBeUndefined();
  });
});
