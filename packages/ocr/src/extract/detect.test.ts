import { describe, expect, it } from 'vitest';
import { buildSyntheticStatementText, FIXTURE_ID_CARD_TEXT, FIXTURE_SALARY_CERTIFICATE_TEXT } from '../providers/mock.fixtures';
import { ocrResultFromText } from '../providers/result';
import { detectDocType } from './detect';
import { extractDocument } from './extract-document';

const detect = (text: string) => detectDocType(ocrResultFromText(text));

describe('detectDocType', () => {
  it('ID карт, цалингийн тодорхойлолт: өндөр оноо', () => {
    const id = detect(FIXTURE_ID_CARD_TEXT);
    const sal = detect(FIXTURE_SALARY_CERTIFICATE_TEXT);
    expect(id.docType).toBe('ID_CARD');
    expect(id.score).toBeGreaterThan(0.8);
    expect(sal.docType).toBe('SALARY_CERTIFICATE');
    expect(sal.score).toBeGreaterThan(0.6);
  });

  it('шошго/гарчигт OCR шуугиан (латин look-alike, үсгийн алдаа) байсан ч таньна', () => {
    expect(detect('ИРГЭНИЙ ҮНЭМЛЭX\nOвог: Дорж\nHэр: Болд\nРегистрйн дугаар: ЖЮ85061512\nXүйс: Эр').docType).toBe('ID_CARD');
    expect(detect('ЦAЛИНГИЙН ТОДОРХОЙЛОЛТ\nСарын дундаж цалин 1,800,000 төгрөг').docType).toBe('SALARY_CERTIFICATE');
  });

  it('гарчиггүй ч шошгоор: Овог/Нэр/Регистр/Төрсөн огноо/Хүйс → ID_CARD', () => {
    expect(detect('Овог: Дорж\nНэр: Болд\nРегистр: ЖЮ85061512\nТөрсөн огноо: 1985.06.15\nХүйс: Эр').docType).toBe('ID_CARD');
  });

  it('банкны хуулга, санамсаргүй текст, хоосон → GENERIC (оноо доогуур)', () => {
    const stmt = detect(buildSyntheticStatementText());
    expect(stmt.docType).toBe('GENERIC');
    expect(stmt.score).toBeLessThan(0.3);
    expect(detect('Сайн байна уу, энэ бол энгийн захидал.').docType).toBe('GENERIC');
    expect(detect(' ').docType).toBe('GENERIC');
  });

  it('цалингийн тодорхойлолтыг (регистртэй) ID карт гэж андуурахгүй', () => {
    const r = detect('Тодорхойлолт\nИргэн Дорж овогтой Болд (РД: ЖЮ85061512) манай компанид ажиллаж байгаа. Цалин 1,800,000 төгрөг. "Тэнгэр" ХХК');
    expect(r.docType).toBe('SALARY_CERTIFICATE');
  });
});

describe('extractDocument: AUTO ба docType зөрүү', () => {
  it('AUTO: танигдсан төрлөөр задлана; танигдаагүй бол GENERIC (detectedDocType=null)', () => {
    const id = extractDocument(ocrResultFromText(FIXTURE_ID_CARD_TEXT), 'AUTO');
    expect([id.docType, id.detectedDocType]).toEqual(['ID_CARD', 'ID_CARD']);
    expect(id.fields.registerNo.value).toBe('ЖЮ85061512');
    const stmt = extractDocument(ocrResultFromText(buildSyntheticStatementText()), 'AUTO');
    expect([stmt.docType, stmt.detectedDocType]).toEqual(['GENERIC', null]);
    expect(Object.keys(stmt.fields)).toContain('ibans');
  });

  it('тодорхой төрөл өгвөл түүгээр задлаад, агуулга өөр төрөлтэй төстэй бол анхааруулна', () => {
    const r = extractDocument(ocrResultFromText(FIXTURE_SALARY_CERTIFICATE_TEXT), 'ID_CARD');
    expect(r.docType).toBe('ID_CARD');
    expect(r.detectedDocType).toBe('SALARY_CERTIFICATE');
    expect(r.warnings.some((w) => w.startsWith('docType:'))).toBe(true);
  });

  it('GENERIC гэж тодорхой хүссэн бол зөрүүний анхааруулга өгөхгүй', () => {
    const r = extractDocument(ocrResultFromText(FIXTURE_ID_CARD_TEXT), 'GENERIC');
    expect(r.docType).toBe('GENERIC');
    expect(r.warnings).toEqual([]);
  });

  it('engine, meanConfidence, OCR-ийн warnings дамжина', () => {
    const ocr = { ...ocrResultFromText('Овог: Дорж', 0.8, 'tesseract'), warnings: ['PDF 2-оос олон хуудастай'] };
    const r = extractDocument(ocr, 'ID_CARD');
    expect(r.engine).toBe('tesseract');
    expect(r.meanConfidence).toBeCloseTo(0.8, 5);
    expect(r.warnings).toContain('PDF 2-оос олон хуудастай');
  });

  it('OcrResult-д мөр/үг байхгүй, зөвхөн page.text байвал мөрөөр нь хувааж ажиллана (fallback)', () => {
    const base = ocrResultFromText('x');
    const ocr = { ...base, pages: [{ ...base.pages[0], lines: [], text: 'Овог: Дорж\nНэр: Болд', meanConfidence: 0.9 }] };
    const r = extractDocument(ocr, 'ID_CARD');
    expect(r.fields.lastName.value).toBe('Дорж');
    expect(r.fields.firstName.value).toBe('Болд');
    expect(r.fields.lastName.confidence).toBeCloseTo(0.9, 2);
  });

  it('мөр нь байгаа боловч үггүй (зөвхөн line.text) бол мөрийн итгэлийг ашиглана', () => {
    const base = ocrResultFromText('x');
    const line = { text: 'Овог: Дорж', confidence: 0.7, box: { x: 0, y: 0, width: 10, height: 10 }, words: [] };
    const r = extractDocument({ ...base, pages: [{ ...base.pages[0], lines: [line], text: line.text }] }, 'ID_CARD');
    expect(r.fields.lastName.value).toBe('Дорж');
    expect(r.fields.lastName.confidence).toBeCloseTo(0.7, 2);
  });

  it('олон хуудас: хуудас дамнасан мөрүүдээс ч талбар олно', () => {
    const r = extractDocument(ocrResultFromText('Овог: Дорж\f Нэр: Болд\fРегистр: ЖЮ85061512'), 'ID_CARD');
    expect([r.fields.lastName.value, r.fields.firstName.value, r.fields.registerNo.value]).toEqual(['Дорж', 'Болд', 'ЖЮ85061512']);
  });
});
