import { describe, expect, it } from 'vitest';
import { IBAN_LENGTHS, isValidIban, normalizeAccountNo } from './account';

// Тооцооллыг хэрэгжүүлэлтээс үл хамааран шалгахын тулд BigInt-ээр бие даасан mod-97 тооцоо
const toDigits = (s: string): string => [...s].map((c) => (/\d/.test(c) ? c : String(c.charCodeAt(0) - 55))).join('');
const remainder = (country: string, bban: string, check = '00'): number => Number(BigInt(toDigits(bban + country + check)) % 97n);
const makeIban = (country: string, bban: string): string => `${country}${String(98 - remainder(country, bban)).padStart(2, '0')}${bban}`;
/** mod-97 = 1 болох боловч шалгах цифр нь 02..98-аас гадуур (00, 01, 99) IBAN-ыг олно */
function ibanWithOutOfRangeCheck(check: '00' | '01' | '99'): string {
  const need = { '00': 1, '01': 0, '99': 96 }[check];
  for (let n = 0; n < 1000; n++) {
    const bban = `0005${String(n).padStart(12, '0')}`;
    if (remainder('MN', bban) === need) return `MN${check}${bban}`;
  }
  throw new Error('unreachable');
}

describe('isValidIban', () => {
  it.each([
    'GB82 WEST 1234 5698 7654 32',
    'DE89 3704 0044 0532 0130 00',
    'FR14 2004 1010 0505 0001 3M02 606',
    'NL91 ABNA 0417 1643 00',
    'NO93 8601 1117 947',
    'BE68 5390 0754 7034',
    'CH93 0076 2011 6238 5295 7',
    'ES91 2100 0418 4502 0005 1332',
    'IT60 X054 2811 1010 0000 0123 456',
    'MN58 0050 0991 2345 6789', // iban.com бүртгэлийн жишээ
    'MN580050099123456789',
  ])('accepts %j', (iban) => {
    expect(isValidIban(iban)).toBe(true);
  });

  it('accepts generated Mongolian IBANs (4-digit bank code + 12-digit account)', () => {
    for (const bank of ['0005', '0015', '0004', '0003', '0013']) {
      for (const account of ['000000501234', '000012345678', '999999999999']) {
        expect(isValidIban(makeIban('MN', bank + account)), bank + account).toBe(true);
      }
    }
  });

  it('is tolerant about case, separators and the IBAN label', () => {
    expect(isValidIban('mn58 0050 0991 2345 6789')).toBe(true);
    expect(isValidIban('MN58-0050-0991-2345-6789')).toBe(true);
    expect(isValidIban('  IBAN: MN58 0050 0991 2345 6789  ')).toBe(true);
    expect(isValidIban('iban MN580050099123456789')).toBe(true);
    expect(isValidIban('MN58\u{A0}0050\u{A0}0991\u{A0}2345\u{A0}6789')).toBe(true);
  });

  it('accepts cyrillic look-alike letters (OCR mon+eng): М -> M, case-insensitive', () => {
    expect(isValidIban('\u{41C}N580050099123456789')).toBe(true); // кирилл М + латин N
    expect(isValidIban('\u{43C}N580050099123456789')).toBe(true); // кирилл жижиг м
    expect(isValidIban('\u{41C}\u{41D}580050099123456789')).toBe(false); // кирилл Н = латин H (MH), N биш
  });

  it('rejects wrong check digits and transpositions', () => {
    expect(isValidIban('GB83 WEST 1234 5698 7654 32')).toBe(false);
    expect(isValidIban('MN59 0050 0991 2345 6789')).toBe(false);
    expect(isValidIban('MN58 0050 0991 2345 6798')).toBe(false); // сүүлийн хоёр цифр солигдсон
    expect(isValidIban('DE89 3704 0044 0532 0130 01')).toBe(false);
  });

  it('enforces the registry length even when mod-97 is satisfied', () => {
    expect(isValidIban(makeIban('MN', '0005' + '00000050123'))).toBe(false); // 19
    expect(isValidIban(makeIban('MN', '0005' + '0000005012345'))).toBe(false); // 21
    expect(isValidIban(makeIban('GB', 'WEST12345698765'))).toBe(false); // GB = 22
    expect(isValidIban(makeIban('DE', '37040044053201300'))).toBe(false);
  });

  it('enforces the Mongolian digits-only BBAN', () => {
    expect(isValidIban(makeIban('MN', '0005' + 'ABCD00501234'))).toBe(false);
    expect(isValidIban(makeIban('MN', '0005' + '00000050123X'))).toBe(false);
    // эсрэгээр, үсэг агуулсан бусад улсад зөвшөөрнө
    expect(isValidIban(makeIban('GB', 'WEST12345698765432'))).toBe(true);
  });

  it('rejects countries missing from the registry (strict)', () => {
    expect(isValidIban(makeIban('ZZ', '0005000000501234'))).toBe(false);
    expect(isValidIban(makeIban('US', '000500000050123456'))).toBe(false);
  });

  it.each(['00', '01', '99'] as const)('rejects check digits %s although mod-97 = 1', (check) => {
    const iban = ibanWithOutOfRangeCheck(check);
    expect(Number(BigInt(toDigits(iban.slice(4) + iban.slice(0, 4))) % 97n)).toBe(1); // mod-97 зөв гэдгийг баталгаажуулна
    expect(isValidIban(iban)).toBe(false);
  });

  it.each(['', '   ', 'abc', 'MN', 'MN58', '1234567890', '5011234567', 'MN58 0050 0991 2345 678?', 'MN58 0050 0991 2345 6789 0', 'A'.repeat(100)])(
    'rejects non-IBAN %j',
    (input) => {
      expect(isValidIban(input)).toBe(false);
    },
  );

  it('rejects non-strings', () => {
    expect(isValidIban(undefined as unknown as string)).toBe(false);
    expect(isValidIban(null as unknown as string)).toBe(false);
    expect(isValidIban(12345 as unknown as string)).toBe(false);
  });

  it('knows the registry length for Mongolia and sane lengths overall', () => {
    expect(IBAN_LENGTHS.MN).toBe(20);
    expect(IBAN_LENGTHS.GB).toBe(22);
    expect(IBAN_LENGTHS.NO).toBe(15);
    for (const [country, length] of Object.entries(IBAN_LENGTHS)) {
      expect(country).toMatch(/^[A-Z]{2}$/);
      expect(length).toBeGreaterThanOrEqual(15);
      expect(length).toBeLessThanOrEqual(34);
    }
  });
});

describe('normalizeAccountNo', () => {
  it.each([
    ['5011234567', '5011234567'],
    ['5011 234 567', '5011234567'],
    ['5011-234-567', '5011234567'],
    ['5011.234.567', '5011234567'],
    ['  5011234567  ', '5011234567'],
    ['Данс: 5011234567', '5011234567'],
    ['MNT 5011234567', '5011234567'],
    ['\u{FF15}\u{FF10}\u{FF11}\u{FF11}\u{FF12}\u{FF13}\u{FF14}', '5011234'], // бүтэн өргөнтэй цифр
    ['0012 3456', '00123456'], // тэгийг хадгална
    ['abc', ''],
    ['', ''],
    ['   ', ''],
  ])('local account %j -> %j', (input, expected) => {
    expect(normalizeAccountNo(input)).toBe(expected);
  });

  it.each([
    ['MN58 0050 0991 2345 6789', 'MN580050099123456789'],
    ['mn58 0050 0991 2345 6789', 'MN580050099123456789'],
    ['IBAN: MN58-0050-0991-2345-6789', 'MN580050099123456789'],
    ['\u{41C}N58 0050 0991 2345 6789', 'MN580050099123456789'], // кирилл М
    ['\u{43C}N58 0050 0991 2345 6789', 'MN580050099123456789'], // кирилл жижиг м (том болгож look-alike нугална)
    ['\u{43C}\u{43D}58 0050 0991 2345 6789', 'MH580050099123456789'], // кирилл н = латин H (look-alike), N биш
    ['GB82 WEST 1234 5698 7654 32', 'GB82WEST12345698765432'],
  ])('IBAN %j -> %j', (input, expected) => {
    expect(normalizeAccountNo(input)).toBe(expected);
  });

  it('decides by shape only (validity is isValidIban job)', () => {
    expect(normalizeAccountNo('MN58 0050 0991 2345 678')).toBe('MN58005009912345678');
  });

  it('returns an empty string for non-strings and over-long input', () => {
    expect(normalizeAccountNo(undefined as unknown as string)).toBe('');
    expect(normalizeAccountNo(5011234567 as unknown as string)).toBe('');
    expect(normalizeAccountNo('1'.repeat(65))).toBe('');
    expect(normalizeAccountNo('1'.repeat(64))).toBe('1'.repeat(64));
  });

  it('is idempotent', () => {
    for (const s of ['5011 234 567', 'mn58 0050 0991 2345 6789', 'x', '']) {
      const once = normalizeAccountNo(s);
      expect(normalizeAccountNo(once)).toBe(once);
    }
  });

  it('stays linear on 100k-char adversarial input', () => {
    const started = performance.now();
    expect(normalizeAccountNo('1 '.repeat(50_000))).toBe('');
    expect(isValidIban('MN'.repeat(50_000))).toBe(false);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
