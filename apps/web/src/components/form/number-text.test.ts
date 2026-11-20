import { describe, expect, it } from 'vitest';
import { PERCENT_CODEC, MONEY_CODEC, caretAfter, formatNumberText, liveFormat, parseNumberText, significantBefore, toFieldValue } from './number-text';

// Мөнгө: мянгатын таслал, "сая/мянга"; хувь: зөвхөн аравтын таслал. Бүх тохиолдолд "чимээгүй өөр утга болгохгүй": ойлгосон утга, эсвэл invalid.
const money = (raw: string) => parseNumberText(raw, MONEY_CODEC);
const percent = (raw: string) => parseNumberText(raw, PERCENT_CODEC);
const ok = (value: number) => ({ kind: 'ok' as const, value });

describe('parseNumberText · мөнгө', () => {
  it('хоосон / зөвхөн зай → empty', () => {
    expect(money('')).toEqual({ kind: 'empty' });
    expect(money('   ')).toEqual({ kind: 'empty' });
  });

  it.each([
    ['5000000', 5_000_000],
    ['5,000,000', 5_000_000],
    ['5 000 000', 5_000_000],
    ['5 000 000', 5_000_000], // NBSP
    ["5'000'000", 5_000_000],
    ['2.000.000', 2_000_000], // олон цэг = мянгатын тусгаарлагч
    ['1,234.56', 1234.56],
    ['1.234,56', 1234.56],
    ['1,234,567.5', 1_234_567.5],
    ['1,500', 1500],
    ['12,500', 12_500],
    ['1,5', 1.5], // нэг таслал + 1-2 цифр = аравтын таслал
    ['1,50', 1.5],
    ['1.5', 1.5],
    ['5.', 5], // бичиж байх үеийн дунд төлөв
    ['5,', 5],
    ['.5', 0.5],
    ['007', 7],
    ['5₮', 5],
  ])('"%s" → %d', (raw, value) => expect(money(raw)).toEqual(ok(value)));

  it.each([
    ['5сая', 5_000_000],
    ['5 сая', 5_000_000],
    ['5СаЯ', 5_000_000],
    ['1.5сая', 1_500_000],
    ['1,5сая', 1_500_000],
    ['0.25сая', 250_000],
    ['500мянга', 500_000],
    ['2.5мянга', 2500],
    ['0.5мянга', 500],
    ['5сая₮', 5_000_000],
  ])('нэгж: "%s" → %d', (raw, value) => expect(money(raw)).toEqual(ok(value)));

  it.each(['5 сая 500 мянга', '5сая500', 'сая', 'мянга', '1,500сая', '1.555сая', '5саяхан', 'тав', 'abc', '1e6', '5k', '1.2.3', '1..5', '12,34,567', '1,2,3', '1.5,3', ',', '.', '-', '--5', '5-', '5%'])(
    '"%s" → invalid (чимээгүй өөр утга болгохгүй)',
    (raw) => expect(money(raw)).toEqual({ kind: 'invalid' }),
  );

  it('сөрөг тоог тасалдаггүй: -100 → -100 (форм дүрмээр нь татгалзана)', () => {
    expect(money('-100')).toEqual(ok(-100));
    expect(money('−100')).toEqual(ok(-100)); // Unicode хасах
    expect(money('-1,500')).toEqual(ok(-1500));
    expect(money('-5сая')).toEqual(ok(-5_000_000));
  });

  it('-0 нь 0 (сөрөг биш)', () => {
    const r = money('-0');
    expect(r).toEqual(ok(0));
    expect(Object.is((r as { value: number }).value, -0)).toBe(false);
  });

  it('хэт урт цифр (Infinity) → invalid', () => {
    expect(money('9'.repeat(400))).toEqual({ kind: 'invalid' });
  });
});

describe('parseNumberText · хувь', () => {
  it.each([
    ['1.5', 1.5],
    ['1,5', 1.5],
    ['1.5%', 1.5],
    ['150', 150],
    ['1,500', 1.5], // хувьд мянгатын таслал байхгүй: таслал = аравтын (3 орон нь дүрмээр татгалзагдана)
    ['1.555', 1.555],
    ['-1', -1],
  ])('"%s" → %d', (raw, value) => expect(percent(raw)).toEqual(ok(value)));

  it.each(['5сая', '2.000.000', '1,5,3', 'abc'])('"%s" → invalid', (raw) => expect(percent(raw)).toEqual({ kind: 'invalid' }));
  it('хоосон → empty', () => expect(percent('')).toEqual({ kind: 'empty' }));
});

describe('toFieldValue', () => {
  it('empty → undefined, ok → тоо, invalid → NaN (дүрэм "зөвхөн тоо" гэж мэдэгдэнэ)', () => {
    expect(toFieldValue({ kind: 'empty' })).toBeUndefined();
    expect(toFieldValue(ok(5))).toBe(5);
    expect(toFieldValue({ kind: 'invalid' })).toBeNaN();
  });
});

describe('formatNumberText', () => {
  it('мөнгө: мянгатын таслал, бутархай хэвээр, сөрөг тэмдэгтэй', () => {
    expect(formatNumberText(5_000_000, true)).toBe('5,000,000');
    expect(formatNumberText(1234.5, true)).toBe('1,234.5');
    expect(formatNumberText(-1500, true)).toBe('-1,500');
    expect(formatNumberText(0, true)).toBe('0');
  });
  it('хувь: таслалгүй, экспонентгүй', () => {
    expect(formatNumberText(1.5, false)).toBe('1.5');
    expect(formatNumberText(0.0000001, false)).not.toMatch(/e/i);
  });
  it('тоо биш → хоосон', () => {
    expect(formatNumberText(undefined, true)).toBe('');
    expect(formatNumberText(null, true)).toBe('');
    expect(formatNumberText(Number.NaN, true)).toBe('');
  });
});

describe('liveFormat (бичиж байх үеийн бүлэглэлт)', () => {
  it.each([
    ['1234567', '1,234,567'],
    ['5,000,000', '5,000,000'],
    ['5 000 000', '5,000,000'],
    ['1234.5', '1,234.5'],
    ['1234.', '1,234.'],
    ['0.5', '0.5'],
    ['007', '7'],
    ['0', '0'],
    ['', ''],
  ])('"%s" → "%s"', (raw, shown) => expect(liveFormat(raw, true)).toBe(shown));

  it.each(['1,5', '2.000.000', '5сая', '-100', '12,34', 'abc'])('"%s" хэвээр үлдэнэ (өөр утга болгохгүй)', (raw) => expect(liveFormat(raw, true)).toBe(raw));
  it('хувь: хэзээ ч өөрчлөхгүй', () => expect(liveFormat('1234,5', false)).toBe('1234,5'));

  // Өмнөх харагдаж буй текст (prev): таслал нь манай форматлагчийнх бол нэг тэмдэгт нэмэх/хасахад дахин бүлэглэнэ ("1,2345" → "12,345"),
  // хэрэглэгч шинээр таслал бичсэн/буулгасан бол хатуу шалгана ("1,5" нь аравтын таслал гэж үлдэнэ — "15" болгохгүй).
  it.each([
    ['1,2345', '1,234', '12,345'], // дунд/төгсгөлд цифр нэмэх
    ['12,3456', '12,345', '123,456'],
    ['123,4567', '123,456', '1,234,567'],
    ['1,23', '1,234', '123'], // backspace
    ['12,34', '12,345', '1,234'],
    ['1,234.', '1,234', '1,234.'],
  ])('өөрийн форматласан текстийн засвар: "%s" (өмнө "%s") → "%s"', (raw, prev, shown) => expect(liveFormat(raw, true, prev)).toBe(shown));

  it.each([
    ['1,', '1'], // шинээр таслал бичсэн
    ['1,5', '1,'], // аравтын таслалын дараа цифр (өмнөх "1," нь бүлэглэл биш)
    ['1,5', ''], // буулгасан
    ['1,5', '5,000,000'], // бүх текстийг буулгасан (урт зөрүү)
    ['1,2,34', '1,234'], // таслал нэмсэн
  ])('таслал нь хэрэглэгчийнх: "%s" (өмнө "%s") хэвээр', (raw, prev) => expect(liveFormat(raw, true, prev)).toBe(raw));

  it('prev-гүй буулгасан зөв бүлэглэл ("5,000,000") хэвээр', () => expect(liveFormat('5,000,000', true, '')).toBe('5,000,000'));
});

describe('caret: бүлэглэсний дараа курсор ижил цифрийн дараа үлдэнэ', () => {
  it('significantBefore: курсорын өмнөх цифр ба цэгийн тоо', () => {
    expect(significantBefore('1,234.5', 5)).toBe(4); // "1,234" → 4 цифр
    expect(significantBefore('1,234.5', 6)).toBe(5); // + "."
  });
  it('caretAfter: n дэх чухал тэмдэгтийн ард', () => {
    expect(caretAfter('1,234,567', 0)).toBe(0);
    expect(caretAfter('1,234,567', 4)).toBe(5); // 1,234|
    expect(caretAfter('1,234.', 5)).toBe(6); // "." -ийн ард (өмнө нь биш)
    expect(caretAfter('1,234', 99)).toBe(5);
  });
});
