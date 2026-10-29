import { describe, expect, it } from 'vitest';
import { jaroWinkler, jaroWinklerCodePoints } from './jaro-winkler';

describe('jaroWinkler', () => {
  it('MARTHA / MARHTA = 0.9611', () => {
    expect(jaroWinkler('MARTHA', 'MARHTA')).toBeCloseTo(0.9611, 4);
  });

  it('DIXON / DICKSONX = 0.8133', () => {
    expect(jaroWinkler('DIXON', 'DICKSONX')).toBeCloseTo(0.8133, 4);
  });

  it('returns 1 for equal non-empty strings', () => {
    expect(jaroWinkler('bat', 'bat')).toBe(1);
    expect(jaroWinkler('x', 'x')).toBe(1);
  });

  it('returns 0 when either string is empty, even if both are', () => {
    expect(jaroWinkler('', 'bat')).toBe(0);
    expect(jaroWinkler('bat', '')).toBe(0);
    expect(jaroWinkler('', '')).toBe(0);
  });

  it('returns 0 for strings with no common characters', () => {
    expect(jaroWinkler('abc', 'xyz')).toBe(0);
  });

  it('does not boost when jaro is 0.7 or lower', () => {
    // jaro = (2/6 + 2/6 + 1) / 3 = 0.5556; the shared prefix "ab" must not raise it
    expect(jaroWinkler('abcdef', 'abxyzw')).toBeCloseTo(0.5556, 4);
  });

  it('boosts by the common prefix when jaro is above 0.7', () => {
    // jaro("ganbold","ganbat") = 0.7460 and prefix 4 -> 0.7460 + 4 * 0.1 * 0.2540 = 0.8476
    expect(jaroWinkler('ganbold', 'ganbat')).toBeCloseTo(0.8476, 4);
  });

  it('caps the prefix bonus at 4 characters', () => {
    // jaro = (6/7 + 6/7 + 1) / 3 = 0.9048; with cap 4 -> 0.9429 (an uncapped prefix of 6 would give 0.9714)
    expect(jaroWinkler('ABCDEFG', 'ABCDEFH')).toBeCloseTo(0.9429, 4);
  });

  it('is case sensitive (normalization is the caller\'s job)', () => {
    expect(jaroWinkler('Bat', 'bat')).toBeLessThan(1);
  });

  it('counts a surrogate pair as one character', () => {
    // 2 characters each, 1 match ("a") -> (1/2 + 1/2 + 1) / 3 = 0.6667; splitting the pairs would give 0.7778+
    expect(jaroWinkler('\u{20000}a', '\u{20001}a')).toBeCloseTo(0.6667, 4);
  });

  it('is symmetric and stays within [0, 1] over a table of pairs', () => {
    const words = ['martha', 'marhta', 'dixon', 'dicksonx', 'bat', 'bata', 'batu', 'ganbold', 'ganbat', 'a', 'ab', 'ba', 'aab', 'abb', 'erdene', 'erdenee', '88', 'x'];
    for (const a of words) {
      for (const b of words) {
        const score = jaroWinkler(a, b);
        expect(score, `${a}/${b}`).toBe(jaroWinkler(b, a));
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('jaroWinklerCodePoints', () => {
  it('gives the same score as jaroWinkler on the same strings, including astral characters', () => {
    for (const [a, b] of [['MARTHA', 'MARHTA'], ['DIXON', 'DICKSONX'], ['bat', 'bat'], ['b', 'bat'], ['a😀b', 'a😀c'], ['x', 'y']]) {
      expect(jaroWinklerCodePoints([...a], [...b]), `${a} / ${b}`).toBe(jaroWinkler(a, b));
    }
  });

  it('returns 0 for an empty array on either side', () => {
    expect(jaroWinklerCodePoints([], ['a'])).toBe(0);
    expect(jaroWinklerCodePoints(['a'], [])).toBe(0);
    expect(jaroWinklerCodePoints([], [])).toBe(0);
  });
});

// Жишиг хэрэгжилт: сурах бичгийн Jaro (match window = floor(max(|a|,|b|) / 2) − 1) ба Winkler (p = 0.1, prefix ≤ 4, jaro > 0.7)
function referenceJaroWinkler(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  const range = Math.max(Math.floor(Math.max(a.length, b.length) / 2) - 1, 0);
  const aMatched = new Set<number>();
  const bMatched = new Set<number>();
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j <= Math.min(b.length - 1, i + range); j++) {
      if (!bMatched.has(j) && a[i] === b[j]) {
        aMatched.add(i);
        bMatched.add(j);
        break;
      }
    }
  }
  const m = aMatched.size;
  if (m === 0) return 0;
  const aSeq = [...aMatched].sort((x, y) => x - y).map((i) => a[i]);
  const bSeq = [...bMatched].sort((x, y) => x - y).map((j) => b[j]);
  const t = aSeq.filter((ch, k) => ch !== bSeq[k]).length / 2;
  const jaro = (m / a.length + m / b.length + (m - t) / m) / 3;
  if (jaro <= 0.7) return jaro;
  let prefix = 0;
  while (prefix < 4 && prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

describe('jaroWinkler against a textbook implementation (review [35]: the match window is pinned)', () => {
  it('has the standard match window: a character exactly floor(max / 2) away does not match', () => {
    // |a| = |b| = 4 → window 1: 'a' at 0 and at 2 are 2 apart → no match
    expect(jaroWinkler('abcd', 'xbad')).toBeCloseTo(referenceJaroWinkler('abcd', 'xbad'), 12);
    expect(jaroWinkler('abxx', 'xxab')).toBe(referenceJaroWinkler('abxx', 'xxab'));
  });

  it('agrees with the reference on random strings over small alphabets, including unequal lengths', () => {
    let seed = 99;
    const next = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
    const random = (len: number, alphabet: string) => Array.from({ length: len }, () => alphabet[next(alphabet.length)]).join('');
    for (let i = 0; i < 4000; i++) {
      const alphabet = ['ab', 'abc', 'abcdef', 'abcdefghijklmnop'][next(4)];
      const a = random(1 + next(14), alphabet);
      const b = random(1 + next(14), alphabet);
      expect(jaroWinkler(a, b), `${a} / ${b}`).toBeCloseTo(referenceJaroWinkler(a, b), 12);
    }
  });
});

describe('jaroWinklerCodePoints with a floor (early abandon)', () => {
  it('returns the exact score whenever the exact score reaches the floor, and 0 or the exact score otherwise', () => {
    let seed = 17;
    const next = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
    const random = (len: number, alphabet: string) => [...Array.from({ length: len }, () => alphabet[next(alphabet.length)])];
    let abandoned = 0;
    let kept = 0;
    for (let i = 0; i < 6000; i++) {
      const alphabet = ['ab', 'abc', 'abcdef', 'abcdefghijklmnopqrstuvwxyz'][next(4)];
      const a = random(1 + next(14), alphabet);
      const b = random(1 + next(14), alphabet);
      const exact = jaroWinklerCodePoints(a, b);
      for (const floor of [0.5, 0.7, 0.8 - 1e-9, 0.85, 0.95]) {
        const got = jaroWinklerCodePoints(a, b, floor);
        if (exact >= floor) {
          expect(got, `${a.join('')} / ${b.join('')} floor ${floor}`).toBe(exact);
          kept++;
        } else {
          expect(got === 0 || got === exact, `${a.join('')} / ${b.join('')} floor ${floor}`).toBe(true);
          if (got === 0 && exact > 0) abandoned++;
        }
      }
    }
    expect(kept).toBeGreaterThan(500);
    expect(abandoned).toBeGreaterThan(500);
  });

  it('keeps the boundary pair JW("b", "bat") = 0.8 at floor 0.8 - 1e-9', () => {
    expect(jaroWinklerCodePoints(['b'], [...'bat'], 0.8 - 1e-9)).toBeCloseTo(0.8, 12);
    expect(jaroWinklerCodePoints(['b'], [...'batu'], 0.8 - 1e-9)).toBeLessThan(0.8 - 1e-9); // 0.775: 0 эсвэл яг утга, босгоос доор
  });

  it('reuses its scratch buffers across calls of different lengths', () => {
    const long = [...'abcdefghijklmnopqrstuvwxyz'.repeat(8)];
    expect(jaroWinklerCodePoints(long, long)).toBe(1);
    expect(jaroWinklerCodePoints([...'martha'], [...'marhta'])).toBeCloseTo(0.9611, 4);
    expect(jaroWinklerCodePoints(long, [...long.slice(0, 50)])).toBeGreaterThan(0.7);
    expect(jaroWinklerCodePoints([...'martha'], [...'marhta'])).toBeCloseTo(0.9611, 4);
  });
});
