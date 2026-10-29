// @los/contracts нь @los/database-г импортлож чадахгүй тул AmlSubject.registerNo-ийн нормчилсон уртын шалгалт давхар хэрэгжсэн.
// Хоёр хэрэгжилт зөрвөл (жнь нэг нь шинэ тэмдэгтийг устгадаг, нөгөө нь үгүй) zod нэг шийдвэр, hash нэг шийдвэр гаргана \u2014 энд тулгана.
import { describe, expect, it } from 'vitest';
import { AmlSubject, isUsableRegisterNo, normalizedRegisterNoLength } from '@los/contracts';
import { normalizeRegisterNo } from '@los/database';

describe('contracts registerNo length check agrees with @los/database normalizeRegisterNo', () => {
  const corpus = [
    '', ' ', 'УБ12345678', 'уб 12345678', 'XA-12345678', '1234567', '\u200b', '--', '\ufdfa', '\ufdfa\ufdfa\ufdfa',
    'УБ١٢٣٤٥٦٧٨', 'ＸＡ１２３４５６７８', 'И\u0306Э87654321', 'ß', 'ŉ', 'ǆ', 'ﬃ', '㎑', 'Ⅳ', '½', '\u02bc', 'a\u0301', '😀', '𝟏𝟐𝟑',
  ];

  it('gives the same length for a corpus of tricky inputs', () => {
    for (const raw of corpus) expect(normalizedRegisterNoLength(raw), JSON.stringify(raw)).toBe([...normalizeRegisterNo(raw)].length);
  });

  it('gives the same length for every BMP code point (wrapped in ordinary characters)', () => {
    for (let cp = 0; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const raw = `a${String.fromCodePoint(cp)}7`;
      if (normalizedRegisterNoLength(raw) !== [...normalizeRegisterNo(raw)].length) {
        throw new Error(`length mismatch for U+${cp.toString(16)}`);
      }
    }
  });

  it('accepts exactly the registers whose normalised form is 1..32 characters', () => {
    for (const raw of corpus) {
      const n = [...normalizeRegisterNo(raw)].length;
      expect(isUsableRegisterNo(raw), JSON.stringify(raw)).toBe(n >= 1 && n <= 32);
    }
  });

  it('AmlSubject accepts and rejects the same registers', () => {
    for (const raw of corpus) {
      const trimmed = raw.trim();
      if (trimmed === '' || trimmed.length > 32) continue; // эдгээрийг trim().min(1).max(32) өөрөө шийднэ
      const ok = AmlSubject.safeParse({ subjectType: 'INDIVIDUAL', registerNo: raw, firstName: 'Болд' }).success;
      expect(ok, JSON.stringify(raw)).toBe(isUsableRegisterNo(trimmed));
    }
  });
});
