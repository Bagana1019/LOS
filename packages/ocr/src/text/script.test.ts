import { describe, expect, it } from 'vitest';
import {
  cyrillicToLatin,
  foldCyrillicLookalikesToLatin,
  foldLatinLookalikesToCyrillic,
  normalizeWhitespace,
  resolveMixedScriptWords,
  transliterateLowerCyrillic,
} from './script';

describe('normalizeWhitespace', () => {
  it.each([
    ['', ''],
    ['   ', ''],
    ['a', 'a'],
    ['  a   b  ', 'a b'],
    ['a\tb\nc\r\nd\fe\vf', 'a b c d e f'],
    ['a\u{A0}b\u{202F}c\u{2009}d\u{3000}e\u{2028}f', 'a b c d e f'],
    ['a\u{200B}b', 'ab'],
    ['\u{FEFF}  a\u{AD}b  ', 'ab'],
    ['цалин   төлбөр', 'цалин төлбөр'],
  ])('%j -> %j', (input, expected) => {
    expect(normalizeWhitespace(input)).toBe(expected);
  });

  it('is idempotent', () => {
    const once = normalizeWhitespace(' \u{A0}a \n\n b\u{200B} ');
    expect(normalizeWhitespace(once)).toBe(once);
  });
});

describe('cyrillicToLatin', () => {
  it.each([
    ['Цалин', 'Tsalin'],
    ['ЦАЛИН', 'TSALIN'],
    ['цалин', 'tsalin'],
    ['Шагдар', 'Shagdar'],
    ['ШАГДАР', 'SHAGDAR'],
    ['Чимэг', 'Chimeg'],
    ['Юмжав', 'Yumjav'],
    ['Яруу', 'Yaruu'],
    ['Ёндон', 'Ondon'],
    ['Өлзий', 'Olzii'],
    ['Үүрцайх', 'Uurtsaih'],
    ['Ц', 'Ts'],
    ['ЦаЛиН', 'TsaLiN'],
    ['ъь', ''],
    ['Хаан Банк 2026', 'Haan Bank 2026'],
    ['Ulaanbaatar Улаанбаатар', 'Ulaanbaatar Ulaanbaatar'],
    ['', ''],
  ])('%j -> %j', (input, expected) => {
    expect(cyrillicToLatin(input)).toBe(expected);
  });

  it('composes decomposed й / ё and leaves unmapped cyrillic as is', () => {
    expect(cyrillicToLatin('и\u{306}')).toBe('i');
    expect(cyrillicToLatin('е\u{308}')).toBe('o');
    expect(cyrillicToLatin('\u{500}')).toBe('\u{500}');
  });
});

describe('foldLatinLookalikesToCyrillic', () => {
  it('folds the specified upper and lower case look-alikes', () => {
    expect(foldLatinLookalikesToCyrillic('ABCEHKMOPTXY')).toBe('АВСЕНКМОРТХУ');
    expect(foldLatinLookalikesToCyrillic('acepxoy')).toBe('асерхоу');
  });

  it('leaves other characters untouched and is idempotent', () => {
    const s = 'bdfghijklmnqrstuvwz 0123 Цалин.-/';
    expect(foldLatinLookalikesToCyrillic(s)).toBe(s);
    const once = foldLatinLookalikesToCyrillic('УБ 12 AB cp');
    expect(foldLatinLookalikesToCyrillic(once)).toBe(once);
    expect(foldLatinLookalikesToCyrillic('')).toBe('');
  });

  it('turns a register-like label with latin look-alikes into pure cyrillic', () => {
    expect(foldLatinLookalikesToCyrillic('PД')).toBe('РД');
    expect(foldLatinLookalikesToCyrillic('Y\u{411}')).toBe('УБ');
  });
});

describe('foldCyrillicLookalikesToLatin', () => {
  it('is the inverse direction', () => {
    expect(foldCyrillicLookalikesToLatin('АВСЕНКМОРТХУ')).toBe('ABCEHKMOPTXY');
    expect(foldCyrillicLookalikesToLatin('асерхоу')).toBe('acepxoy');
    expect(foldCyrillicLookalikesToLatin('Бат')).toBe('Бaт'); // т (жижиг) look-alike биш
  });
});

describe('resolveMixedScriptWords', () => {
  it('folds latin look-alikes inside cyrillic-dominant words', () => {
    expect(resolveMixedScriptWords('цaлин')).toBe('цалин'); // латин a
    expect(resolveMixedScriptWords('ЦAЛИН')).toBe('ЦАЛИН');
    expect(resolveMixedScriptWords('Bат')).toBe('Ват'); // B → В (хүснэгтийн дагуу)
  });

  it('folds cyrillic look-alikes inside latin-dominant words', () => {
    expect(resolveMixedScriptWords('Salаry')).toBe('Salary'); // кирилл а
    expect(resolveMixedScriptWords('\u{420}aym\u{435}nt')).toBe('Payment'); // кирилл Р, е
  });

  it('prefers cyrillic on a tie and leaves pure words and non-words alone', () => {
    expect(resolveMixedScriptWords('аa')).toBe('аа');
    expect(resolveMixedScriptWords('Yellow Цалин 12 ABC')).toBe('Yellow Цалин 12 ABC');
    expect(resolveMixedScriptWords('cаsh цaлин')).toBe('cash цалин');
    expect(resolveMixedScriptWords('')).toBe('');
  });

  it('treats digits as part of the word and ignores non-latin/cyrillic scripts', () => {
    expect(resolveMixedScriptWords('A1Б')).toBe('А1Б');
    expect(resolveMixedScriptWords('漢字A')).toBe('漢字A');
  });
});

describe('transliterateLowerCyrillic', () => {
  it('maps lowercase cyrillic and drops letters outside the table', () => {
    expect(transliterateLowerCyrillic('цалин')).toBe('tsalin');
    expect(transliterateLowerCyrillic('a\u{501}b')).toBe('ab');
    expect(transliterateLowerCyrillic('сь')).toBe('s');
    expect(transliterateLowerCyrillic('abc 123')).toBe('abc 123');
  });
});
