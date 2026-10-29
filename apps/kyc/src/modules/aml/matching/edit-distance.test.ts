import { describe, expect, it } from 'vitest';
import { boundedLevenshtein, editSimilarity } from './edit-distance';

// Жишиг хэрэгжилт: бүрэн матрицтай Levenshtein
function reference(a: readonly string[], b: readonly string[]): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}
const chars = (s: string) => [...s];

describe('boundedLevenshtein', () => {
  it('returns the exact distance when it is within the limit', () => {
    expect(boundedLevenshtein(chars('kitten'), chars('sitting'), 3)).toBe(3);
    expect(boundedLevenshtein(chars('abc'), chars('abc'), 0)).toBe(0);
    expect(boundedLevenshtein(chars('baterdene'), chars('batyerdene'), 1)).toBe(1);
  });

  it('returns null when the distance exceeds the limit', () => {
    expect(boundedLevenshtein(chars('kitten'), chars('sitting'), 2)).toBeNull();
    expect(boundedLevenshtein(chars('abc'), chars('abcdefgh'), 4)).toBeNull();
    expect(boundedLevenshtein(chars('abc'), chars('xyz'), 2)).toBeNull();
  });

  it('agrees with the full-matrix reference on random strings for every limit', () => {
    let seed = 5;
    const next = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
    const random = (len: number, alphabet: string) => chars(Array.from({ length: len }, () => alphabet[next(alphabet.length)]).join(''));
    for (let i = 0; i < 1500; i++) {
      const alphabet = ['ab', 'abc', 'abcdefgh'][next(3)];
      const a = random(next(14), alphabet);
      const b = random(next(14), alphabet);
      const exact = reference(a, b);
      for (const limit of [0, 1, 2, 3, 5, 20]) {
        const got = boundedLevenshtein(a, b, limit);
        expect(got, `${a.join('')} / ${b.join('')} limit ${limit}`).toBe(exact <= limit ? exact : null);
      }
    }
  });

  it('handles empty strings', () => {
    expect(boundedLevenshtein([], chars('ab'), 2)).toBe(2);
    expect(boundedLevenshtein([], chars('abc'), 2)).toBeNull();
    expect(boundedLevenshtein([], [], 0)).toBe(0);
  });
});

describe('editSimilarity', () => {
  it('is 1 - distance / length, symmetric', () => {
    expect(editSimilarity(chars('abcdefghij'), chars('abcdefghix'), 0.8)).toBeCloseTo(0.9, 10);
    expect(editSimilarity(chars('abcdefghix'), chars('abcdefghij'), 0.8)).toBeCloseTo(0.9, 10);
    expect(editSimilarity(chars('abc'), chars('abc'), 0.8)).toBe(1);
  });

  it('is 0 below the floor, and keeps the exact floor (1 - 2/10 = 0.8)', () => {
    expect(editSimilarity(chars('abcdefghij'), chars('abcdefghxy'), 0.8)).toBeCloseTo(0.8, 10);
    expect(editSimilarity(chars('abcdefghij'), chars('abcdefgxyz'), 0.8)).toBe(0);
    expect(editSimilarity([], [], 0.8)).toBe(0);
  });

  it('does not compare strings whose lengths already differ by more than the budget', () => {
    expect(editSimilarity(chars('baterdene'), chars('baterdeneganbold'), 0.8)).toBe(0);
  });

  // review [35]: бүх тестэд урт нь тэнцүү байсан тул хуваагчийг min(...) болговол мөн л ногоон байсан
  it('divides by the LONGER string when the lengths differ (1 - 1/10, not 1 - 1/9)', () => {
    expect(editSimilarity(chars('abcdefghij'), chars('abcdefghi'), 0.8)).toBeCloseTo(0.9, 10);
    expect(editSimilarity(chars('abcdefghi'), chars('abcdefghij'), 0.8)).toBeCloseTo(0.9, 10);
    expect(editSimilarity(chars('abcdefghi'), chars('abcdefghij'), 0.8)).not.toBeCloseTo(1 - 1 / 9, 3);
    // 5 ба 4 үсэг: 1 - 1/5 = 0.8 яг босго; хуваагч 4 бол 0.75 болж унана
    expect(editSimilarity(chars('abcde'), chars('abcd'), 0.8)).toBeCloseTo(0.8, 10);
  });

  it('maxDistance is a hard cap below the floor budget', () => {
    // floor 0.8 нь 10 үсэгт 2 засвар зөвшөөрнө
    expect(editSimilarity(chars('abcdefghij'), chars('abcdefghxy'), 0.8)).toBeCloseTo(0.8, 10);
    expect(editSimilarity(chars('abcdefghij'), chars('abcdefghxy'), 0.8, 1)).toBe(0);
    expect(editSimilarity(chars('abcdefghij'), chars('abcdefghix'), 0.8, 1)).toBeCloseTo(0.9, 10);
    expect(editSimilarity(chars('abcdefghij'), chars('abcdefghij'), 0.8, 0)).toBe(1);
    expect(editSimilarity(chars('abcdefghij'), chars('abcdefghix'), 0.8, 0)).toBe(0);
    // maxDistance нь floor-ийн хязгаарыг сулруулахгүй
    expect(editSimilarity(chars('abcd'), chars('abcx'), 0.8, 5)).toBe(0);
  });
});
