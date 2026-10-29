import { describe, expect, it } from 'vitest';
import { buildSyntheticStatementText, SYNTHETIC_IBAN, SYNTHETIC_OWN_IBAN } from '../providers/mock.fixtures';
import { ocrResultFromText } from '../providers/result';
import { extractDocument } from './extract-document';

const run = (text: string, conf: Parameters<typeof ocrResultFromText>[1] = 0.97) => extractDocument(ocrResultFromText(text, conf), 'GENERIC');
const arr = (text: string, key: string) => run(text).fields[key].value as Array<string | number>;

describe('GENERIC: регистр', () => {
  it('зөв регистрүүдийг (давхардалгүй) массиваар; буруу (13-р сар), 9 цифртэйг хасна; латин look-alike, зай/зураас, OCR O/0', () => {
    const text = 'А: ЖЮ85061512, Б: УБ92110384, давхар ЖЮ85061512, буруу ЖЮ85131512, урт ЖЮ850615123, латин YБ90010203, зайтай ЖЮ 85061512 ба ЖЮ-8506I512';
    expect(arr(text, 'registerNos')).toEqual(['ЖЮ85061512', 'УБ92110384', 'УБ90010203']);
  });

  it('raw нь олдсон бүх хэсгийг ялгаж өгнө; итгэл баталгаажсан тул өндөр', () => {
    const f = run('ЖЮ85061512 ба УБ92110384').fields.registerNos;
    expect(f.raw).toBe('ЖЮ85061512 | УБ92110384');
    expect(f.confidence).toBeGreaterThan(0.98);
  });
});

describe('GENERIC: IBAN', () => {
  it('зайтай/зайгүй, кирилл М look-alike (МN), жижиг үсэг; mod-97 буруу, урт/богино, тухайн улсад үл тохирохыг хасна', () => {
    const text = [
      `IBAN: ${SYNTHETIC_IBAN}`,
      'зайтай: MN64 0005 1234 5678 9012',
      'кирилл М + латин N: МN10 0004 3456 7890 1234',
      'жижиг: mn64000512345678 9012',
      'буруу шалгах цифр: MN65 0005 1234 5678 9012',
      'богино: MN64 0005 1234',
      'хэт урт: MN640005123456789012999',
    ].join('\n');
    expect(arr(text, 'ibans')).toEqual([SYNTHETIC_IBAN, SYNTHETIC_OWN_IBAN]);
  });

  it('IBAN-ы дараа үг залгагдсан байсан ч (зайтай) зөв урттай хэсгийг л авна', () => {
    expect(arr('Данс MN64 0005 1234 5678 9012 Огноо 2026.03.01', 'ibans')).toEqual([SYNTHETIC_IBAN]);
  });

  it('IBAN-ы цифрүүд бусад талбарт (дүн, регистр, утас) давхардан орохгүй', () => {
    const r = run(`Данс ${SYNTHETIC_IBAN}`);
    expect(r.fields.amounts.value).toEqual([]);
    expect(r.fields.registerNos.value).toEqual([]);
    expect(r.fields.phones.value).toEqual([]);
  });
});

describe('GENERIC: огноо', () => {
  it('олон хэлбэр, хуанлийн хувьд буруу огноо (02-30) хасна, давхардал хасна', () => {
    const text = '2026.03.10, 11/03/2026, 2026-03-12, 2026 оны 3 сарын 13, 2026-02-30, 2026.03.10';
    expect(arr(text, 'dates')).toEqual(['2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13']);
  });
});

describe('GENERIC: мөнгөн дүн', () => {
  it('мянгатын тусгаарлагч/аравтын/мөнгөн тэмдэгттэй дүнг авч, жижиг бүхэл тоо (хуудас, он, дугаар), тэг, цагийг хасна', () => {
    const text = [
      'Хуудас 3 / 12. Он 2026. Дугаар 4567',
      'Цалин 1,800,000.00 ба 45,000.50',
      'Зээл 2500000 төгрөг, 300000₮, 750 000 MNT',
      'Тэг 0.00 ба 0,00',
      'Цаг 09:15 ба 14:30:07',
    ].join('\n');
    expect(arr(text, 'amounts')).toEqual([1_800_000, 45_000.5, 2_500_000, 300_000, 750_000]);
  });

  it('дүнгийн утгыг давхардуулахгүй, огнооны цифр дүн болохгүй', () => {
    expect(arr('1,000 ба 1,000 ба 2026.03.01', 'amounts')).toEqual([1000]);
  });
});

describe('GENERIC: утас', () => {
  it('8 цифр, 6-9-өөр эхэлсэн; +976, зай/зураастай; 5-аар эхэлсэн, 9 цифртэй, дансны дугаарын хэсгийг хасна', () => {
    const text = 'Утас 99112233, +976 88001122, 976-7011-2233, 9500 3344, 5511 2233, 991122334, данс 5011234567890';
    expect(arr(text, 'phones')).toEqual(['99112233', '88001122', '70112233', '95003344']);
  });

  it('мянгатын тусгаарлагчтай дүн дотор утас хайхгүй ("1,99112233" биш)', () => {
    expect(arr('Дүн 1,234,567 төгрөг', 'phones')).toEqual([]);
  });
});

describe('GENERIC: бүтэц, хоосон оролт, хуулга', () => {
  it('бүх таван түлхүүр үргэлж байна; олдоогүй бол хоосон массив, итгэл 0, raw null', () => {
    const r = run('энгийн текст');
    expect(Object.keys(r.fields)).toEqual(['registerNos', 'ibans', 'dates', 'amounts', 'phones']);
    for (const f of Object.values(r.fields)) expect(f).toMatchObject({ value: [], confidence: 0, raw: null });
    expect(r.docType).toBe('GENERIC');
  });

  it('зохиомол хуулга: IBAN хоёр, огноо, мөнгөн дүн олдоно; жижиг тоо/цаг шуугиангүй', () => {
    const r = run(buildSyntheticStatementText());
    expect(r.fields.ibans.value).toEqual([SYNTHETIC_IBAN, SYNTHETIC_OWN_IBAN]);
    expect(r.fields.dates.value).toContain('2026-03-01');
    expect(r.fields.dates.value).toContain('2026-03-25');
    const amounts = r.fields.amounts.value as number[];
    expect(amounts).toContain(1_800_000);
    expect(amounts).toContain(1_500);
    expect(amounts.every((a) => a > 0)).toBe(true);
    expect(amounts).not.toContain(2026);
    expect(amounts).not.toContain(15); // 09:15 цагийн хэсэг
  });

  it('итгэл: тэмдэгтийн OCR итгэл бага бол массивын итгэл буурч тэмдэглэл гарна', () => {
    const f = run('Утас 99112233', 0.2).fields.phones;
    expect(f.confidence).toBeLessThan(0.6);
    expect(f.note).toMatch(/Итгэл бага/);
  });

  it('урт адверсари оролт (200k тэмдэгт) хурдан (шугаман хугацаа) боловсруулагдана', () => {
    const text = `${'1 '.repeat(50_000)}\n${'ЖЮ'.repeat(30_000)}\n${'MN64 '.repeat(10_000)}`;
    const t0 = performance.now();
    run(text);
    expect(performance.now() - t0).toBeLessThan(5_000);
  });
});
