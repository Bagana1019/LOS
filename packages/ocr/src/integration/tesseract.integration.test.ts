// ЖИНХЭНЭ Tesseract-тай интеграцийн тест (CLI + 'mon' + 'eng' хэл заавал). Байхгүй бол ШУУД ТАЛЛАН ӨНГӨРНӨ (skip).
// Fixture: packages/ocr/test-fixtures (ЗОХИОМОЛ зураг; README-д найдвартай талбаруудыг бүртгэсэн). Зөвхөн энд шалгагдсан талбаруудыг баталгаажуулна.
// Тайлан харах: OCR_REPORT=1 npx vitest run src/integration
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractDocument } from '../extract';
import { TesseractOcrProvider } from '../providers/tesseract.provider';
import type { OcrResult } from '../types';

function engineReady(): boolean {
  const langs = spawnSync('tesseract', ['--list-langs'], { encoding: 'utf8' });
  if (langs.error || langs.status !== 0) return false;
  const have = new Set(`${langs.stdout}\n${langs.stderr}`.split(/\r?\n/).map((l) => l.trim()));
  return have.has('mon') && have.has('eng');
}
const pdftoppmReady = (): boolean => !spawnSync('pdftoppm', ['-v']).error;

const FIXTURES = join(__dirname, '..', '..', 'test-fixtures');
const fixture = (name: string) => readFileSync(join(FIXTURES, name));
const REPORT = process.env.OCR_REPORT === '1';

describe.skipIf(!engineReady())('жинхэнэ Tesseract (mon+eng) + задлагч', () => {
  const provider = new TesseractOcrProvider({ timeoutMs: 120_000 });
  const ocrCache = new Map<string, Promise<OcrResult>>();
  const ocr = (name: string, mimeType: string): Promise<OcrResult> => {
    if (!ocrCache.has(name)) ocrCache.set(name, provider.recognize({ content: fixture(name), mimeType }));
    return ocrCache.get(name) as Promise<OcrResult>;
  };
  const values = (r: ReturnType<typeof extractDocument>) => Object.fromEntries(Object.entries(r.fields).map(([k, f]) => [k, f.value]));

  it('healthCheck: tesseract, mon, eng бэлэн', async () => {
    const h = await provider.healthCheck();
    expect(h.ok).toBe(true);
    expect(h.detail).toMatch(/tesseract \d/);
  });

  it('id-card.png: OCR бүтэц (хайрцаг, итгэл, хэл, хувилбар) ба бүх найдвартай талбар', async () => {
    const r = await ocr('id-card.png', 'image/png');
    expect(r.engine).toBe('tesseract');
    expect(r.engineVersion).toMatch(/^\d+\.\d+/);
    expect(r.languages).toEqual(['mon', 'eng']);
    expect(r.meanConfidence).toBeGreaterThan(0.7);
    expect(r.pages).toHaveLength(1);
    expect(r.pages[0].width).toBeGreaterThan(1000);
    const ys = r.pages[0].lines.map((l) => l.box.y);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys); // уншлагын дараалал: мөрүүд дээрээс доош
    expect(r.pages[0].lines.every((l) => l.words.length > 0 && l.box.width > 0)).toBe(true);

    const e = extractDocument(r, 'AUTO', { today: '2026-10-28' });
    expect(e.docType).toBe('ID_CARD');
    expect(e.detectedDocType).toBe('ID_CARD');
    const v = values(e);
    expect(v).toMatchObject({
      lastName: 'Дорж',
      firstName: 'Болд',
      registerNo: 'ЖЮ85061512', // OCR "ЖЮЗ85061512" гэж илүү үсэгтэй уншдаг — задлагч засна
      birthDate: '1985-06-15',
      gender: 'M',
      cardNumber: 'MN1234567',
      expiryDate: '2030-04-12',
    });
    expect(e.warnings).toEqual([]);
    if (REPORT) console.table(Object.entries(e.fields).map(([k, f]) => ({ k, value: f.value, conf: f.confidence, note: f.note })));
  });

  it('id-card-stacked.png (шошго дээр, утга доор): нэрс, огноо, хүйс; регистрийн "Б" нь "B" болж ойлгомжгүй → alternatives', async () => {
    const e = extractDocument(await ocr('id-card-stacked.png', 'image/png'), 'ID_CARD');
    expect(values(e)).toMatchObject({ lastName: 'Сүхбаатар', firstName: 'Оюунчимэг', birthDate: '1992-11-03', gender: 'F' });
    const reg = e.fields.registerNo;
    expect(reg.value).toMatch(/^У[БВ]92110384$/);
    expect([reg.value, ...(reg.alternatives ?? [])]).toContain('УБ92110384');
    expect(e.warnings).toEqual([]);
  });

  it('salary-certificate.png: байгууллага, ажилтан, регистр, албан тушаал, цалин (утас/он/дугаараас ялгаж), огноо, сарын тоо', async () => {
    const e = extractDocument(await ocr('salary-certificate.png', 'image/png'), 'AUTO');
    expect(e.docType).toBe('SALARY_CERTIFICATE');
    const v = values(e);
    expect(v).toMatchObject({ employeeName: 'Дорж Болд', registerNo: 'ЖЮ85061512', monthlySalary: 1_800_000, issueDate: '2026-09-15', periodMonths: 6 });
    expect(String(v.employerName)).toContain('Тэнгэр Трейд');
    expect(String(v.position)).toMatch(/мэргэжилтн/);
    expect(e.fields.monthlySalary.alternatives).toBeUndefined();
    expect(e.warnings).toEqual([]);
    if (REPORT) console.table(Object.entries(e.fields).map(([k, f]) => ({ k, value: f.value, conf: f.confidence, note: f.note })));
  });

  it('гар утасны зураг дуурайсан (эргэлт, бүдэгрэл, JPEG, толбо): ID карт', async () => {
    const e = extractDocument(await ocr('id-card-photo.jpg', 'image/jpeg'), 'AUTO');
    expect(e.docType).toBe('ID_CARD');
    expect(values(e)).toMatchObject({ lastName: 'Дорж', firstName: 'Болд', registerNo: 'ЖЮ85061512', birthDate: '1985-06-15', expiryDate: '2030-04-12' });
  });

  it('гар утасны зураг дуурайсан: цалингийн тодорхойлолт (регистр уншигдахгүй байж болно — найдваргүй)', async () => {
    const e = extractDocument(await ocr('salary-certificate-photo.jpg', 'image/jpeg'), 'AUTO');
    expect(e.docType).toBe('SALARY_CERTIFICATE');
    expect(values(e)).toMatchObject({ employeeName: 'Дорж Болд', monthlySalary: 1_800_000, issueDate: '2026-09-15' });
  });

  it.skipIf(!pdftoppmReady())('two-page.pdf: pdftoppm → хуудас бүр OCR; 2 хуудас, текст "\\n\\f"-ээр, хуудас тус бүрийн төрөл', async () => {
    const r = await ocr('two-page.pdf', 'application/pdf');
    expect(r.pages.map((p) => p.pageNo)).toEqual([1, 2]);
    expect(r.text.split('\n\f')).toHaveLength(2);
    expect(r.warnings).toBeUndefined();
    const first = extractDocument({ ...r, pages: [r.pages[0]], text: r.pages[0].text }, 'AUTO');
    const second = extractDocument({ ...r, pages: [r.pages[1]], text: r.pages[1].text }, 'AUTO');
    expect(first.docType).toBe('ID_CARD');
    expect(first.fields.registerNo.value).toBe('ЖЮ85061512');
    expect(second.docType).toBe('SALARY_CERTIFICATE');
    expect(second.fields.monthlySalary.value).toBe(1_800_000);
    // бүх баримтыг хамтад нь задлавал хоёр хуудасны регистр давхардалгүй
    expect(extractDocument(r, 'GENERIC').fields.registerNos.value).toEqual(['ЖЮ85061512']);
  });

  it('зураг биш агуулга (PNG гэж зарласан текст) → INVALID_INPUT; эвдэрсэн PNG → INVALID_INPUT; процесс эхлэхгүй/унахгүй', async () => {
    await expect(provider.recognize({ content: Buffer.from('/etc/passwd\n'), mimeType: 'image/png' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const truncated = fixture('id-card.png').subarray(0, 300);
    await expect(provider.recognize({ content: truncated, mimeType: 'image/png' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('хоосон цагаан зураг → EMPTY_RESULT', async () => {
    const white = fixture('blank.png');
    await expect(provider.recognize({ content: white, mimeType: 'image/png' })).rejects.toMatchObject({ code: 'EMPTY_RESULT' });
  });
});
