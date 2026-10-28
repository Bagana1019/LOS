import { describe, expect, it } from 'vitest';
import { hashRegisterNo, normalizeRegisterNo } from '@los/database';
import { BlacklistCreateBody, BlacklistPatchBody, hasOnlyRegisterChars } from './blacklist.schemas';
import { entryInput, REGISTER } from './test-support';

const UNSUPPORTED = 'registerNo contains unsupported characters';
const NO_CONTENT = 'registerNo must contain letters or digits';

describe('hasOnlyRegisterChars (every non-separator character survives normalisation)', () => {
  it.each([
    REGISTER,
    'уб12345678',
    'УБ 12345678',
    'УБ-12345678',
    'УБ_12345678',
    'УБ.12345678',
    'УБ/12345678',
    'УБ,12345678',
    ' УБ - 1234 / 5678 ',
    'УБ\u201312345678', // en dash: normaliser бүх зураасыг тусгаарлагч гэж үздэг
    'УБ\uFF0D12345678', // fullwidth hyphen-minus → NFKC → '-'
    'УБ\u300012345678', // ideographic space → NFKC → ' '
    'ＵＢ１２３４５６７８', // fullwidth Latin + цифр
    'AO1234567', // латин look-alike
    '٠١٢٣٤٥٦٧', // араб-энэтхэг цифр
    'УБ\u200B1234\u200D5678', // үл үзэгдэх Cf (ZWSP, ZWJ): нормчлогч тусгайлан хаядаг
    'УБ1234\u0301', // нийлэхгүй үлдсэн mark
    'ЙЁ12345678', // NFC-ийн Й
    'И\u0306Е\u030812345678', // задарсан Й, Ё
    '1234567', // ААН
    '---', // зөвхөн тусгаарлагч: тэмдэгт алдагдахгүй (агуулгын шалгалт тусдаа)
    '',
  ])('accepts %j', (registerNo) => {
    expect(hasOnlyRegisterChars(registerNo)).toBe(true);
  });

  it.each([
    ['a question mark left by an ASCII conversion', 'УБ1234?678'],
    ['leading question marks', '??12345678'],
    ['the replacement character', '\uFFFD\uFFFD12345678'],
    ['an asterisk', 'УБ*****678'],
    ['a hash sign', '#УБ12345678'],
    ['parentheses', 'УБ(12345678)'],
    ['a colon', 'УБ:12345678'],
    ['an apostrophe', "УБ'12345678"],
    ['a modifier-letter apostrophe', 'УБ\u02BC12345678'],
    ['a vulgar fraction', 'УБ½345678'],
    ['an emoji', 'УБ12345678😀'],
    ['a lone surrogate', 'УБ1234\ud8005678'],
    ['a plus sign', 'УБ+12345678'],
    ['a pound sign', 'УБ£12345678'],
    ['a NUL', 'УБ\u000012345678'],
    ['a lone symbol', '?'],
  ])('rejects %s', (_label, registerNo) => {
    expect(hasOnlyRegisterChars(registerNo)).toBe(false);
  });

  // Тэмдэгт "дэмжигдсэн" гэвэл нормчлогч түүнийг хаяхгүй (тусгаарлагч, Cf, mark-аас бусад): үсэг/цифрийн тоо хадгалагдана.
  it('keeps every letter and digit of a supported register in the normalised form', () => {
    const raw = ' уб - 1234 5678 ';
    expect(hasOnlyRegisterChars(raw)).toBe(true);
    expect(normalizeRegisterNo(raw)).toBe('УБ12345678');
  });
});

describe('BlacklistCreateBody / BlacklistPatchBody register guard', () => {
  const messages = (result: { success: boolean; error?: { issues: Array<{ path: Array<string | number>; message: string }> } }) =>
    result.error?.issues.filter((i) => i.path[0] === 'registerNo').map((i) => i.message) ?? [];

  it('create: accepts separators and rejects unsupported characters and contentless registers with distinct messages', () => {
    expect(BlacklistCreateBody.safeParse(entryInput({ registerNo: 'уб-1234 5678' })).success).toBe(true);
    for (const registerNo of ['УБ1234?678', '\uFFFD\uFFFD12345678', 'УБ(12345678)']) {
      expect(messages(BlacklistCreateBody.safeParse(entryInput({ registerNo })))).toEqual([UNSUPPORTED]);
    }
    for (const registerNo of ['---', ' - ', '\u200B', '.,/_']) {
      expect(messages(BlacklistCreateBody.safeParse(entryInput({ registerNo })))).toEqual([NO_CONTENT]);
    }
  });

  it('patch: the same guard applies to registerNo and is skipped when registerNo is absent', () => {
    expect(BlacklistPatchBody.safeParse({ registerNo: 'УБ-12345678' }).success).toBe(true);
    expect(BlacklistPatchBody.safeParse({ name: 'x' }).success).toBe(true);
    expect(BlacklistPatchBody.safeParse({}).success).toBe(true);
    for (const registerNo of ['УБ1234?678', '\uFFFD12345678']) {
      expect(messages(BlacklistPatchBody.safeParse({ registerNo }))).toEqual([UNSUPPORTED]);
    }
    for (const registerNo of ['---', '\u200B', ' _ ']) {
      expect(messages(BlacklistPatchBody.safeParse({ registerNo }))).toEqual([NO_CONTENT]);
    }
  });

  it('a register that normalises to nothing would hash to the HMAC of the empty string: that is what the guard prevents', () => {
    const empty = hashRegisterNo('');
    expect(hashRegisterNo('---')).toBe(empty);
    expect(hashRegisterNo('\u200B')).toBe(empty);
    expect(BlacklistPatchBody.safeParse({ registerNo: '---' }).success).toBe(false);
  });
});
