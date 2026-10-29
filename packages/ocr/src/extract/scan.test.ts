import { describe, expect, it } from 'vitest';
import { normalizeDigitLookalikes } from './doc';
import { findAmounts, findIbans, findIsoDates, findPhones, findRegisterCandidates, findTimes, maskSpans } from './scan';

describe('normalizeDigitLookalikes', () => {
  it('тоон токен доторх O/I/l/S/B-г цифр болгоно, урт хадгална', () => {
    const src = 'Дүн 1,8OO,OOO ба 2O3O.O4.I2 ба 5OO';
    const out = normalizeDigitLookalikes(src);
    expect(out).toBe('Дүн 1,800,000 ба 2030.04.12 ба 5OO'); // '5OO': 1 цифр, 3 тэмдэгт → хөндөхгүй
    expect(out).toHaveLength(src.length);
  });

  it('үг, богино токен, цифргүй токен, үсэг залгасан токеныг хөндөхгүй', () => {
    for (const s of ['SOB', 'BOLO', 'Болд', 'I2', 'ЖЮ85O61512', 'Y892110384', 'online', 'Oil']) expect(normalizeDigitLookalikes(s)).toBe(s);
  });
});

describe('findRegisterCandidates', () => {
  it('зөв/буруу бүтэц, 3 үсэг, B ойлгомжгүй байдал', () => {
    const [ok, bad, three, latinB] = findRegisterCandidates('ЖЮ85061512 ЖЮ85131512 ЖЮЗ85061512 YB92110384');
    expect(ok.info.valid).toBe(true);
    expect(bad.info.valid).toBe(false);
    expect(three).toMatchObject({ extraLetter: true });
    expect(three.info.value).toBe('ЖЮ85061512');
    expect(latinB.alternatives).toEqual(['УБ92110384']);
    expect(ok.alternatives).toEqual([]);
  });

  it('offset зөв: raw нь эх текстийн хэсэг', () => {
    const text = 'Регистр: ЖЮ 85061512 ба';
    const [c] = findRegisterCandidates(text);
    expect(text.slice(c.start, c.end)).toBe(c.raw);
    expect(c.raw).toBe('ЖЮ 85061512');
  });

  it('үгийн дундах/дэргэдэх урт цифрийн дарааллаас регистр таслан авахгүй', () => {
    expect(findRegisterCandidates('5011234567890')).toEqual([]);
    expect(findRegisterCandidates('ЖЮ8506151234')).toEqual([]);
  });
});

describe('findIbans', () => {
  it('offset-ийг эх текстэд тааруулна (кирилл М look-alike ч)', () => {
    const text = 'Данс: МN10 0004 3456 7890 1234 дууслаа';
    const [i] = findIbans(text);
    expect(i.iban).toBe('MN100004345678901234');
    expect(text.slice(i.start, i.end)).toBe('МN10 0004 3456 7890 1234');
  });
});

describe('findPhones', () => {
  it('угтвар, зай, зураас; бүхэл тооны дунд, аравтын цэгийн дараах 8 цифрийг утас гэж үзэхгүй', () => {
    expect(findPhones('+97699112233 976 88001122 7011-2233').map((p) => p.phone)).toEqual(['99112233', '88001122', '70112233']);
    expect(findPhones('1.99112233 123456789').map((p) => p.phone)).toEqual([]);
  });
});

describe('findAmounts', () => {
  it('формат бүр: таслал, зай, цэг (ЕХ), аравтын, энгийн; мөнгөн тэмдэг хаалттай үсгэн дүнгийн дараа ч', () => {
    const r = findAmounts('1,800,000 | 1 800 000 | 1.800.000,50 | 12,5 | 1800000 | 1,800,000 (нэг сая найман зуун мянган) төгрөг | 750 000 MNT');
    expect(r.map((a) => a.value)).toEqual([1_800_000, 1_800_000, 1_800_000.5, 12.5, 1_800_000, 1_800_000, 750_000]);
    expect(r.map((a) => a.currency)).toEqual([false, false, false, false, false, true, true]);
  });

  it('"12 345" мөнгөн тэмдэггүй бол алгасна (хоёрдмол), ₮-тэй бол дүн', () => {
    expect(findAmounts('12 345')).toEqual([]);
    expect(findAmounts('12 345 ₮').map((a) => a.value)).toEqual([12_345]);
  });

  it('дараагийн үгийн эхний үсгийг мөнгөн тэмдэг гэж андуурахгүй ("1000 төгс", "1000 tugrugs")', () => {
    expect(findAmounts('1000 төгсгөл')[0].currency).toBe(false);
    expect(findAmounts('1000 tugrugs')[0].currency).toBe(false);
  });
});

describe('findTimes, findIsoDates, maskSpans', () => {
  it('цагийг олно; maskSpans урт хадгална', () => {
    const text = 'Цаг 09:15 ба 2:25 PM, 14:30:07';
    const times = findTimes(text);
    expect(times.map((t) => t.raw)).toEqual(['09:15', '2:25 PM', '14:30:07']);
    const masked = maskSpans(text, times);
    expect(masked).toHaveLength(text.length);
    expect(masked.replace(/ /g, '')).toBe('Цагба,');
    expect(masked.startsWith('Цаг ')).toBe(true);
  });

  it('maskSpans шинэ мөрийг хэвээр үлдээнэ', () => {
    expect(maskSpans('аб\nвг', [{ start: 1, end: 4, raw: 'б\nв' }])).toBe('а \n г');
  });

  it('findIsoDates: offset, raw', () => {
    const [d] = findIsoDates('Огноо: 2026.03.10!');
    expect(d).toMatchObject({ iso: '2026-03-10', raw: '2026.03.10' });
  });
});
