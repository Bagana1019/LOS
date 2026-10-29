import { describe, expect, it } from 'vitest';
import { last4, maskAccountLast4, maskPhone, maskRegister, scrubPii } from './masking';

describe('masking', () => {
  it('maskRegister keeps the first 2 letters and last 2 digits', () => {
    expect(maskRegister('УЕ12345601')).toBe('УЕ******01');
    expect(maskRegister(' уе12345601 ')).toBe('УЕ******01');
    expect(maskRegister('ЧБ99010203')).toBe('ЧБ******03');
  });
  it('maskRegister never reveals short input', () => {
    expect(maskRegister('УЕ12')).toBe('****');
    expect(maskRegister('')).toBe('');
  });
  it('maskPhone keeps the first 2 and last 2 digits', () => {
    expect(maskPhone('99112212')).toBe('99****12');
    expect(maskPhone('9911 2212')).toBe('99****12');
    expect(maskPhone('1234')).toBe('****');
  });
  it('maskAccountLast4 shows only the last four digits', () => {
    expect(maskAccountLast4('5012345678')).toBe('****5678');
    expect(maskAccountLast4('5678')).toBe('****5678');
    expect(last4('5012345678')).toBe('5678');
  });
  it('scrubPii masks register numbers and phone numbers inside free text', () => {
    const out = scrubPii('Худалдан авагч УЕ12345601 утас 99112212 цуцалсан, дүн 1500000');
    expect(out).toContain('УЕ******01');
    expect(out).toContain('99****12');
    expect(out).not.toContain('12345601');
    expect(out).not.toContain('99112212');
    expect(out).toContain('1500000');
  });
});

describe('scrubPii (free text) — register formats', () => {
  it.each([
    ['УЕ12345678', 'УЕ******78'],
    ['уе12345678', 'УЕ******78'],
    ['УЕ 12345678', 'УЕ******78'],
    ['УЕ  12345678', 'УЕ******78'],
    ['УЕ-12345678', 'УЕ******78'],
    ['УЕ.12345678', 'УЕ******78'],
    ['УЕ_12345678', 'УЕ******78'],
    ['УЕ/12345678', 'УЕ******78'],
    ['УЕ 12 34 56 78', 'УЕ******78'],
    ['УЕ 1234 5678', 'УЕ******78'],
    ['УЕ-1234-5678', 'УЕ******78'],
    ['УЕ 1234.5678', 'УЕ******78'],
    ['Ө Ү', 'Ө Ү'], // зөвхөн үсэг — өөрчлөгдөхгүй
    ['ӨҮ12345678', 'ӨҮ******78'],
    ['Чб99010203', 'ЧБ******03'],
    ['ЁЯ 99010203', 'ЁЯ******03'],
  ])('Cyrillic %j → %j', (input, expected) => {
    expect(scrubPii(input)).toBe(expected);
  });

  it.each([
    ['UE12345678', 'UE******78'], // латин ижил дүрс
    ['ue12345678', 'UE******78'],
    ['UE 12345678', 'UE******78'],
    ['UE-12345678', 'UE******78'],
    ['YE12345678', 'YE******78'],
    ['OY 12 34 56 78', 'OY******78'],
    ['УE12345678', 'УE******78'], // кирилл У + латин E
    ['UЕ12345678', 'UЕ******78'], // латин U + кирилл Е
  ])('Latin look-alikes %j → %j', (input, expected) => {
    expect(scrubPii(input)).toBe(expected);
  });

  it('full-width digits/letters and invisible separators cannot hide a register or phone', () => {
    expect(scrubPii('УЕ１２３４５６７８')).toBe('УЕ******78');
    expect(scrubPii('ＵＥ12345678')).toBe('UE******78');
    expect(scrubPii('утас ９９１１２２３３')).toBe('утас 99****33');
    expect(scrubPii('УЕ12​34‍5678')).toBe('УЕ******78');
    expect(scrubPii('9911­2233')).toBe('99****33');
    expect(scrubPii('УЕ 12345678')).toBe('УЕ******78'); // тасралтгүй зай
  });

  it('masks every occurrence in a sentence and keeps the rest of the text', () => {
    expect(scrubPii('Регистр УЕ 12345678 болон ЧБ-99010203, утас 99-11-22-33 / +976 88 11 22 33 цуцлав')).toBe('Регистр УЕ******78 болон ЧБ******03, утас 99****33 / 88****33 цуцлав');
  });

  it('keeps register lookalikes that are not a register: serials/lease numbers/short digit runs', () => {
    for (const text of ['SN-0001', 'Серийн дугаар ABC123', 'IMEI356938035643809', 'EUR 1234567', 'УЕ1234567', 'УЕ 123', 'ID1234']) {
      expect(scrubPii(text)).toBe(text);
    }
  });
});

describe('scrubPii (free text) — phone formats', () => {
  it.each([
    ['99112233', '99****33'],
    ['9911 2233', '99****33'],
    ['9911-2233', '99****33'],
    ['9911.2233', '99****33'],
    ['99 11 22 33', '99****33'],
    ['99-11-22-33', '99****33'],
    ['99.11.22.33', '99****33'],
    ['99 112233', '99****33'],
    ['991 12233', '99****33'],
    ['99 11 2233', '99****33'],
    ['9911-22-33', '99****33'],
    ['99 11 22 33', '99****33'], // NBSP
    ['+97699112233', '99****33'],
    ['+976 99112233', '99****33'],
    ['+976-9911-2233', '99****33'],
    ['+976 99 11 22 33', '99****33'],
    ['(976) 9911-2233', '99****33'],
    ['(+976) 9911 2233', '99****33'],
    ['976 99112233', '99****33'],
    ['97699112233', '99****33'],
    ['00976 99112233', '99****33'],
    ['00976-9911-2233', '99****33'],
    ['88112233', '88****33'],
    ['60123456', '60****56'],
    ['70123456', '70****56'],
    ['85123456', '85****56'],
  ])('phone %j → %j', (input, expected) => {
    expect(scrubPii(input)).toBe(expected);
    expect(scrubPii(`утас ${input}.`)).toBe(`утас ${expected}.`);
    expect(scrubPii(`${input} дугаараар`)).toBe(`${expected} дугаараар`);
  });

  it('a local number that starts with 976 is not mistaken for the country code', () => {
    expect(scrubPii('97611223')).toBe('97****23');
    expect(scrubPii('976 11223')).toBe('97****23'); // 8 цифр: угтвар биш, зайтай бичсэн дотоод дугаар
    expect(scrubPii('976 1122')).toBe('976 1122'); // 7 цифр
  });

  it('two phones separated by a space or a comma are both masked', () => {
    expect(scrubPii('99112233 88112244')).toBe('99****33 88****44');
    expect(scrubPii('99112233, 88112244')).toBe('99****33, 88****44');
  });

  it('phone numbers glued to words or punctuation are still masked', () => {
    expect(scrubPii('утас:99112233')).toBe('утас:99****33');
    expect(scrubPii('(99112233)')).toBe('(99****33)');
    expect(scrubPii('утас99112233')).not.toContain('112233'); // үгэнд наалдсан тохиолдолд регистр шиг маскална (хуучин зан төлөв)
  });
});

describe('scrubPii (free text) — false positives stay low', () => {
  it.each([
    'дүн 1500000',
    'дүн 1 500 000 төгрөг',
    'дүн 2,400,000₮',
    'дүн 2.400.000',
    '226943.03₮ сарын төлбөр',
    '926943.03', // аравтын бутархайтай дүн (6.2): утас биш
    '7 500 000 000',
    '60 000', '600 000', '9 000 000',
    'огноо 2026-10-28 12:30:45',
    '2026.10.28',
    '20261028', // 2-оор эхэлсэн 8 цифр
    'цаг 09:30',
    'POS-261028-000001',
    'POS-261028-912345',
    'POS-261028-9ABCDE',
    'лизинг POS-261028-0A1B2C цуцлагдлаа',
    'IMEI 356938035643809',
    'данс 5012345678',
    '123456789012', // 12 цифр
    '991122334', // 9 цифр
    'хугацаа 12 сар, хувь 24%, урьдчилгаа 20%',
    'Худалдан авагч татгалзав',
    'ЗМС-ийн мэдээлэл дутуу',
    '',
  ])('leaves %j unchanged', (text) => {
    expect(scrubPii(text)).toBe(text);
  });

  it('a lease number next to a phone: only the phone is masked', () => {
    expect(scrubPii('POS-261028-0A1B2C утас 99112233')).toBe('POS-261028-0A1B2C утас 99****33');
  });

  it('is idempotent: scrubbing twice equals scrubbing once, and masks never match again', () => {
    for (const text of ['УЕ 12345678 / +976 99 11 22 33', 'UE-12345678 99112233', 'хоосон']) {
      const once = scrubPii(text);
      expect(scrubPii(once)).toBe(once);
    }
  });

  it('does not take long on pathological input (no catastrophic backtracking)', () => {
    const started = Date.now();
    scrubPii(`${'9 '.repeat(20_000)}УЕ ${'1-'.repeat(20_000)}`);
    scrubPii(`${'УЕ'.repeat(20_000)}${'.'.repeat(20_000)}`);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
