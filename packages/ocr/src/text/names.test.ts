import { describe, expect, it } from 'vitest';
import { NAMES_MATCH_DEFAULTS, namesMatch } from './names';

describe('namesMatch: matches', () => {
  it.each([
    ['Болд', 'Болд'],
    ['Батаа Болд', 'Болд Батаа'], // овог/нэр солигдсон
    ['Bold Bataa', 'Болд Батаа'], // латин ↔ кирилл
    ['БОЛД БАТАА', 'bold bataa'],
    ['Б.Болд', 'Болд Батаа'], // овгийн эхний үсэг
    ['Б. Болд', 'Батаа Болд'],
    ['Болд Б.', 'Батаа Болд'],
    ['Bataa B.', 'Б.Болд'.replace('Б.Болд', 'Bold Bataa')],
    ['Бат-Эрдэнэ', 'Бат Эрдэнэ'],
    ['Бат-Эрдэнэ Дорж', 'Батэрдэнэ Дорж'],
    ['Батэрдэнэ Дорж', 'Дорж Бат-Эрдэнэ'],
    ['Дорж Bat-Erdene', 'Dorj Бат-Эрдэнэ'],
    ['Бат\u{2011}Эрдэнэ', 'Бат Эрдэнэ'], // non-breaking hyphen
    ['Ганзориг Баатар', 'Ganzorig Batar'],
    ['Цэцэг Ц.', 'Цэцэг Цогт'],
    ['  Болд   Батаа  ', 'болд батаа'],
    ['Болд, Батаа', 'Батаа Болд'],
    ["Ts'agaan Bold", 'Цагаан Болд'],
    ['Болд 2', 'Болд'], // тоо бүхий үгийг хэрэгсэхгүй
    ['Мөнхбаяр Дорж', 'Мөнхбаяп Дорж'], // OCR-ийн 1 тэмдэгтийн алдаа
  ])('%j ~ %j', (a, b) => {
    const r = namesMatch(a, b);
    expect(r.match, `${a} ~ ${b} (${r.score})`).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(NAMES_MATCH_DEFAULTS.minScore);
    expect(r.score).toBeLessThanOrEqual(1);
  });

  it('gives exact full names the maximum score and initial-abbreviated names less', () => {
    expect(namesMatch('Болд Батаа', 'Батаа Болд').score).toBe(1);
    expect(namesMatch('Bold Bataa', 'Болд Батаа').score).toBe(1);
    const abbreviated = namesMatch('Б.Болд', 'Болд Батаа');
    expect(abbreviated.match).toBe(true);
    expect(abbreviated.score).toBeGreaterThan(0.9);
    expect(abbreviated.score).toBeLessThan(1);
  });
});

describe('namesMatch: non-matches', () => {
  it.each([
    ['Бат Дорж', 'Бат Ганаа'], // нэг л үг ижил
    ['Д.Болд', 'Б.Болд'], // овгийн эхний үсэг зөрсөн
    ['Болд Батаа', 'Болд Дорж'],
    ['Бат', 'Бад'], // богино үгэнд засвар зөвшөөрөхгүй
    ['Болд', 'Болт'],
    ['Бат Дорж', 'Болд Ганаа'],
    ['Болд', 'Болд Батаа'], // нэг үг дутуу
    ['Бат Бат', 'Бат'],
    ['Батын Болд', 'Бат Болд'], // генитив тооцохгүй (мэдэгдэж буй хязгаарлалт)
    ['Мөнх', 'Мөнхбаяр'],
  ])('%j !~ %j', (a, b) => {
    const r = namesMatch(a, b);
    expect(r.match, `${a} !~ ${b} (${r.score})`).toBe(false);
  });

  it('never matches on initials alone, however high the score', () => {
    const r = namesMatch('Б.Д', 'Б.Д');
    expect(r.score).toBe(1);
    expect(r.match).toBe(false);
    expect(namesMatch('Б.Д', 'Бат Дорж').match).toBe(false);
    expect(namesMatch('Б', 'Бат').match).toBe(false);
  });

  it('scores a conflicting initial lower than a missing one', () => {
    const conflict = namesMatch('Д.Болд', 'Б.Болд');
    const missing = namesMatch('Болд', 'Б.Болд');
    expect(conflict.score).toBeLessThan(missing.score);
    expect(conflict.match).toBe(false);
    expect(missing.match).toBe(true);
  });

  it('handles tokens too long for edit distance (exact only)', () => {
    const long = 'бг'.repeat(NAMES_MATCH_DEFAULTS.maxFuzzyTokenLength / 2 + 1); // давхар үсэггүй → түлхүүр нь 34 тэмдэгт
    expect(namesMatch(`${long}х`, `${long}ш`)).toEqual({ match: false, score: 0 }); // богино бол 1 засвартай таарна
    expect(namesMatch('бгбгбгбгбгх', 'бгбгбгбгбгш').match).toBe(true);
    expect(namesMatch(`${long}х`, `${long}х`)).toEqual({ match: true, score: 1 });
  });
});

describe('namesMatch: minScore option', () => {
  it('lets the caller tighten or loosen the threshold', () => {
    expect(namesMatch('Болд', 'Б.Болд').match).toBe(true); // 0.8
    expect(namesMatch('Болд', 'Б.Болд', { minScore: 0.95 })).toEqual({ match: false, score: 0.8 });
    expect(namesMatch('Болд', 'Болд Батаа').match).toBe(false); // 0.667
    expect(namesMatch('Болд', 'Болд Батаа', { minScore: 0.6 })).toEqual({ match: true, score: 0.667 });
    expect(namesMatch('Болд Батаа', 'Болд Батаа', { minScore: 1 })).toEqual({ match: true, score: 1 });
    expect(namesMatch('Бат', 'Дорж', { minScore: 0 })).toEqual({ match: false, score: 0 }); // бүтэн үг таараагүй
  });
});

describe('namesMatch: properties', () => {
  const names = ['Болд Батаа', 'Б.Болд', 'Бат-Эрдэнэ Дорж', 'Dorj Bat Erdene', 'Мөнхбаяр', 'Мөнхбаяп Д.', 'Ц. Цэцэг', 'Tseveen', 'Болд'];

  it('is symmetric, bounded and reflexive', () => {
    for (const a of names) {
      for (const b of names) {
        const ab = namesMatch(a, b);
        const ba = namesMatch(b, a);
        expect(ab.score, `${a} | ${b}`).toBe(ba.score);
        expect(ab.match, `${a} | ${b}`).toBe(ba.match);
        expect(ab.score).toBeGreaterThanOrEqual(0);
        expect(ab.score).toBeLessThanOrEqual(1);
      }
      expect(namesMatch(a, a).score).toBe(1);
    }
  });

  it('is order-insensitive', () => {
    expect(namesMatch('Бат Дорж Ганаа', 'Ганаа Бат Дорж')).toEqual({ match: true, score: 1 });
    expect(namesMatch('Дорж Ганаа Бат', 'Бат Ганаа Дорж')).toEqual({ match: true, score: 1 });
  });
});

describe('namesMatch: empty and adversarial input', () => {
  it.each([
    ['', ''],
    ['', 'Болд'],
    ['Болд', ''],
    ['   ', 'Болд'],
    ['...', '---'],
    ['123', '123'],
    ['ь', 'ъ'], // түлхүүр нь хоосон болох үг
  ])('%j vs %j is never a match', (a, b) => {
    expect(namesMatch(a, b)).toEqual({ match: false, score: 0 });
  });

  it('rejects non-strings', () => {
    expect(namesMatch(undefined as unknown as string, 'Болд')).toEqual({ match: false, score: 0 });
    expect(namesMatch('Болд', null as unknown as string)).toEqual({ match: false, score: 0 });
  });

  it('refuses over-long input without doing quadratic work', () => {
    const started = performance.now();
    const huge = 'Болд '.repeat(20_000);
    expect(namesMatch(huge, huge)).toEqual({ match: false, score: 0 });
    expect(namesMatch('а'.repeat(NAMES_MATCH_DEFAULTS.maxInputLength + 1), 'а')).toEqual({ match: false, score: 0 });
    expect(namesMatch('Б'.repeat(100_000), 'Болд')).toEqual({ match: false, score: 0 });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('is fast at the maximum accepted length', () => {
    const a = Array.from({ length: 100 }, (_, i) => String.fromCharCode(0x430 + (i % 30))).join(' ');
    const b = [...a].reverse().join('');
    const started = performance.now();
    namesMatch(a.slice(0, NAMES_MATCH_DEFAULTS.maxInputLength), b.slice(0, NAMES_MATCH_DEFAULTS.maxInputLength));
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
