import { describe, expect, it } from 'vitest';
import { ocrResultFromText } from '../providers/result';
import { FIXTURE_ID_CARD_TEXT } from '../providers/mock.fixtures';
import { extractDocument } from './extract-document';
import type { ExtractOptions } from './types';

const run = (text: string, conf: Parameters<typeof ocrResultFromText>[1] = 0.97, opts: ExtractOptions = {}) =>
  extractDocument(ocrResultFromText(text, conf), 'ID_CARD', opts);
const val = (text: string, key: string, conf?: Parameters<typeof ocrResultFromText>[1]) => run(text, conf).fields[key].value;

describe('ID_CARD: цэвэр хоёр хэлтэй загвар', () => {
  const r = extractDocument(ocrResultFromText(FIXTURE_ID_CARD_TEXT), 'ID_CARD');

  it('бүх талбарыг зөв задлана, анхааруулгагүй', () => {
    const v = Object.fromEntries(Object.entries(r.fields).map(([k, f]) => [k, f.value]));
    expect(v).toEqual({
      lastName: 'Дорж',
      firstName: 'Болд',
      patronymic: null,
      registerNo: 'ЖЮ85061512',
      birthDate: '1985-06-15',
      gender: 'M',
      cardNumber: 'MN1234567',
      issueDate: '2020-04-12',
      expiryDate: '2030-04-12',
    });
    expect(r.warnings).toEqual([]);
    expect(r).toMatchObject({ docType: 'ID_CARD', detectedDocType: 'ID_CARD', engine: 'mock' });
  });

  it('raw нь тусгаарлагчгүй түүхий хэсэг; баталгаажсан талбарын итгэл өндөр; олдоогүй талбар value=null, итгэл 0', () => {
    expect(r.fields.lastName.raw).toBe('Дорж');
    expect(r.fields.registerNo.raw).toBe('ЖЮ85061512');
    expect(r.fields.registerNo.confidence).toBeGreaterThan(0.98);
    expect(r.fields.birthDate.confidence).toBeGreaterThan(0.98);
    expect(r.fields.patronymic).toMatchObject({ value: null, confidence: 0, raw: null });
    expect(Object.keys(r.fields)).toEqual(['lastName', 'firstName', 'patronymic', 'registerNo', 'birthDate', 'gender', 'cardNumber', 'issueDate', 'expiryDate']);
  });
});

describe('ID_CARD: OCR-ийн шуугиан', () => {
  it('латин look-alike үсэг шошго болон утганд (Oвог, Hэр, Xүйс, Бoлд, YБ…)', () => {
    const text = [
      'Oвог / Surname: Дoрж', // латин O, o
      'Hэр / Given name: Бoлд', // латин H (Н), o
      'Xүйс / Sex: Эp', // латин X (Х), p (р)
      'Рeгистрийн дугаар: YБ90010203', // латин e, Y
      'Төрсөн огноо: 1990.01.02',
    ].join('\n');
    const r = run(text);
    expect(r.fields.lastName.value).toBe('Дорж');
    expect(r.fields.firstName.value).toBe('Болд');
    expect(r.fields.gender.value).toBe('M');
    expect(r.fields.registerNo.value).toBe('УБ90010203');
    expect(r.fields.birthDate.value).toBe('1990-01-02');
  });

  it('O/0, I/1, S/5 андуурал: регистр, огноо, хүчинтэй хугацаа', () => {
    const text = ['Регистрийн дугаар: ЖЮ85O61512', 'Төрсөн огноо: 1985.O6.15', 'Хүчинтэй хугацаа: 2O3O.O4.I2'].join('\n');
    const r = run(text);
    expect(r.fields.registerNo.value).toBe('ЖЮ85061512');
    expect(r.fields.birthDate.value).toBe('1985-06-15');
    expect(r.fields.expiryDate.value).toBe('2030-04-12');
    expect(r.warnings).toEqual([]);
  });

  it('шошгоны үсгийн алдаа (Овот, Регистрйн дугаар, Төрсөн огнoо, Хүчинтэй хугаца) — итгэл бага зэрэг буурна', () => {
    const typo = [
      'Овот: Дорж',
      'Нэр: Болд',
      'Регистрйн дугаар: ЖЮ85061512',
      'Төрсөн огнoо: 1985.06.15',
      'Хүчинтэй хугаца: 2030.04.12',
    ].join('\n');
    const clean = [
      'Овог: Дорж',
      'Нэр: Болд',
      'Регистрийн дугаар: ЖЮ85061512',
      'Төрсөн огноо: 1985.06.15',
      'Хүчинтэй хугацаа: 2030.04.12',
    ].join('\n');
    const a = run(typo);
    const b = run(clean);
    expect(a.fields.lastName.value).toBe('Дорж');
    expect(a.fields.registerNo.value).toBe('ЖЮ85061512');
    expect(a.fields.birthDate.value).toBe('1985-06-15');
    expect(a.fields.expiryDate.value).toBe('2030-04-12');
    expect(a.fields.lastName.confidence).toBeLessThan(b.fields.lastName.confidence);
  });

  it('жижиг үсэг, БҮТЭН ЦАГААН ТОМ нэр → Title Case; хоёр хэлтэй "Дорж / Dorj" → кирилл хэсэг; холимог үгийг нэгтгэнэ', () => {
    expect(val('Овог: ДОРЖ\nНэр: БАТ-ЭРДЭНЭ', 'lastName')).toBe('Дорж');
    expect(val('Овог: ДОРЖ\nНэр: БАТ-ЭРДЭНЭ', 'firstName')).toBe('Бат-Эрдэнэ');
    expect(val('Овог: Дорж / Dorj', 'lastName')).toBe('Дорж');
    expect(val('Нэр: / Bold\nОвог: Дорж', 'firstName')).toBe('Bold');
    expect(val('Нэр: Бoлд', 'firstName')).toBe('Болд'); // латин o
    expect(val('Нэр: Болд1 |', 'firstName')).toBe('Болд');
  });

  it('нэрэнд тоо орвол noisy тэмдэглэгээ, итгэл буурна', () => {
    const r = run('Нэр: Бол5д 123');
    expect(r.fields.firstName.note).toMatch(/тоо/);
  });
});

describe('ID_CARD: утга дараагийн мөрөнд / багана', () => {
  it('шошго дээр, утга доор (stacked) — бүх талбар', () => {
    const text = ['Овог', 'Сүхбаатар', 'Нэр', 'Оюунчимэг', 'Хүйс', 'ЭМ', 'Төрсөн огноо', '1992.11.03', 'Регистрийн дугаар', 'УБ92110384'].join('\n');
    const r = run(text);
    expect(Object.fromEntries(Object.entries(r.fields).map(([k, f]) => [k, f.value]))).toMatchObject({
      lastName: 'Сүхбаатар',
      firstName: 'Оюунчимэг',
      gender: 'F',
      birthDate: '1992-11-03',
      registerNo: 'УБ92110384',
    });
    expect(r.warnings).toEqual([]);
  });

  it('шошго өөр шошгоор дараа нь эхэлсэн мөр бол утга биш (олдоогүй гэж үзнэ)', () => {
    const r = run(['Овог', 'Нэр', 'Болд'].join('\n'));
    expect(r.fields.lastName.value).toBeNull();
    expect(r.fields.firstName.value).toBe('Болд');
  });

  it('хоёр баганатай загвар: шошгын мөр, дор нь утгын мөр (x-байрлалаар хуваана)', () => {
    const text = [
      'Овог                    Нэр                     Хүйс',
      'Дорж                    Болд                    Эр',
      'Төрсөн огноо            Регистрийн дугаар',
      '1985.06.15              ЖЮ85061512',
    ].join('\n');
    const r = run(text);
    expect(r.fields.lastName.value).toBe('Дорж');
    expect(r.fields.firstName.value).toBe('Болд');
    expect(r.fields.gender.value).toBe('M');
    expect(r.fields.birthDate.value).toBe('1985-06-15');
    expect(r.fields.registerNo.value).toBe('ЖЮ85061512');
  });

  it('нэг мөрөнд хоёр шошго: "Овог: Дорж  Нэр: Болд"', () => {
    const r = run('Овог: Дорж     Нэр: Болд');
    expect(r.fields.lastName.value).toBe('Дорж');
    expect(r.fields.firstName.value).toBe('Болд');
  });
});

describe('ID_CARD: эцэг/эхийн нэр, хүйс, огнооны хэлбэрүүд', () => {
  it('"Эцэг/эхийн нэр" нь "Нэр" шошгоор андуурагдахгүй', () => {
    const r = run(['Овог / Surname: Дорж', 'Эцэг/эхийн нэр / Patronymic: Бат', 'Нэр / Given name: Болд'].join('\n'));
    expect(r.fields.patronymic.value).toBe('Бат');
    expect(r.fields.firstName.value).toBe('Болд');
    expect(r.fields.lastName.value).toBe('Дорж');
    const only = run('Эцэг/эхийн нэр: Бат');
    expect(only.fields.firstName.value).toBeNull();
    expect(only.fields.patronymic.value).toBe('Бат');
  });

  it.each([
    ['Эр', 'M'],
    ['Эрэгтэй', 'M'],
    ['ЭР / Male', 'M'],
    ['Эм', 'F'],
    ['Эмэгтэй', 'F'],
    ['Female', 'F'],
  ])('хүйс "%s" → %s', (printed, expected) => {
    expect(val(`Хүйс: ${printed}`, 'gender')).toBe(expected);
  });

  it('хүйс танигдахгүй/зөрчилтэй бол null (регистр байхгүй үед)', () => {
    expect(val('Хүйс: ???', 'gender')).toBeNull();
    expect(val('Хүйс: Эр Эм', 'gender')).toBeNull();
  });

  it.each(['1985.06.15', '1985-06-15', '1985/06/15', '15.06.1985', '1985 оны 06 сарын 15'])('төрсөн огнооны хэлбэр %s', (printed) => {
    expect(val(`Төрсөн огноо: ${printed}`, 'birthDate')).toBe('1985-06-15');
  });

  it('хуанлийн хувьд буруу огноо (02-30) → null', () => {
    expect(val('Төрсөн огноо: 1985.02.30', 'birthDate')).toBeNull();
  });

  it('хүчинтэй хугацаа муж "2020.04.12 - 2030.04.12" → хамгийн сүүлийн огноо; олгосон огноо → хамгийн эхний', () => {
    const r = run('Хүчинтэй хугацаа: 2020.04.12 - 2030.04.12');
    expect(r.fields.expiryDate.value).toBe('2030-04-12');
    const issued = run('Олгосон огноо: 2020.04.12 2030.04.12');
    expect(issued.fields.issueDate.value).toBe('2020-04-12');
  });

  it('үнэмлэхний дугаар: шошготой үед; 4-өөс цөөн цифртэй үгийг дугаар гэж үзэхгүй', () => {
    expect(val('Үнэмлэхний дугаар: MN1234567', 'cardNumber')).toBe('MN1234567');
    expect(val('Үнэмлэхний дугаар: AB12', 'cardNumber')).toBeNull();
  });
});

describe('ID_CARD: регистрийн дугаар ↔ төрсөн огноо/хүйс шалгалт', () => {
  it('төрсөн огноо/хүйс үнэмлэхнээс уншаагүй бол регистрээс гаргаж, "тооцоолсон" гэж тэмдэглэнэ (raw=null, итгэл бага)', () => {
    const r = run('Регистрийн дугаар: ЖЮ85061512');
    expect(r.fields.birthDate).toMatchObject({ value: '1985-06-15', raw: null });
    expect(r.fields.birthDate.note).toMatch(/регистр/);
    expect(r.fields.birthDate.confidence).toBeLessThan(r.fields.registerNo.confidence);
    expect(r.fields.gender).toMatchObject({ value: 'M', raw: null });
    expect(r.warnings).toEqual([]);
  });

  it('үнэмлэхний төрсөн огноо регистрээс зөрвөл анхааруулга (уншсан утга хэвээр)', () => {
    const r = run('Регистрийн дугаар: ЖЮ85061512\nТөрсөн огноо: 1990.01.01');
    expect(r.fields.birthDate.value).toBe('1990-01-01');
    expect(r.warnings).toEqual(['birthDate: үнэмлэхний төрсөн огноо регистрийн дугаараас зөрж байна']);
  });

  it('хүйс зөрвөл анхааруулга: ЖЮ85061512 (7-р цифр 1 = эр) ↔ "Эм"', () => {
    const r = run('Регистрийн дугаар: ЖЮ85061512\nХүйс: Эм');
    expect(r.fields.gender.value).toBe('F');
    expect(r.warnings).toEqual(['gender: үнэмлэхний хүйс регистрийн дугаараас зөрж байна']);
  });

  it('2000 оноос хойш төрсөн (сар+20): УБ05210512 → 2005-01-05', () => {
    const r = run('Регистрийн дугаар: УБ05210512\nТөрсөн огноо: 2005.01.05');
    expect(r.fields.registerNo.value).toBe('УБ05210512');
    expect(r.fields.birthDate.value).toBe('2005-01-05');
    expect(r.warnings).toEqual([]);
  });

  it('буруу регистр (13-р сар): value=null, raw хадгална, итгэл бага, анхааруулга; төрсөн огноо тооцоолохгүй', () => {
    const r = run('Регистрийн дугаар: ЖЮ85131512');
    expect(r.fields.registerNo).toMatchObject({ value: null, raw: 'ЖЮ85131512' });
    expect(r.fields.registerNo.confidence).toBeLessThan(0.4);
    expect(r.fields.registerNo.note).toMatch(/буруу/);
    expect(r.fields.birthDate.value).toBeNull();
    expect(r.warnings.some((w) => w.startsWith('registerNo буруу'))).toBe(true);
  });

  it('регистр огт байхгүй → олдсонгүй + анхааруулга', () => {
    const r = run('Овог: Дорж');
    expect(r.fields.registerNo.value).toBeNull();
    expect(r.warnings).toContain('registerNo олдсонгүй');
  });

  it('шошго гэмтсэн ч баримт даяар хайж регистрийг олно (итгэл шошготойгоос бага)', () => {
    const noLabel = run('Дорж Болд\nЖЮ85061512\nбусад');
    const labelled = run('Регистр: ЖЮ85061512');
    expect(noLabel.fields.registerNo.value).toBe('ЖЮ85061512');
    expect(noLabel.fields.registerNo.confidence).toBeLessThan(labelled.fields.registerNo.confidence);
  });

  it('зай/зураастай бичлэг: "ЖЮ 85061512", "ЖЮ-850615-12"', () => {
    expect(val('Регистр: ЖЮ 85061512', 'registerNo')).toBe('ЖЮ85061512');
    expect(val('Регистр: ЖЮ-85061512', 'registerNo')).toBe('ЖЮ85061512');
  });

  it('үсгийн хэсэгт илүү тэмдэгт (OCR: "ЖЮЗ85061512") → эхний 2 үсэг, тэмдэглэл, итгэл бууруулсан', () => {
    const clean = run('Регистр: ЖЮ85061512');
    const noisy = run('Регистр: ЖЮЗ85061512');
    expect(noisy.fields.registerNo.value).toBe('ЖЮ85061512');
    expect(noisy.fields.registerNo.note).toMatch(/илүү тэмдэгт/);
    expect(noisy.fields.registerNo.confidence).toBeLessThan(clean.fields.registerNo.confidence);
  });

  it('латин B ("YB92110384") → УВ, боловч Б-тэй хувилбарыг alternatives-д санал болгоно', () => {
    const r = run('Регистр: YB92110384');
    expect(r.fields.registerNo.value).toBe('УВ92110384');
    expect(r.fields.registerNo.alternatives).toEqual(['УБ92110384']);
    expect(r.fields.registerNo.note).toMatch(/Б\/В/);
  });

  it('9 оронтой/8-аас цөөн цифртэй дугаарыг регистр гэж авахгүй', () => {
    expect(val('Регистр: ЖЮ850615123', 'registerNo')).toBeNull();
    expect(val('Регистр: ЖЮ8506151', 'registerNo')).toBeNull();
  });
});

describe('ID_CARD: итгэл, хугацаа, хоосон оролт', () => {
  it('регистрийн үгсийн OCR итгэл бага бол талбарын итгэл буурч "Итгэл бага" тэмдэглэл гарна, бусад талбарт нөлөөлөхгүй', () => {
    const text = ['Овог: Дорж', 'Регистр: ЖЮ85061512'].join('\n');
    const r = run(text, (w) => (w === 'ЖЮ85061512' ? 0.1 : 0.98));
    expect(r.fields.registerNo.confidence).toBeLessThan(0.6);
    expect(r.fields.registerNo.note).toMatch(/Итгэл бага \(\d+%\)/);
    expect(r.fields.lastName.confidence).toBeGreaterThan(0.9);
    expect(r.fields.lastName.note).toBeUndefined();
  });

  it('босгыг өөрчилж болно (lowConfidenceThreshold)', () => {
    const r = run('Овог: Дорж', 0.7, { lowConfidenceThreshold: 0.9 });
    expect(r.fields.lastName.note).toMatch(/Итгэл бага/);
    expect(run('Овог: Дорж', 0.7, { lowConfidenceThreshold: 0.5 }).fields.lastName.note).toBeUndefined();
  });

  it('today өгвөл хугацаа дууссан үнэмлэхэд анхааруулга; өгөөгүй бол цаг уншихгүй (анхааруулгагүй)', () => {
    const text = 'Хүчинтэй хугацаа: 2020.04.12';
    const expiry = (o?: ExtractOptions) => run(text, 0.97, o).warnings.filter((w) => w.startsWith('expiryDate'));
    expect(expiry({ today: '2026-10-28' })).toEqual(['expiryDate: үнэмлэхний хүчинтэй хугацаа дууссан байна']);
    expect(expiry({ today: '2020-04-12' })).toEqual([]); // хугацаа дуусах өдөр дундаа хүчинтэй
    expect(expiry()).toEqual([]);
    expect(expiry({ today: 'өнөөдөр' })).toEqual([]);
  });

  it('хог/хоосон тексттэй ч унахгүй: бүх талбар null', () => {
    for (const text of ['', '   ', '!!!???', '\t\t\n\n', 'x'.repeat(5000), '\u0000\u0001']) {
      const r = run(text || ' ');
      expect(r.fields.lastName.value).toBeNull();
      expect(r.fields.registerNo.value).toBeNull();
    }
  });
});
