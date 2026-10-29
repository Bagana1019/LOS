// ЖИНХЭНЭ Tesseract-тай интеграцийн тест. 'tesseract' PATH-д, 'mon'+'eng' хэл суусан үед л ажиллана (эс бөгөөс skip).
// Fixture: test-fixtures/bsa/text-extraction/statement-table.png — ЗОХИОМОЛ зураг (README), DejaVu Sans, кирилл толгойтой.
// Скан PDF-ийн урсгал: text layer-гүй PDF (зөвхөн зураг) + ocrFallback → `pdftoppm` шаардлагатай (байхгүй бол тусад нь skip).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TesseractOcrProvider } from '@los/ocr';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { StatementTextService } from './statement-text.service';

function tesseractReady(): boolean {
  const r = spawnSync('tesseract', ['--list-langs'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return false;
  const have = new Set(`${r.stdout}\n${r.stderr}`.split(/\r?\n/).map((l) => l.trim()));
  return have.has('mon') && have.has('eng');
}
const pdftoppmReady = (): boolean => !spawnSync('pdftoppm', ['-v']).error;

const FIXTURES = join(__dirname, '..', '..', '..', '..', '..', 'test-fixtures', 'bsa', 'text-extraction');
const PNG = () => readFileSync(join(FIXTURES, 'statement-table.png'));

/** Хүлээгдэх мөрүүд: [огноо, ...дүнгүүд] (fixture-ийн make_fixtures.py-тай ижил; хоосон баганууд алга) */
const EXPECTED_ROWS = [
  ['2026-03-01', '1,500,000.00', '2,300,000.00'],
  ['2026-03-02', '45,900.00', '2,254,100.00'],
  ['2026-03-05', '350,000.00', '1,904,100.00'],
  ['2026-03-09', '820,500.00', '2,724,600.00'],
  ['2026-03-12', '1,000.00', '2,723,600.00'],
];

/** OCR текст нь хоёр нүдийн хооронд зөрч болох тул: мөрийн ДАТА (огноо, дүн)-г нүд бүрээр нь тулгана, тайлбарын текст биш */
const dateAndAmountCells = (cells: string[]) => cells.filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(c) || /^\d{1,3}(,\d{3})*\.\d{2}$/.test(c));

describe.skipIf(!tesseractReady())('жинхэнэ Tesseract (mon+eng) → StatementTextService', () => {
  const provider = new TesseractOcrProvider({ timeoutMs: 120_000 });

  it('зураг (PNG): огноо, дүн нүд бүрээрээ амьд үлдэнэ; толгойн кирилл нүд; meta.ocr', async () => {
    const t = await new StatementTextService(provider).extract({ fileName: 'statement-table.png', mimeType: 'image/png', content: PNG() });
    expect(t.source).toBe('OCR');
    expect(t.meta.ocr?.engine).toBe('tesseract');
    expect(t.meta.ocr?.meanConfidence).toBeGreaterThan(0.7);
    expect(t.meta.mimeType).toBe('image/png');

    const lines = t.pages[0].lines;
    const header = lines.find((l) => l.cells.includes('Огноо'));
    expect(header?.cells).toEqual(['Огноо', 'Гүйлгээний утга', 'Зарлага', 'Орлого', 'Үлдэгдэл']);

    const rows = lines.filter((l) => /^\d{4}-\d{2}-\d{2}$/.test(l.cells[0])).map((l) => dateAndAmountCells(l.cells));
    expect(rows).toEqual(EXPECTED_ROWS);
    // мөрүүд дээрээс доош
    const ys = lines.map((l) => l.y as number);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
  });

  it.skipIf(!pdftoppmReady())('скан PDF (зөвхөн зураг, text layer-гүй): ocrFallback унтраалттай → PDF_NO_TEXT_LAYER, асаалттай → OCR', async () => {
    // 300 dpi: 1560×? px → pt = px × 72/300
    const png = PNG();
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.setProducer('Synthetic Scanner');
    const img = await doc.embedPng(png);
    const page = doc.addPage([img.width * 0.24, img.height * 0.24]);
    page.drawImage(img, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
    const scanned = Buffer.from(await doc.save());

    await expect(new StatementTextService(provider).extract({ fileName: 'scan.pdf', content: scanned })).rejects.toMatchObject({ code: 'PDF_NO_TEXT_LAYER' });

    const t = await new StatementTextService(provider, { ocrFallback: true }).extract({ fileName: 'scan.pdf', content: scanned });
    expect(t.source).toBe('OCR');
    expect(t.meta.pdf).toMatchObject({ producer: 'Synthetic Scanner', pageCount: 1 });
    expect(t.meta.ocr?.engine).toBe('tesseract');
    const rows = t.pages[0].lines.filter((l) => /^\d{4}-\d{2}-\d{2}$/.test(l.cells[0])).map((l) => dateAndAmountCells(l.cells));
    expect(rows).toEqual(EXPECTED_ROWS);
  });
});
