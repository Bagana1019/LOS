import { describe, expect, it } from 'vitest';
import { blindIndex } from './crypto';
import { normalizeRegisterNo as contractsNormalize } from '@los/contracts';
import { foldRegisterNo, hashRegisterNo, maskRegisterNoStrict, normalizeRegisterNo, registerNoHashVariants } from './register-no';

// УБ, ХА: кирилл (латин дүртэй андуурахгүйн тулд look-alike хүснэгтийг код цэгээр бичнэ).
const UB = 'УБ';
const XA = 'ХА';
const cyrillicOnly = (s: string) => /^[\p{Script=Cyrillic}\d]+$/u.test(s);

describe('normalizeRegisterNo', () => {
  it('upper-cases Cyrillic letters', () => {
    expect(normalizeRegisterNo('уб12345678')).toBe(`${UB}12345678`);
  });

  it('strips spaces, dashes, dots and underscores', () => {
    expect(normalizeRegisterNo(` ${UB} 1234-5678 `)).toBe(`${UB}12345678`);
    expect(normalizeRegisterNo(`${UB}.1234_5678`)).toBe(`${UB}12345678`);
    expect(normalizeRegisterNo('\t12 34\n567')).toBe('1234567');
  });

  it('maps Latin look-alikes to Cyrillic, case-insensitively', () => {
    expect(normalizeRegisterNo('XA12345678')).toBe(`${XA}12345678`);
    expect(normalizeRegisterNo('xa 12345678')).toBe(`${XA}12345678`);
  });

  it.each([
    ['A', 0x410], ['B', 0x412], ['E', 0x415], ['K', 0x41a], ['M', 0x41c], ['H', 0x41d],
    ['O', 0x41e], ['P', 0x420], ['C', 0x421], ['T', 0x422], ['Y', 0x423], ['X', 0x425],
  ])('Latin %s becomes its Cyrillic look-alike', (latin, codePoint) => {
    const cyrillic = String.fromCodePoint(codePoint);
    expect(normalizeRegisterNo(latin)).toBe(cyrillic);
    expect(normalizeRegisterNo(latin.toLowerCase())).toBe(cyrillic);
    expect(cyrillicOnly(normalizeRegisterNo(`${latin}${latin}12345678`))).toBe(true);
  });

  it('leaves already-Cyrillic input untouched', () => {
    for (const v of [`${UB}12345678`, 'ЧА87654321', 'ӨЭ12345678']) {
      expect(normalizeRegisterNo(v)).toBe(v);
    }
  });

  // customer.registerNoHash = blindIndex(@los/contracts normalizeRegisterNo(r)); blacklist hash түүнтэй таарахгүй бол Модуль 1-ийн анхааруулга алдагдана.
  it('keeps Cyrillic Ү distinct, so valid registers hash exactly like @los/contracts normalizeRegisterNo', () => {
    for (const v of ['ҮБ12345678', 'ӨҮ12345678', 'УБ12345678', 'ЁЭ12345678', 'ЙА12345678', 'ЧА87654321', '1234567']) {
      expect(normalizeRegisterNo(v)).toBe(contractsNormalize(v));
      expect(hashRegisterNo(v)).toBe(blindIndex(contractsNormalize(v)));
    }
    expect(normalizeRegisterNo('YA12345678')).toBe('УА12345678');
    expect(normalizeRegisterNo('\u04afа12345678')).toBe('ҮА12345678');
  });

  it('leaves digits and Latin letters without a Cyrillic look-alike as they are (upper-cased)', () => {
    expect(normalizeRegisterNo('1234567')).toBe('1234567');
    expect(normalizeRegisterNo('z9')).toBe('Z9');
  });

  it('returns an empty string for empty or separator-only input', () => {
    expect(normalizeRegisterNo('')).toBe('');
    expect(normalizeRegisterNo(' - . _ ')).toBe('');
  });

  it('is idempotent', () => {
    for (const v of ['xa 12345678', `${UB}-12345678`, ' 1234567 ', 'YA.87654321', '']) {
      const once = normalizeRegisterNo(v);
      expect(normalizeRegisterNo(once)).toBe(once);
    }
  });
});

describe('normalizeRegisterNo: hidden and compatibility characters', () => {
  const canonical = `${XA}12345678`;

  // [7]/[16]/[29]: PDF/Word/CSV-ээс хуулсан регистр үл үзэгдэх тэмдэгттэй байхад hash, REGISTER_EXACT алдагддаг байсан
  it.each([
    ['zero-width space', `${XA}\u200b12345678`],
    ['zero-width joiner / non-joiner', `${XA}\u200d1234\u200c5678`],
    ['soft hyphen', `${XA}\u00ad12345678`],
    ['byte order mark', `\ufeff${XA}12345678`],
    ['LRM / RLM / bidi isolates', `\u200e${XA}\u200f12345678\u2066`],
    ['no-break space', `${XA}\u00a012345678`],
    ['ideographic and thin spaces', `${XA}\u3000\u200912345678`],
    ['line separator', `${XA}\u202812345678`],
    ['en dash / em dash / minus sign / non-breaking hyphen', `${XA}\u2013\u2014\u2212\u2011 12345678`],
    ['trailing slash, comma and semicolon', `${XA}12345678/,;`],
    ['parentheses and quotes', `(${XA}) "12345678"`],
    ['fullwidth Latin letters and digits', 'ＸＡ１２３４５６７８'],
    ['Arabic-Indic digits', `${XA}١٢٣٤٥٦٧٨`],
    ['extended Arabic-Indic digits', `${XA}۱۲۳۴۵۶۷۸`],
    ['Devanagari digits', `${XA}१२३४५६७८`],
    ['mathematical bold digits', `${XA}𝟏𝟐𝟑𝟒𝟓𝟔𝟕𝟖`],
    ['superscript-free circled digits', `${XA}①②③④⑤⑥⑦⑧`],
    ['combining marks on a letter that has no precomposed form', `Х\u0301А12345678`],
    ['modifier-letter apostrophe', `${XA}\u02bc12345678`],
    ['tag characters', `${XA}\u{e0041}12345678`],
  ])('treats %s as the same register', (_label, raw) => {
    expect(normalizeRegisterNo(raw)).toBe(canonical);
  });

  it('composes decomposed Й and Ё before marks are stripped (they stay Й / Ё, not И / Е)', () => {
    const decomposed = 'И\u0306Э87654321'; // Й + Э
    expect(normalizeRegisterNo(decomposed)).toBe('ЙЭ87654321');
    expect(normalizeRegisterNo('ЙЭ87654321'.normalize('NFD'))).toBe('ЙЭ87654321');
    expect(normalizeRegisterNo('Е\u0308Ю12345678')).toBe('ЁЮ12345678');
    expect(normalizeRegisterNo('йэ87654321'.normalize('NFD'))).toBe('ЙЭ87654321');
  });

  it('does not let a zero-width character between a letter and its combining mark break the composition', () => {
    expect(normalizeRegisterNo('И\u200b\u0306Э87654321')).toBe('ЙЭ87654321');
  });

  it('keeps only upper-case letters and ASCII digits in the output', () => {
    const out = normalizeRegisterNo(' ya-١٢٣/\u2011٤٥٦٧٨ ,\u200b ');
    expect(out).toMatch(/^[\p{Lu}0-9]+$/u);
    expect(out).toBe('УА12345678');
  });

  it('maps every decimal-digit system to the same ASCII digit value', () => {
    expect(normalizeRegisterNo('٠١٢٣٤٥٦٧٨٩')).toBe('0123456789');
    expect(normalizeRegisterNo('۰۱۲۳۴۵۶۷۸۹')).toBe('0123456789');
    expect(normalizeRegisterNo('०१२३४५६७८९')).toBe('0123456789');
    expect(normalizeRegisterNo('０１２３４５６７８９')).toBe('0123456789');
  });

  it('gives an equal HMAC for every variant (internal blacklist lookups no longer miss)', () => {
    const h = hashRegisterNo(canonical);
    for (const v of [`${XA}\u200b12345678`, 'ＸＡ１２３４５６７８', `${XA}١٢٣٤٥٦٧٨`, `${XA}\u201312345678`, `${XA}12345678/`]) {
      expect(hashRegisterNo(v)).toBe(h);
    }
  });

  it('can expand under NFKC but always stays idempotent (so a length limit has to be applied after normalising)', () => {
    expect(normalizeRegisterNo('\ufdfa').length).toBeGreaterThan(1);
    expect(normalizeRegisterNo(normalizeRegisterNo('\ufdfa'))).toBe(normalizeRegisterNo('\ufdfa'));
  });

  it('returns an empty string when nothing but invisible characters or punctuation remains', () => {
    expect(normalizeRegisterNo('\u200b\u200d\u00ad')).toBe('');
    expect(normalizeRegisterNo('--//,,..__')).toBe('');
    expect(normalizeRegisterNo('\u02bc\u0301')).toBe('');
  });

  it('is idempotent for every BMP code point and keeps the output alphabet closed', () => {
    for (let cp = 0; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      if (cp >= 0x3400 && cp <= 0x9fff && cp % 7 !== 0) continue; // CJK иероглиф: ердийн \p{Lo} үсэг, бүгдийг шалгах шаардлагагүй
      const s = `a${String.fromCodePoint(cp)}7`;
      const once = normalizeRegisterNo(s);
      expect(normalizeRegisterNo(once), `U+${cp.toString(16)}`).toBe(once);
      expect(once, `U+${cp.toString(16)}`).toMatch(/^[\p{L}0-9]*$/u);
    }
  });
});

describe('maskRegisterNoStrict', () => {
  it('shows only the last 3 characters of an individual register: "уб 12345678" -> "*******678"', () => {
    expect(maskRegisterNoStrict('уб 12345678')).toBe('*******678');
  });

  it('shows only the last 2 characters of a 7-digit legal entity register: "1234567" -> "*****67"', () => {
    expect(maskRegisterNoStrict('1234567')).toBe('*****67');
  });

  it('normalises before masking (Latin look-alikes, separators)', () => {
    expect(maskRegisterNoStrict('xa-12345678')).toBe('*******678');
    expect(maskRegisterNoStrict('123-4567')).toBe('*****67');
  });

  it.each([['', ''], ['1', '*'], ['12', '**'], ['123', '***'], ['1234', '****'], [`${UB}12`, '****'], ['12345', '*****'], ['123456', '******']])(
    'fully masks values of 6 characters or fewer: %j',
    (raw, masked) => {
      expect(maskRegisterNoStrict(raw)).toBe(masked);
    },
  );

  // [13]/[21]: 5-6 тэмдэгттэй (жнь гадаад паспорт) дугаарын угтвар + сүүл давхцаж бүгдийг ил гаргадаг байсан
  it.each(['AB1234', 'AB12345', 'A12345', 'A1234', 'AB123456'])('never exposes a short letter-prefixed id: %s', (raw) => {
    const norm = normalizeRegisterNo(raw);
    const masked = maskRegisterNoStrict(raw);
    expect(masked).toHaveLength(norm.length);
    expect(masked).not.toBe(norm);
    expect(masked).toContain('*');
    expect(masked.startsWith('*')).toBe(true);
  });

  it('reveals at most a third of the characters (and at most 4) for every length', () => {
    for (let n = 1; n <= 32; n++) {
      const raw = '1234567890'.repeat(4).slice(0, n);
      const masked = maskRegisterNoStrict(raw);
      const revealed = masked.replace(/\*/g, '').length;
      expect(masked, `n=${n}`).toHaveLength(n);
      expect(revealed, `n=${n}`).toBeLessThanOrEqual(Math.min(4, Math.floor(n / 3)));
      expect(masked, `n=${n}`).toContain('*');
      // ил гарсан хэсэг нь үнэхээр нормчилсон утгын сүүл
      expect(raw.endsWith(masked.replace(/\*/g, '')), `n=${n}`).toBe(true);
    }
  });

  it('shows 4 trailing characters only from 12 characters up', () => {
    expect(maskRegisterNoStrict('123456789012')).toBe('********9012');
    expect(maskRegisterNoStrict('12345678901')).toBe('********901');
    expect(maskRegisterNoStrict('1'.repeat(32))).toBe(`${'*'.repeat(28)}1111`);
  });

  it('never reveals the register series letters or the middle digits', () => {
    const individual = maskRegisterNoStrict(`${UB}12345678`);
    expect(individual).not.toContain(UB);
    expect(individual).not.toMatch(/1234|123|234|345|456|567/);
    expect(individual.slice(0, 7)).toBe('*******');
    const legal = maskRegisterNoStrict('7654321');
    expect(legal).not.toMatch(/765|654|543|432/);
    expect(legal.slice(0, 5)).toBe('*****');
  });

  it('masks the normalised form, so invisible characters do not shift what is shown', () => {
    expect(maskRegisterNoStrict(`${UB}\u200b1234\u200d5678`)).toBe('*******678');
  });
});

describe('hashRegisterNo', () => {
  it('returns 64 lower-case hex characters', () => {
    expect(hashRegisterNo(`${UB}12345678`)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    expect(hashRegisterNo(`${UB}12345678`)).toBe(hashRegisterNo(`${UB}12345678`));
  });

  it('is the platform blind index (crypto.ts) of the normalised register', () => {
    expect(hashRegisterNo('xa 12345678')).toBe(blindIndex(`${XA}12345678`));
  });

  it('is equal for equivalent spellings', () => {
    const h = hashRegisterNo(`${XA}12345678`);
    for (const v of ['XA12345678', 'xa 12345678', `${XA}-12345678`, ' x.a_12345678 ']) {
      expect(hashRegisterNo(v)).toBe(h);
    }
  });

  it('differs for different registers', () => {
    expect(hashRegisterNo(`${UB}12345678`)).not.toBe(hashRegisterNo(`${UB}12345679`));
    expect(hashRegisterNo(`${UB}12345678`)).not.toBe(hashRegisterNo(`${XA}12345678`));
  });

  it('does not contain the plain register', () => {
    expect(hashRegisterNo(`${UB}12345678`)).not.toContain('12345678');
  });
});

describe('foldRegisterNo', () => {
  it('makes Latin Y, Cyrillic Ү and Cyrillic У agree (comparison key only)', () => {
    const folded = foldRegisterNo('YA12345678');
    expect(folded).toBe('УА12345678');
    expect(foldRegisterNo('ҮА12345678')).toBe(folded);
    expect(foldRegisterNo('уа 12345678')).toBe(folded);
    expect(foldRegisterNo('ӨҮ12345678')).toBe('ӨУ12345678');
  });
});

describe('registerNoHashVariants', () => {
  it('starts with the canonical hash and adds every У/Ү combination of the two leading letters', () => {
    expect(registerNoHashVariants('УБ12345678')[0]).toBe(hashRegisterNo('УБ12345678'));
    expect(new Set(registerNoHashVariants('УУ12345678'))).toEqual(new Set(['УУ', 'ҮУ', 'УҮ', 'ҮҮ'].map((l) => hashRegisterNo(`${l}12345678`))));
    expect(new Set(registerNoHashVariants('ҮБ12345678'))).toEqual(new Set(['ҮБ', 'УБ'].map((l) => hashRegisterNo(`${l}12345678`))));
    expect(registerNoHashVariants('YA12345678')).toContain(hashRegisterNo('ҮА12345678'));
  });

  it('adds nothing for registers without У/Ү in the leading letters, or for legal-entity numbers', () => {
    expect(registerNoHashVariants('ЧА87654321')).toEqual([hashRegisterNo('ЧА87654321')]);
    expect(registerNoHashVariants('1234567')).toEqual([hashRegisterNo('1234567')]);
    expect(registerNoHashVariants('ЧУ12345678')).toHaveLength(2); // хоёр дахь үсэг У бол Ү хувилбар нэмэгдэнэ
    expect(registerNoHashVariants('УЧ12345678')).toHaveLength(2);
    expect(registerNoHashVariants('ЧЧ12345678')).toHaveLength(1);
  });
});
