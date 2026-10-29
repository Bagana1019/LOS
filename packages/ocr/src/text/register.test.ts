import { describe, expect, it } from 'vitest';
import { parseRegisterNo } from './register';
import type { RegisterNoInfo } from './register';

const INVALID: RegisterNoInfo = { valid: false, value: null, birthDate: null, gender: null };

/** Нэг тогтвортой дүрэм: valid=true бол гурвуулаа утгатай, valid=false бол гурвуулаа null */
function expectConsistent(r: RegisterNoInfo): void {
  if (r.valid) {
    expect(r.value).toMatch(/^[А-ЯЁӨҮ]{2}\d{8}$/);
    expect(r.birthDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(['M', 'F']).toContain(r.gender);
  } else {
    expect(r).toEqual(INVALID);
  }
}

/** Хэрэгжүүлэлтээс үл хамаарсан огнооны жишиг тооцоо (Date.UTC-ээр) */
function referenceBirthDate(digits: string): string | null {
  const yy = Number(digits.slice(0, 2));
  const mm = Number(digits.slice(2, 4));
  const dd = Number(digits.slice(4, 6));
  let year: number;
  let month: number;
  if (mm >= 1 && mm <= 12) [year, month] = [1900 + yy, mm];
  else if (mm >= 21 && mm <= 32) [year, month] = [2000 + yy, mm - 20];
  else return null;
  const d = new Date(Date.UTC(year, month - 1, dd));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== dd) return null;
  return d.toISOString().slice(0, 10);
}

describe('parseRegisterNo: valid numbers', () => {
  it.each([
    // [оролт, утга, төрсөн огноо, хүйс (8 цифрийн 7-р цифр: сондгой = эрэгтэй)]
    ['УБ90010203', 'УБ90010203', '1990-01-02', 'F'], // 7-р цифр 0
    ['ЧЗ99051234', 'ЧЗ99051234', '1999-05-12', 'M'], // 3
    ['ЧЗ99051244', 'ЧЗ99051244', '1999-05-12', 'F'], // 4
    ['УБ05231512', 'УБ05231512', '2005-03-15', 'M'], // сар 23 = 2000-ууд, 03-р сар
    ['ӨӨ85123101', 'ӨӨ85123101', '1985-12-31', 'F'],
    ['ҮЁ12321507', 'ҮЁ12321507', '2012-12-15', 'F'], // сар 32 → 12
    ['АБ00212901', 'АБ00212901', '2000-01-29', 'F'], // сар 21 → 01
    ['АБ00222912', 'АБ00222912', '2000-02-29', 'M'], // 2000 он — үсрэлт жил
    ['АБ96022912', 'АБ96022912', '1996-02-29', 'M'],
    ['ЯЯ99123199', 'ЯЯ99123199', '1999-12-31', 'M'], // 9 сондгой
    ['ЪЬ90010203', 'ЪЬ90010203', '1990-01-02', 'F'], // А–Я бүх үсэг зөвшөөрөгдөнө (ТАМААГ)
  ])('%j', (input, value, birthDate, gender) => {
    expect(parseRegisterNo(input)).toEqual({ valid: true, value, birthDate, gender });
  });

  it('treats only the 7th digit as the gender digit', () => {
    for (let d7 = 0; d7 <= 9; d7++) {
      const r = parseRegisterNo(`УБ900102${d7}5`);
      expect(r.gender, `d7=${d7}`).toBe(d7 % 2 === 1 ? 'M' : 'F');
    }
    // 8-р цифр (сүүлийнх) хүйсэнд нөлөөлөхгүй
    expect(parseRegisterNo('УБ90010221').gender).toBe('F');
    expect(parseRegisterNo('УБ90010230').gender).toBe('M');
  });

  it('is tolerant about case and separators', () => {
    for (const input of ['уб90010203', 'Уб90010203', 'УБ 90010203', 'УБ-90010203', 'УБ.90010203', ' УБ90010203 ', 'У Б 9 0 0 1 0 2 0 3',
      'УБ\u{A0}90010203', 'УБ_90010203', 'У\u{200B}Б90010203', 'УБ９００１０２０３']) {
      expect(parseRegisterNo(input), JSON.stringify(input)).toMatchObject({ valid: true, value: 'УБ90010203' });
    }
  });
});

describe('parseRegisterNo: latin look-alike letters', () => {
  it.each([
    ['AB90010203', 'АВ90010203'], // латин A, B
    ['ab90010203', 'АВ90010203'],
    ['MA90010203', 'МА90010203'],
    ['XO90010203', 'ХО90010203'],
    ['YB90010203', 'УВ90010203'], // Y → У, B → В (Б биш!)
    ['CE90010203', 'СЕ90010203'],
    ['HK90010203', 'НК90010203'],
    ['PT90010203', 'РТ90010203'],
    ['\u{41E}P90010203', 'ОР90010203'], // кирилл О + латин P
  ])('%j -> %j', (input, value) => {
    expect(parseRegisterNo(input)).toMatchObject({ valid: true, value });
  });

  it('does not guess transliterations', () => {
    expect(parseRegisterNo('UB90010203')).toEqual(INVALID); // U нь look-alike биш
    expect(parseRegisterNo('ZZ90010203')).toEqual(INVALID);
  });
});

describe('parseRegisterNo: OCR digit confusions (only when the result is valid)', () => {
  it.each([
    ['УБ9OO1O2O3', 'УБ90010203'], // латин O
    ['УБ9oo1o2o3', 'УБ90010203'],
    ['УБ9\u{41E}\u{41E}1\u{41E}2\u{41E}3', 'УБ90010203'], // кирилл О
    ['УБ9\u{43E}\u{43E}1\u{43E}2\u{43E}3', 'УБ90010203'],
    ['УБ900l0203', 'УБ90010203'], // жижиг l → 1
    ['УБI0010203', 'УБ10010203'], // I → 1
    ['УБ9S010203', 'УБ95010203'], // S → 5
    ['УБ9s010203', 'УБ95010203'],
    ['УБ8B010203', 'УБ88010203'], // B → 8
    ['уб9OO1O2O3', 'УБ90010203'],
  ])('%j -> %j', (input, value) => {
    expect(parseRegisterNo(input)).toMatchObject({ valid: true, value });
  });

  it('rejects when the repaired number is still not valid', () => {
    expect(parseRegisterNo('УБ9O0O9999')).toEqual(INVALID); // 90009999: сар 00
    expect(parseRegisterNo('УБ9X010203')).toEqual(INVALID); // X нь андуурал биш
    expect(parseRegisterNo('УБ9L010203')).toEqual(INVALID); // том L → 1 гэж үзэхгүй
    expect(parseRegisterNo('УБ9001020З')).toEqual(INVALID); // кирилл З
    expect(parseRegisterNo('УБ9OO1O2O')).toEqual(INVALID); // урт дутуу
  });

  it('never applies digit repairs to the letter part', () => {
    expect(parseRegisterNo('05900102030')).toEqual(INVALID);
    expect(parseRegisterNo('0Б90010203')).toEqual(INVALID);
  });
});

describe('parseRegisterNo: invalid calendar date => the WHOLE number is invalid (one consistent behaviour)', () => {
  it.each([
    'УБ90023001', // 1990-02-30
    'УБ99133101', // сар 13
    'УБ99203101', // сар 20
    'УБ99333101', // сар 33
    'УБ99003101', // сар 00
    'УБ99013201', // өдөр 32
    'УБ99010001', // өдөр 00
    'УБ99043101', // 4-р сар 31
    'АБ00022912', // 1900-02-29 (үсрэлт жил биш)
    'АБ01222912', // 2001-02-29
    'АБ99999999',
  ])('%j', (input) => {
    expect(parseRegisterNo(input)).toEqual(INVALID);
  });

  it('keeps value/birthDate/gender consistent with valid on 20000 pseudo-random numbers and matches an independent calendar', () => {
    let seed = 12345;
    const next = (n: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    let valid = 0;
    for (let i = 0; i < 20000; i++) {
      const digits = Array.from({ length: 8 }, (_, k) => (k === 2 ? next(4) : next(10))).join('');
      const r = parseRegisterNo(`УБ${digits}`);
      expectConsistent(r);
      const expected = referenceBirthDate(digits);
      expect(r.valid, digits).toBe(expected !== null);
      if (expected) {
        valid++;
        expect(r.birthDate).toBe(expected);
        expect(r.gender).toBe(Number(digits[6]) % 2 === 1 ? 'M' : 'F');
      }
    }
    expect(valid).toBeGreaterThan(1000);
  });
});

describe('parseRegisterNo: invalid shapes', () => {
  it.each([
    '',
    '   ',
    'abc',
    'УБ9001020', // 9 тэмдэгт
    'УБ900102033', // 11
    'У90010203',
    '1234567890',
    'УБУБ123456',
    'УБ 9001 0203 0',
    'РД: УБ90010203',
    'УБ90010203УБ',
    'УБ9001-0203x',
  ])('%j', (input) => {
    const r = parseRegisterNo(input);
    expect(r).toEqual(INVALID);
  });

  it('rejects non-strings and over-long input', () => {
    expect(parseRegisterNo(undefined as unknown as string)).toEqual(INVALID);
    expect(parseRegisterNo(null as unknown as string)).toEqual(INVALID);
    expect(parseRegisterNo(9001020300 as unknown as string)).toEqual(INVALID);
    expect(parseRegisterNo(`УБ${'1'.repeat(100_000)}`)).toEqual(INVALID);
    expect(parseRegisterNo(` ${' '.repeat(100_000)}УБ90010203`)).toEqual(INVALID);
  });

  it('returns a fresh object each time (callers may mutate)', () => {
    const a = parseRegisterNo('');
    const b = parseRegisterNo('');
    expect(a).not.toBe(b);
    a.valid = true;
    expect(parseRegisterNo('').valid).toBe(false);
  });
});
