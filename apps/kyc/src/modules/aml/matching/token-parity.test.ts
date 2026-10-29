// @los/contracts nameTokenCount (zod хязгаар) ба нэр нормчлолын токенчлол (normalize.ts SEPARATORS) нь ТУСАД хэрэгжсэн хоёр хуваалт.
// Хязгаарын тоо нь engine-ийн токеноос хэзээ ч бага байж болохгүй (DoS хязгаар алдагдана): энд хоёрыг тулгана (review [37]).
import { describe, expect, it } from 'vitest';
import { nameTokenCount } from '@los/contracts';
import { normalizeEntityName } from './legal-forms';
import { normalizeName, tokenize } from './normalize';

const engineTokens = (name: string): number => tokenize(normalizeName(name)).length;

describe('word counting: contracts nameTokenCount vs matching tokenizer', () => {
  const separators = [' ', '\t', '\n', '\r', ' ', ' ', '　', '-', '_', '.', ',', '/', '\\', '‐', '–', '—', '−'.replace('−', '﹘'), '，', '．'];

  it.each(separators.map((sep) => [JSON.stringify(sep), sep]))('splits "a%s b" into two words in both', (_label, sep) => {
    const name = `Bat${sep}Erdene`;
    expect(nameTokenCount(name)).toBe(2);
    expect(engineTokens(name)).toBe(2);
  });

  it('counts the same for every separator at once', () => {
    const name = ['A', ...separators.map((sep, i) => `${sep}W${i}`)].join('');
    expect(engineTokens(name)).toBe(nameTokenCount(name));
    expect(nameTokenCount(name)).toBe(separators.length + 1);
  });

  it('does not split on apostrophes, quotes and other punctuation in either', () => {
    for (const name of ["O'Brien", 'D’Souza', 'Bat@Erdene', 'Bat*Erdene', 'Ganbold (Bat)', 'Bat#1', 'Abd"Ali']) {
      expect(engineTokens(name), name).toBe(nameTokenCount(name));
    }
  });

  it('never counts fewer words than the engine tokenizes, for any single character in the middle of a name', () => {
    const violations: string[] = [];
    for (let cp = 0; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      for (const name of [`a${ch}b`, `a ${ch} b`, `${ch}${ch}`]) {
        if (engineTokens(name) > nameTokenCount(name)) violations.push(`U+${cp.toString(16)}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps the invariant after NFKC expansion (U+FDFA is four words in both) and for entity names', () => {
    expect(nameTokenCount('ﷺ')).toBe(4);
    expect(engineTokens('ﷺ')).toBe(4);
    // хуулийн хэлбэрийн цэгийг залгах нь токены тоог зөвхөн бууруулна
    for (const name of ['Al Noor Trading L.L.C.', 'Алтан Х. Х. К.', 'ООО Ромашка']) {
      expect(tokenize(normalizeName(normalizeEntityName(name))).length, name).toBeLessThanOrEqual(nameTokenCount(name));
    }
  });
});
