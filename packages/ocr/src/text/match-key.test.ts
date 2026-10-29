import { describe, expect, it } from 'vitest';
import { cyrillicToLatin } from './script';
import { toMatchKey } from './match-key';

/** Тогтмол seed-тэй PRNG (mulberry32) — тест тодорхойлогдмол байх */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('toMatchKey: one key for cyrillic, latin and mixed spellings (NFR-9)', () => {
  it.each(['Цалин', 'ЦАЛИН', 'цалин', 'tsalin', 'Tsalin', 'TSALIN', 'цaлин' /* латин a */, 'ЦAЛИН', 'ц\u{430}лин'])(
    '%j -> tsalin',
    (word) => {
      expect(toMatchKey(word)).toBe('tsalin');
    },
  );

  it('matches the latin look-alike letter inside a cyrillic word (c, e, o, p, x, y, a)', () => {
    expect(toMatchKey('Xаaн')).toBe(toMatchKey('Хаан')); // латин X, a
    expect(toMatchKey('Cаpдaл')).toBe(toMatchKey('Сардал')); // латин C, p, a
    expect(toMatchKey('Оpдoc')).toBe(toMatchKey('Ордос')); // латин p, o, c
  });

  it.each([
    [['Хаан банк', 'Khan Bank', 'KHAAN BANK', 'Xaan bank', 'хаан  банк'], 'han bank'],
    [['Хас банк', 'Xac bank', 'Khas Bank'], 'has bank'],
    [['Капитрон банк', 'Capitron Bank', 'CAPITRON BANK'], 'kapitron bank'],
    [['Төрийн банк', 'Toriin bank', 'Torin Bank'], 'torin bank'],
    [['М банк', 'M Bank', 'm-bank'], 'm bank'],
    [['ТДБ', 'TDB', 'tdb'], 'tdb'],
    [['Голомт банк', 'Golomt Bank', 'ГОЛОМТ БАНК'], 'golomt bank'],
    [['Улаанбаатар', 'Ulaanbaatar', 'ULAANBAATAR', 'Ulanbatar'], 'ulanbatar'],
    [['Жаргал', 'Zhargal', 'Jargal', 'ЖАРГАЛ'], 'jargal'],
    [['Ванчиг', 'Wanchig', 'Vanchig'], 'vanchig'],
    [['Ёндон', 'Yondon', 'ЁНДОН'], 'ondon'],
    [['Баяр', 'Bayar', 'БАЯР'], 'bayar'],
    [['Нямдорж', 'Nyamdorj'], 'nyamdorj'],
    [['Туяа', 'Tuya', 'Tuyaa'], 'tuya'],
    [['Чингис', 'Chingis', 'ЧИНГИС'], 'chingis'],
    [['Шагдар', 'Shagdar'], 'shagdar'],
    [['Дорж', 'Dorj', 'DORJ'], 'dorj'],
    [['Өлзий', 'Olzii', 'Olzi'], 'olzi'],
    [['Үүрцайх', 'Uurtsaih', 'Urtsaih'], 'urtsaih'],
    [['Сайн', 'Sain', 'Sayn'], 'sain'],
    [['Зээлийн төлбөр', 'Zeeliin tolbor', 'zelin tolbor'], 'zelin tolbor'],
    [['Ерөнхий', 'Yeronkhii', 'Eronhi'], 'eronhi'],
  ])('%j share the key %j', (spellings, key) => {
    for (const s of spellings) expect(toMatchKey(s), s).toBe(key);
  });

  it('keeps unrelated words apart', () => {
    expect(toMatchKey('цалин')).not.toBe(toMatchKey('зээл'));
    expect(toMatchKey('Бат')).not.toBe(toMatchKey('Бад'));
    expect(toMatchKey('Дорж')).not.toBe(toMatchKey('Доржо'));
  });

  it('resolves latin-dominant words that contain a cyrillic look-alike', () => {
    expect(toMatchKey('Sal\u{430}ry')).toBe(toMatchKey('Salary')); // кирилл а
    expect(toMatchKey('c\u{430}sh')).toBe(toMatchKey('cash')); // латин-дийрэв: а → a, с хэвээр
  });
});

describe('toMatchKey: normalisation steps', () => {
  it('lowercases including Ө / Ү', () => {
    expect(toMatchKey('Ө')).toBe('o');
    expect(toMatchKey('Ү')).toBe('u');
    expect(toMatchKey('ӨВӨР')).toBe('ovor');
    expect(toMatchKey('ҮНЭ')).toBe('une');
  });

  it('strips diacritics but keeps й and ё semantics', () => {
    expect(toMatchKey('Müller')).toBe('muler');
    expect(toMatchKey('Café')).toBe('kafe');
    expect(toMatchKey('Öлзий')).toBe(toMatchKey('Өлзий')); // латин Ö + кирилл
    expect(toMatchKey('и\u{306}')).toBe('i'); // decomposed й
    expect(toMatchKey('е\u{308}')).toBe('o'); // decomposed ё
    expect(toMatchKey('İstanbul')).toBe('istanbul');
  });

  it('turns punctuation into single spaces and collapses whitespace', () => {
    expect(toMatchKey('Б.Болд')).toBe('b bold');
    expect(toMatchKey('  a_b-d,,e ;; f\t\n g  ')).toBe('a b d e f g');
    expect(toMatchKey('Дорж-Эрдэнэ')).toBe('dorj erdene');
    expect(toMatchKey('QPay: 12,000.00₮')).toBe('qpai 12 000 00'); // y (ya/yu-аас өмнө биш) = й/ы → i
  });

  it('removes apostrophes and invisible characters instead of splitting words', () => {
    expect(toMatchKey("O'Neil")).toBe('oneil');
    expect(toMatchKey('O\u{2019}Neil')).toBe('oneil');
    expect(toMatchKey('ца\u{200B}лин')).toBe('tsalin');
    expect(toMatchKey('\u{FEFF}ца\u{AD}лин')).toBe('tsalin');
    expect(toMatchKey("Ts'agaan")).toBe(toMatchKey('Tsagaan'));
  });

  it('applies NFKC (full-width, ligatures, NBSP)', () => {
    expect(toMatchKey('ＴＳＡＬＩＮ')).toBe('tsalin');
    expect(toMatchKey('ﬁle')).toBe('file');
    expect(toMatchKey('цалин\u{A0}төлбөр')).toBe('tsalin tolbor');
  });

  it('keeps digits (never collapses them) and mixes with letters', () => {
    expect(toMatchKey('Хаан 1000')).toBe('han 1000');
    expect(toMatchKey('A1B2')).toBe('a1b2');
    expect(toMatchKey('2026-03-10')).toBe('2026 03 10');
  });

  it('collapses doubled latin letters only', () => {
    expect(toMatchKey('aaa')).toBe('a');
    expect(toMatchKey('ааа')).toBe('a');
    expect(toMatchKey('1100')).toBe('1100');
  });

  it('handles ъ / ь, unknown cyrillic letters and empty input', () => {
    expect(toMatchKey('ъ ь')).toBe('');
    expect(toMatchKey('а ь б')).toBe('a b');
    expect(toMatchKey('\u{501}')).toBe(''); // хүснэгтэнд үгүй кирилл — хасна
    expect(toMatchKey('')).toBe('');
    expect(toMatchKey('   ')).toBe('');
    expect(toMatchKey('.,;!?')).toBe('');
    expect(toMatchKey('😀')).toBe('');
    expect(toMatchKey(undefined as unknown as string)).toBe('');
    expect(toMatchKey(null as unknown as string)).toBe('');
    expect(toMatchKey(42 as unknown as string)).toBe('');
  });

  it('passes other scripts through', () => {
    expect(toMatchKey('漢字 Цалин')).toBe('漢字 tsalin');
  });
});

describe('toMatchKey: properties', () => {
  const cyr = 'абвгдеёжзийклмнопрстуфхцчшщъыьэюяөү';
  const alphabet = [
    ...cyr,
    ...cyr.toUpperCase(),
    ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
    ...'0123456789',
    ...[' ', '  ', '-', '.', "'", '_', '\t', '\n', ',', '/'],
    '\u{200B}', '\u{301}', '\u{306}', '\u{308}', '\u{A0}', 'é', 'Ö', 'ü', 'ﬁ', '\u{500}', '漢', '😀', 'İ',
  ];

  it('is idempotent on 4000 pseudo-random mixed-script strings', () => {
    const rnd = prng(20261028);
    for (let n = 0; n < 4000; n++) {
      const len = 1 + Math.floor(rnd() * 14);
      let s = '';
      for (let i = 0; i < len; i++) s += alphabet[Math.floor(rnd() * alphabet.length)];
      const key = toMatchKey(s);
      expect(toMatchKey(key), JSON.stringify(s)).toBe(key);
      expect(key).not.toMatch(/^ | $| {2}/);
    }
  });

  it('is idempotent for every latin digraph interaction up to length 4', () => {
    const letters = 'kxzhcyeouaw'.split('');
    const walk = (prefix: string, depth: number): void => {
      if (depth === 0) {
        const key = toMatchKey(prefix);
        expect(toMatchKey(key), prefix).toBe(key);
        return;
      }
      for (const l of letters) walk(prefix + l, depth - 1);
    };
    for (let d = 1; d <= 4; d++) walk('', d);
  });

  it('gives the same key for a cyrillic word, its upper case and its transliteration', () => {
    const rnd = prng(7);
    const letters = [...cyr];
    for (let n = 0; n < 1500; n++) {
      const len = 1 + Math.floor(rnd() * 10);
      let w = '';
      for (let i = 0; i < len; i++) w += letters[Math.floor(rnd() * letters.length)];
      const key = toMatchKey(w);
      expect(toMatchKey(w.toUpperCase()), w).toBe(key);
      expect(toMatchKey(cyrillicToLatin(w)), w).toBe(key);
      expect(toMatchKey(cyrillicToLatin(w.toUpperCase())), w).toBe(key);
    }
  });
});

describe('toMatchKey: adversarial input stays linear (no catastrophic backtracking)', () => {
  const N = 100_000;
  const inputs: Array<[string, string]> = [
    ['k*N', 'k'.repeat(N)],
    ['k*N+h', 'k'.repeat(N - 1) + 'h'],
    ['y*N+e', 'y'.repeat(N - 1) + 'e'],
    ['c*N+h', 'c'.repeat(N - 1) + 'h'],
    ['(ab)*', 'ab'.repeat(N / 2)],
    ['Ц*N', 'Ц'.repeat(N)],
    ['"a " *', 'a '.repeat(N / 2)],
    ['punctuation', '-'.repeat(N)],
    ['zero-width', 'а\u{200B}'.repeat(N / 2)],
    ['mixed words', 'цa'.repeat(N / 2)],
    ['combining', 'e\u{301}'.repeat(N / 2)],
    ['xx', 'Xx'.repeat(N / 2)],
  ];

  it.each(inputs)('%s within the time budget', (_name, input) => {
    const started = performance.now();
    const key = toMatchKey(input);
    const elapsed = performance.now() - started;
    expect(key.length).toBeLessThanOrEqual(input.length * 2);
    expect(elapsed).toBeLessThan(3000);
  });

  it('is still idempotent on the long inputs', () => {
    const key = toMatchKey('k'.repeat(N - 1) + 'h' + 'Ц'.repeat(1000));
    expect(toMatchKey(key)).toBe(key);
  });
});
