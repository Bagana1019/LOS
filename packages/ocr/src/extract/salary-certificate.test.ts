import { describe, expect, it } from 'vitest';
import { FIXTURE_SALARY_CERTIFICATE_TEXT } from '../providers/mock.fixtures';
import { ocrResultFromText } from '../providers/result';
import { extractDocument } from './extract-document';
import type { ExtractOptions } from './types';

const run = (text: string, conf: Parameters<typeof ocrResultFromText>[1] = 0.97, opts: ExtractOptions = {}) =>
  extractDocument(ocrResultFromText(text, conf), 'SALARY_CERTIFICATE', opts);
const salary = (text: string) => run(text).fields.monthlySalary.value;

describe('SALARY_CERTIFICATE: цэвэр загвар', () => {
  const r = run(FIXTURE_SALARY_CERTIFICATE_TEXT);

  it('бүх талбарыг задална', () => {
    const v = Object.fromEntries(Object.entries(r.fields).map(([k, f]) => [k, f.value]));
    expect(v).toEqual({
      employerName: 'Тэнгэр Трейд ХХК',
      employeeName: 'Дорж Болд',
      registerNo: 'ЖЮ85061512',
      position: 'Санхүүгийн албаны мэргэжилтнээр',
      monthlySalary: 1_800_000,
      issueDate: '2026-09-15',
      periodFrom: '2026-03',
      periodTo: '2026-09',
      periodMonths: 6,
    });
    expect(r.warnings).toEqual([]);
    expect(r.detectedDocType).toBe('SALARY_CERTIFICATE');
  });

  it('утасны дугаар (99112233), он (2026, 2020), баримтын дугаар (12/45), регистрийн цифрүүд цалин болохгүй', () => {
    expect(r.fields.monthlySalary.value).toBe(1_800_000);
    expect(r.fields.monthlySalary.alternatives).toBeUndefined();
    expect(r.fields.monthlySalary.raw).toBe('1,800,000');
  });

  it('нэг цалингийн дүн (түлхүүр үг + төгрөг) → итгэл өндөр, тэмдэглэлгүй', () => {
    expect(r.fields.monthlySalary.confidence).toBeGreaterThan(0.95);
    expect(r.fields.monthlySalary.note).toBeUndefined();
  });

  it('өгүүлбэрээс авсан албан тушаалд тайлбар (тийн ялгал) нэмэгдэнэ; итгэл шошготойгоос бага', () => {
    expect(r.fields.position.note).toMatch(/тийн ялгал/);
    expect(r.fields.position.confidence).toBeLessThan(r.fields.registerNo.confidence);
  });
});

describe('SALARY_CERTIFICATE: цалингийн дүн сонгох', () => {
  it('өөр тоонуудаас (утас, он, дугаар, хуудас) цалингийн түлхүүр үгтэй дүнг сонгоно', () => {
    const text = [
      'Утас: 99112233, +976 88001122, 7011-2233',
      '2026 оны 09 сар. Дугаар №123456. 2025 он',
      'Танай ажилтан сарын дундаж цалин 2,450,000 төгрөг авдаг.',
      'Хуудас 3, нийт 12 хуудас. Хаяг: 1234567 тоот.',
    ].join('\n');
    expect(salary(text)).toBe(2_450_000);
  });

  it('хэд хэдэн өөр цалингийн дүн → хамгийн эхнийх, alternatives, анхааруулга, итгэл буурна', () => {
    const one = run('Сарын цалин 1,500,000 төгрөг.');
    const text = 'Сарын цалин 1,500,000 төгрөг. Өмнөх сарын цалин 1,800,000 төгрөг.';
    const r = run(text);
    expect(r.fields.monthlySalary.value).toBe(1_500_000);
    expect(r.fields.monthlySalary.alternatives).toEqual([1_800_000]);
    expect(r.warnings).toEqual(['monthlySalary: 2 өөр цалингийн дүн олдлоо - зөв дүнг гараар сонгоно уу']);
    expect(r.fields.monthlySalary.confidence).toBeLessThan(one.fields.monthlySalary.confidence);
    expect(r.fields.monthlySalary.note).toMatch(/Хэд хэдэн/);
  });

  it('ижил дүн давтагдвал нэг л дүн гэж үзнэ (анхааруулгагүй)', () => {
    const r = run('Цалин 1,800,000 төгрөг. Дундаж цалин: 1,800,000 ₮.');
    expect(r.fields.monthlySalary.value).toBe(1_800_000);
    expect(r.warnings).toEqual([]);
  });

  it('урамшуулал/татвар/нэмэгдлийн дүн (сөрөг түлхүүр) цалин биш: оноо буурч, үндсэн цалин сонгогдоно', () => {
    const r = run('Цалин 1,800,000 төгрөг.\nШагнал урамшуулал 5,000,000 төгрөг.');
    expect(r.fields.monthlySalary.value).toBe(1_800_000);
    expect(r.warnings).toEqual([]);
  });

  it('түлхүүр үггүй дүн (зээлийн хэмжээ г.м.) цалин болохгүй → null, тайлбартай', () => {
    const r = run('Зээлийн хэмжээ: 25,000,000 төгрөг.');
    expect(r.fields.monthlySalary.value).toBeNull();
    expect(r.fields.monthlySalary.note).toMatch(/итгэлтэй тодорхойлогдсонгүй/);
  });

  it.each([
    ['OCR O/0: "1,8OO,OOO"', 'сарын цалин 1,8OO,OOO төгрөг', 1_800_000],
    ['мянгатын тусгаарлагчгүй + ₮', 'цалин 1800000₮', 1_800_000],
    ['зайгаар бүлэглэсэн', 'сарын цалин 1 800 000 төгрөг', 1_800_000],
    ['аравтын хэсэгтэй', 'цалин 1,800,000.00 төгрөг', 1_800_000],
    ['ЕХ хэлбэр (цэг мянгат, таслал аравтын)', 'цалин 1.800.000,00 төгрөг', 1_800_000],
    ['түлхүүр үг дараа нь', '1,800,000 төгрөг сарын цалин', 1_800_000],
    ['латин look-alike түлхүүр "цaлин"', 'сарын цaлин 1,800,000', 1_800_000],
    ['түлхүүр, дүн хоёр өөр мөрөнд (мөр таслалт)', 'Сарын дундаж цалин\n1,800,000 төгрөг', 1_800_000],
  ])('%s', (_name, text, expected) => {
    expect(salary(text)).toBe(expected);
  });

  it('боломжит хязгаараас гадуурх дүн (хэт бага/их) орхигдоно; хязгаарыг тохируулж болно', () => {
    expect(salary('цалин 5,000 төгрөг')).toBeNull();
    expect(salary('цалин 9,999,999,999 төгрөг')).toBeNull();
    expect(run('цалин 5,000 төгрөг', 0.97, { minSalary: 1_000 }).fields.monthlySalary.value).toBe(5_000);
    expect(run('цалин 1,800,000 төгрөг', 0.97, { maxSalary: 1_000_000 }).fields.monthlySalary.value).toBeNull();
  });

  it('8 оронтой, 6-9-өөр эхэлсэн бүхэл тоо = утас (цалин биш), тэр ойролцоо "цалин" үг байсан ч', () => {
    expect(salary('Цалин авах утас 99112233 төгрөг')).toBeNull();
  });

  it('жилийг (2026) цалин гэж авахгүй, "он" дараа нь байвал; төгрөгтэй 4 оронтой тоо хязгаарт багтахгүй (< minSalary)', () => {
    expect(salary('2026 оны цалин')).toBeNull();
  });
});

describe('SALARY_CERTIFICATE: байгууллага, ажилтан, албан тушаал', () => {
  it('байгууллага: letterhead-ийн хашилттай нэр, латин look-alike "XXK", шошготой, өгүүлбэр дотор', () => {
    expect(run('"Алтан Говь" ХХК\nЦалингийн тодорхойлолт').fields.employerName.value).toBe('Алтан Говь ХХК');
    expect(run('Алтан Говь XXK\nбусад').fields.employerName.value).toBe('Алтан Говь ХХК'.replace('ХХК', 'XXK'));
    expect(run('Байгууллагын нэр: Монгол Тээвэр ТӨҮГ').fields.employerName.value).toBe('Монгол Тээвэр ТӨҮГ');
    const sentence = 'Энэхүү тодорхойлолтыг "Хөх Тэнгэр" ХХК-ийн ажилтан Дорж Болд нь 2020 оноос хойш тус компанид ажиллаж байгаа тухай олгов.';
    expect(run(sentence).fields.employerName.value).toBe('Хөх Тэнгэр ХХК');
  });

  it('байгууллага олдохгүй бол null; хуулийн хэлбэргүй банкны нэр ("Хаан банкинд") байгууллага болохгүй', () => {
    expect(run('Энэхүү тодорхойлолтыг Хаан банкинд өгөв.').fields.employerName.value).toBeNull();
  });

  it('ажилтан: "овогтой" хэв маяг (латин look-alike ч), шошготой, регистрийн хаалтыг тайрна', () => {
    expect(run('Иргэн Дорж овогтой Болд нь манай ажилтан.').fields.employeeName.value).toBe('Дорж Болд');
    expect(run('Иргэн Дорж oвогтой Болд нь манай ажилтан.').fields.employeeName.value).toBe('Дорж Болд');
    expect(run('Ажилтны нэр: Сүхбаатар Оюунчимэг (РД: УБ92110384)').fields.employeeName.value).toBe('Сүхбаатар Оюунчимэг');
  });

  it('албан тушаал: шошготой (утга дараагийн мөрөнд ч), өгүүлбэрээс', () => {
    expect(run('Албан тушаал: Нягтлан бодогч').fields.position.value).toBe('Нягтлан бодогч');
    expect(run('Албан тушаал\nХүний нөөцийн менежер').fields.position.value).toBe('Хүний нөөцийн менежер');
    expect(run('нь Бүртгэлийн албаны ахлах мэргэжилтнээр ажиллаж байгаа').fields.position.value).toBe('Бүртгэлийн албаны ахлах мэргэжилтнээр');
  });

  it('байхгүй талбар = null, итгэл 0, "Олдсонгүй"', () => {
    const r = run('Ямар нэг текст');
    for (const k of ['employerName', 'employeeName', 'registerNo', 'position', 'monthlySalary', 'issueDate', 'periodFrom', 'periodTo', 'periodMonths']) {
      expect(r.fields[k].value).toBeNull();
      expect(r.fields[k].confidence).toBe(0);
    }
    expect(r.warnings).toEqual([]);
  });
});

describe('SALARY_CERTIFICATE: огноо, хугацаа, регистр', () => {
  it('олгосон огноо: монгол хэлбэр, тоон хэлбэр, шошготой', () => {
    expect(run('2026 оны 9 сарын 15').fields.issueDate.value).toBe('2026-09-15');
    expect(run('2026.09.15\nбусад').fields.issueDate.value).toBe('2026-09-15');
    expect(run('Огноо: 15.09.2026').fields.issueDate.value).toBe('2026-09-15');
    expect(run('Огноо: 2026.09.15\n2020 оны 03 сарын 01 -ээс хойш').fields.issueDate.value).toBe('2026-09-15');
  });

  it('хугацаа: "2026 оны 3 сараас 9 сар" → 2026-03..2026-09, 7 сар; "сүүлийн 6 сарын" → 6', () => {
    const r = run('2026 оны 3 сараас 9 сар хүртэл');
    expect([r.fields.periodFrom.value, r.fields.periodTo.value, r.fields.periodMonths.value]).toEqual(['2026-03', '2026-09', 7]);
    expect(r.fields.periodMonths.note).toMatch(/тооцоолсон/);
    expect(r.fields.periodMonths.raw).toBeNull();
    expect(run('сүүлийн 6 сарын дундаж').fields.periodMonths.value).toBe(6);
    expect(run('12 сарын дундаж цалин').fields.periodMonths.value).toBe(12);
  });

  it('жил гаталсан хугацаа: 2025 оны 11 сараас 2 сар → 2025-11..2026-02; тодорхой жилтэй; сар 13 бол хаяна', () => {
    const wrap = run('2025 оны 11 сараас 2 сар хүртэл');
    expect([wrap.fields.periodFrom.value, wrap.fields.periodTo.value, wrap.fields.periodMonths.value]).toEqual(['2025-11', '2026-02', 4]);
    const explicit = run('2025 оны 10 сараас 2026 оны 3 сар');
    expect([explicit.fields.periodTo.value, explicit.fields.periodMonths.value]).toEqual(['2026-03', 6]);
    expect(run('2026 оны 13 сараас 15 сар').fields.periodFrom.value).toBeNull();
  });

  it('тодорхой "6 сарын дундаж" нь тооцоолсон сарын тооноос илүү найдвартай (ашиглана)', () => {
    const r = run('2026 оны 3 сараас 9 сар хүртэлх 6 сарын дундаж цалин 1,800,000 төгрөг');
    expect(r.fields.periodMonths.value).toBe(6);
    expect(r.fields.periodMonths.raw).toBe('6 сарын дундаж');
  });

  it('регистр буруу бол анхааруулга; олдохгүй бол чимээгүй (тодорхойлолтод заавал биш)', () => {
    expect(run('РД: ЖЮ85131512').warnings.some((w) => w.startsWith('registerNo буруу'))).toBe(true);
    expect(run('ямар нэг текст').warnings).toEqual([]);
    expect(run('(РД: ЖЮ85061512)').fields.registerNo.value).toBe('ЖЮ85061512');
    expect(run('(РД: ЖЮӨ85061512)').fields.registerNo.value).toBe('ЖЮ85061512');
  });
});

describe('SALARY_CERTIFICATE: итгэл', () => {
  it('цалингийн дүнгийн OCR итгэл бага бол итгэл буурч тэмдэглэл гарна', () => {
    const r = run('Сарын цалин 1,800,000 төгрөг', (w) => (w === '1,800,000' ? 0.1 : 0.97));
    expect(r.fields.monthlySalary.value).toBe(1_800_000);
    expect(r.fields.monthlySalary.confidence).toBeLessThan(0.6);
    expect(r.fields.monthlySalary.note).toMatch(/Итгэл бага/);
  });
});
