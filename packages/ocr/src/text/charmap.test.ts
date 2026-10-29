import { describe, expect, it } from 'vitest';
import {
  APOSTROPHE_CHARS_RE,
  CYRILLIC_TO_LATIN,
  CYRILLIC_TO_LATIN_LOOKALIKE,
  INVISIBLE_CHARS_RE,
  LATIN_FOLD_RULES,
  LATIN_TO_CYRILLIC_LOOKALIKE,
} from './charmap';

describe('CYRILLIC_TO_LATIN (match-key mapping table)', () => {
  it('covers the whole Russian alphabet plus Mongolian ө, ү', () => {
    const letters = 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя' + 'өү';
    for (const ch of letters) expect(CYRILLIC_TO_LATIN, `missing ${ch}`).toHaveProperty(ch);
  });

  it.each([
    ['ц', 'ts'], ['ч', 'ch'], ['ш', 'sh'], ['ж', 'j'], ['х', 'h'], ['ө', 'o'], ['ү', 'u'], ['у', 'u'], ['е', 'e'], ['ё', 'o'],
    ['ю', 'yu'], ['я', 'ya'], ['э', 'e'], ['ы', 'i'], ['ъ', ''], ['ь', ''], ['й', 'i'], ['щ', 'sh'], ['в', 'v'], ['о', 'o'],
  ])('maps %s -> "%s"', (cyr, latin) => {
    expect(CYRILLIC_TO_LATIN[cyr]).toBe(latin);
  });

  it('produces only lowercase latin skeleton letters (or empty)', () => {
    for (const [cyr, latin] of Object.entries(CYRILLIC_TO_LATIN)) {
      expect(cyr).toBe(cyr.toLowerCase());
      expect(latin).toMatch(/^[a-z]*$/);
    }
  });
});

describe('look-alike tables', () => {
  it('has exactly the specified latin letters', () => {
    expect(Object.keys(LATIN_TO_CYRILLIC_LOOKALIKE).sort().join('')).toBe('ABCEHKMOPTXYacepoxy'.split('').sort().join(''));
  });

  it('maps to cyrillic letters and the reverse table is its inverse', () => {
    for (const [latin, cyr] of Object.entries(LATIN_TO_CYRILLIC_LOOKALIKE)) {
      expect(cyr).toMatch(/^[\u{400}-\u{4FF}]$/u);
      expect(CYRILLIC_TO_LATIN_LOOKALIKE[cyr]).toBe(latin);
    }
    expect(Object.keys(CYRILLIC_TO_LATIN_LOOKALIKE)).toHaveLength(Object.keys(LATIN_TO_CYRILLIC_LOOKALIKE).length);
  });

  it('uppercase-only look-alikes stay uppercase-only (B, H, K, M, T)', () => {
    for (const ch of ['b', 'h', 'k', 'm', 't', 'n', 'i']) expect(LATIN_TO_CYRILLIC_LOOKALIKE).not.toHaveProperty(ch);
  });
});

describe('LATIN_FOLD_RULES', () => {
  it('are all global regexes (safe with String.replace) and fold example variants', () => {
    for (const [re] of LATIN_FOLD_RULES) expect(re.global).toBe(true);
    const fold = (s: string) => LATIN_FOLD_RULES.reduce((acc, [re, to]) => acc.replace(re, to), s);
    expect(fold('khan')).toBe('han');
    expect(fold('xaan')).toBe('han');
    expect(fold('zhargal')).toBe('jargal');
    expect(fold('wang')).toBe('vang');
    expect(fold('chimeg')).toBe('chimeg'); // ch хамгаалагдана
    expect(fold('capitron')).toBe('kapitron'); // нугарамтгай c = к
    expect(fold('black')).toBe('blak');
    expect(fold('club')).toBe('klub');
    expect(fold('xac')).toBe('has'); // төгсгөлийн c = с
    expect(fold('xacbank')).toBe('hasbank');
    expect(fold('citi')).toBe('siti'); // зөөлөн c = с
    expect(fold('cyber')).toBe('siber');
    expect(fold('cxan')).toBe('chan'); // x→h бол ch хэвээр
    expect(fold('yondon')).toBe('ondon');
    expect(fold('yeruu')).toBe('eru');
    expect(fold('tuya')).toBe('tuya'); // ya хэвээр
    expect(fold('sain')).toBe('sain');
    expect(fold('sayn')).toBe('sain');
  });
});

describe('invisible / apostrophe patterns', () => {
  it('match zero-width, soft hyphen, BOM and apostrophe variants', () => {
    const invisible = ['\u{AD}', '\u{200B}', '\u{200C}', '\u{200D}', '\u{2060}', '\u{FEFF}'];
    expect(invisible.join('a').replace(INVISIBLE_CHARS_RE, '')).toBe('aaaaa');
    expect(["'", '\u{2018}', '\u{2019}', '\u{2BC}', '`', '\u{B4}'].join('a').replace(APOSTROPHE_CHARS_RE, '')).toBe('aaaaa');
  });
});
