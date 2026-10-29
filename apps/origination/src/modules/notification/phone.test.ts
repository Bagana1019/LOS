import { describe, expect, it } from 'vitest';
import { normalizeEmail, normalizeMnPhone } from './phone';

describe('normalizeMnPhone (FR-13.2)', () => {
  it.each([
    ['99112233', '+97699112233'],
    ['9911-2233', '+97699112233'],
    ['9911 2233', '+97699112233'],
    [' 99.11.22.33 ', '+97699112233'],
    ['+97699112233', '+97699112233'],
    ['+976 9911 2233', '+97699112233'],
    ['976 99112233', '+97699112233'],
    ['97699112233', '+97699112233'],
    ['00976-99112233', '+97699112233'],
    ['(976) 8811-2233', '+97688112233'],
    ['85112233', '+97685112233'],
    ['75112233', '+97675112233'],
  ])('%s → %s', (raw, expected) => expect(normalizeMnPhone(raw)).toBe(expected));

  it.each([
    [null], [undefined], [''], ['   '],
    ['1234567'], // 7 орон
    ['991122334'], // 9 орон
    ['11112233'], // 1-ээр эхэлсэн (суурин утас — SMS хүрэхгүй)
    ['09112233'], ['abcd1234'], ['+85212345678'], ['+99112233'], ['0099112233'], ['+97611223344'], ['9911 22 3x'],
  ])('буруу: %s → null', (raw) => expect(normalizeMnPhone(raw as string | null | undefined)).toBeNull());
});

describe('normalizeEmail', () => {
  it('зөв хаягийг trim хийж буцаана', () => expect(normalizeEmail('  bold@example.mn ')).toBe('bold@example.mn'));
  it.each([[null], [''], ['bold'], ['bold@'], ['@example.mn'], ['bold@example'], ['bo ld@example.mn'], ['a@b.c']])('буруу: %s', (raw) => expect(normalizeEmail(raw as string | null)).toBeNull());
  it('254-өөс урт буруу', () => expect(normalizeEmail(`${'a'.repeat(250)}@example.mn`)).toBeNull());
});
