import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { OcrError, type OcrBox, type OcrProvider, type OcrResult } from '@los/ocr';
import { describe, expect, it, vi } from 'vitest';
import { StatementExtractionError } from './errors';
import { StatementTextService } from './statement-text.service';
import { OCR_PROVIDER, TEXT_EXTRACTION_OPTIONS } from './tokens';
import { buildPdf, syntheticStatement } from './testing/pdf-builder';
import { encodeCp1251 } from './testing/encodings';
import type { TextExtractionOptionsInput } from './types';

const FIXTURES = join(__dirname, '..', '..', '..', '..', '..', 'test-fixtures', 'bsa', 'text-extraction');
const fixture = (name: string) => readFileSync(join(FIXTURES, name));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('synthetic-not-a-real-image')]);
const CSV = Buffer.from('Огноо;Утга;Дүн\n2026-03-01;Цалин;1500000,50\n', 'utf8');

const bx = (x: number, y: number, width: number): OcrBox => ({ x, y, width, height: 44 });
function ocrResult(engine = 'fake-ocr'): OcrResult {
  const words = [
    { text: '2026-03-01', confidence: 0.9, box: bx(100, 100, 240) },
    { text: 'Salary', confidence: 0.9, box: bx(520, 100, 144) },
    { text: '1,000.00', confidence: 0.9, box: bx(900, 100, 192) },
  ];
  const line = { text: 'x', confidence: 0.9, box: bx(100, 100, 992), words };
  const page = { pageNo: 1, width: 1000, height: 1000, text: 'x', lines: [line], meanConfidence: 0.91 };
  return { engine, engineVersion: '1', languages: ['mon', 'eng'], pages: [page], text: 'x', meanConfidence: 0.91, durationMs: 1 };
}
type FakeOcr = OcrProvider & { recognize: ReturnType<typeof vi.fn> };
const fakeOcr = (impl: () => Promise<OcrResult> = async () => ocrResult()): FakeOcr => ({ name: 'fake', recognize: vi.fn(impl) });

const make = (provider?: OcrProvider, options?: TextExtractionOptionsInput) => new StatementTextService(provider, options);
const codeOf = async (p: Promise<unknown>) => ((await p.catch((e: unknown) => e)) as StatementExtractionError).code;

describe('StatementTextService.extract: диспатч ба meta', () => {
  it('PDF: source PDF_TEXT, meta {fileName, каноник mime, sizeBytes, sha256, pdf}', async () => {
    const buf = await buildPdf(syntheticStatement({ producer: 'Acme', creationDate: new Date('2026-03-01T10:20:30Z') }).spec);
    const t = await make().extract({ fileName: 'march.pdf', mimeType: 'application/pdf', content: buf });
    expect(t.source).toBe('PDF_TEXT');
    expect(t.pages).toHaveLength(2);
    expect(t.meta).toMatchObject({ fileName: 'march.pdf', mimeType: 'application/pdf', sizeBytes: buf.length, sha256: sha(buf) });
    expect(t.meta.pdf).toMatchObject({ producer: 'Acme', creationDate: '2026-03-01T10:20:30.000Z', pageCount: 2, isEncrypted: false, hasSignature: false });
    expect(t.meta.ocr).toBeUndefined();
  });

  it('CSV: source CSV, нэг хуудас, pdf/ocr meta байхгүй', async () => {
    const t = await make().extract({ fileName: 'a.csv', mimeType: 'text/csv', content: CSV });
    expect(t.source).toBe('CSV');
    expect(t.pages).toHaveLength(1);
    expect(t.pages[0].pageNo).toBe(1);
    expect(t.pages[0].lines.map((l) => l.cells)).toEqual([['Огноо', 'Утга', 'Дүн'], ['2026-03-01', 'Цалин', '1500000,50']]);
    expect(t.meta).toEqual({ fileName: 'a.csv', mimeType: 'text/csv', sizeBytes: CSV.length, sha256: sha(CSV) });
  });

  it('windows-1251 CSV', async () => {
    const t = await make().extract({ fileName: 'a.csv', content: encodeCp1251('Огноо;Дүн\n2026-03-01;100\n') });
    expect(t.pages[0].lines.map((l) => l.cells)).toEqual([['Огноо', 'Дүн'], ['2026-03-01', '100']]);
  });

  it('TEXT: source TEXT, form feed хуудас', async () => {
    const content = Buffer.from('Statement\n2026-03-01  Salary  100.00\f2026-03-02  Shop  5.00\n');
    const t = await make().extract({ fileName: 'a.txt', mimeType: 'text/plain', content });
    expect(t.source).toBe('TEXT');
    expect(t.pages.map((p) => p.lines.length)).toEqual([2, 1]);
    expect(t.meta.mimeType).toBe('text/plain');
  });

  it('IMAGE: OcrProvider-ээр; source OCR, meta.ocr, каноник image mime provider-т, файлын нэр provider-т очихгүй', async () => {
    const ocr = fakeOcr();
    const t = await make(ocr).extract({ fileName: 'Өлзий-statement.PNG', mimeType: 'image/jpeg', content: PNG });
    expect(t.source).toBe('OCR');
    expect(t.pages[0].lines[0].cells).toEqual(['2026-03-01', 'Salary', '1,000.00']);
    expect(t.meta.ocr).toEqual({ engine: 'fake-ocr', meanConfidence: 0.91 });
    expect(t.meta.mimeType).toBe('image/png');
    expect(ocr.recognize).toHaveBeenCalledWith({ content: PNG, mimeType: 'image/png' });
  });

  it('IMAGE + OCR алдаа → OCR_FAILED; provider-гүй → OCR_FAILED', async () => {
    const bad = fakeOcr(async () => {
      throw new OcrError('TIMEOUT', 'x');
    });
    expect(await codeOf(make(bad).extract({ fileName: 'a.png', content: PNG }))).toBe('OCR_FAILED');
    expect(await codeOf(make().extract({ fileName: 'a.png', content: PNG }))).toBe('OCR_FAILED');
  });

  it('XLSX → UNSUPPORTED_FILE, CSV/PDF экспортлох заавар', async () => {
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]);
    const err = (await make().extract({ fileName: 'a.xlsx', content: zip }).catch((e: unknown) => e)) as StatementExtractionError;
    expect(err).toBeInstanceOf(StatementExtractionError);
    expect(err.code).toBe('UNSUPPORTED_FILE');
    expect(err.message).toContain('CSV');
    expect(err.message).toContain('PDF');
    expect(err.detail).toBe('XLSX');
  });

  it('UNKNOWN (танигдаагүй хоёртын файл) → UNSUPPORTED_FILE', async () => {
    const err = (await make().extract({ fileName: 'a.bin', content: Buffer.from([1, 2, 3, 0, 4]) }).catch((e: unknown) => e)) as StatementExtractionError;
    expect(err.code).toBe('UNSUPPORTED_FILE');
    expect(err.message).toMatch(/PDF/);
  });

  it('Buffer биш оролт → UNSUPPORTED_FILE', async () => {
    expect(await codeOf(make().extract({ fileName: 'a.csv', content: 'text' as unknown as Buffer }))).toBe('UNSUPPORTED_FILE');
    expect(await codeOf(make().extract({ fileName: 'a.csv', content: new Uint8Array([1]) as unknown as Buffer }))).toBe('UNSUPPORTED_FILE');
  });
});

describe('StatementTextService.extract: хуурамч MIME/нэр', () => {
  it('CSV агуулгыг application/pdf + .pdf гэж хуурсан → CSV болж уншигдана (PDF алдаа биш)', async () => {
    const t = await make().extract({ fileName: 'x.csv', mimeType: 'application/pdf', content: CSV });
    expect(t.source).toBe('CSV');
  });

  it('PDF-ийг text/csv + .csv гэж хуурсан → PDF', async () => {
    const buf = await buildPdf(syntheticStatement().spec);
    const t = await make().extract({ fileName: 'x.csv', mimeType: 'text/csv', content: buf });
    expect(t.source).toBe('PDF_TEXT');
    expect(t.meta.mimeType).toBe('application/pdf');
  });

  it('PNG-ийг .pdf + application/pdf гэж хуурсан → IMAGE (OCR)', async () => {
    const t = await make(fakeOcr()).extract({ fileName: 'x.pdf', mimeType: 'application/pdf', content: PNG });
    expect(t.source).toBe('OCR');
  });

  it('.pdf нэртэй HTML алдааны хуудас → UNSUPPORTED_FILE (PDF_CORRUPT биш)', async () => {
    const html = Buffer.from('<html><body>502 Bad Gateway</body></html>');
    expect(await codeOf(make().extract({ fileName: 'statement.pdf', mimeType: 'application/pdf', content: html }))).toBe('UNSUPPORTED_FILE');
  });
});

describe('StatementTextService.extract: хязгаар ба хоосон', () => {
  it('хоосон файл → EMPTY', async () => {
    expect(await codeOf(make().extract({ fileName: 'a.pdf', mimeType: 'application/pdf', content: Buffer.alloc(0) }))).toBe('EMPTY');
  });

  it('зөвхөн хоосон зай/хоосон бичлэгтэй CSV, TEXT → EMPTY', async () => {
    expect(await codeOf(make().extract({ fileName: 'a.csv', content: Buffer.from('\n  \n,,\n') }))).toBe('EMPTY');
    expect(await codeOf(make().extract({ fileName: 'a.txt', content: Buffer.from('   \n\t\n') }))).toBe('EMPTY');
  });

  it('дээд хэмжээ: яг хязгаарт OK, +1 байт TOO_LARGE (мессежид хязгаар, агуулга байхгүй)', async () => {
    const svc = make(undefined, { maxBytes: CSV.length });
    expect((await svc.extract({ fileName: 'a.csv', content: CSV })).source).toBe('CSV');
    const err = (await svc.extract({ fileName: 'a.csv', content: Buffer.concat([CSV, Buffer.from('x')]) }).catch((e: unknown) => e)) as StatementExtractionError;
    expect(err.code).toBe('TOO_LARGE');
    expect(err.message).toMatch(/МБ/);
    expect(err.message).not.toContain('Цалин');
  });

  it('анхдагч хязгаар 20 МБ', async () => {
    const big = Buffer.alloc(20 * 1024 * 1024 + 1, 0x61);
    expect(await codeOf(make().extract({ fileName: 'a.txt', content: big }))).toBe('TOO_LARGE');
  });

  it('PDF хуудасны тоо хэтэрвэл TOO_LARGE (тохиргоогоор)', async () => {
    const buf = await buildPdf(syntheticStatement().spec); // 2 хуудас
    expect(await codeOf(make(undefined, { pdf: { maxPages: 1 } }).extract({ fileName: 'a.pdf', content: buf }))).toBe('TOO_LARGE');
  });

  it('файлын нэр цэвэрлэгдэнэ: зам, удирдлагын тэмдэгт хасагдана, урт хязгаарлагдана, хоосон бол unnamed', async () => {
    const svc = make();
    const name = async (fileName: unknown) => (await svc.extract({ fileName: fileName as string, content: CSV, mimeType: 'text/csv' })).meta.fileName;
    expect(await name('C:\\Users\\x\\Documents\\statement.csv')).toBe('statement.csv');
    expect(await name('../../etc/passwd.csv')).toBe('passwd.csv');
    expect(await name('a\u0000b\nc.csv')).toBe('abc.csv');
    expect(await name(`${'n'.repeat(400)}.csv`)).toHaveLength(255);
    expect(await name('')).toBe('unnamed');
    expect(await name(undefined)).toBe('unnamed');
  });

  it('дуудагчийн буфер өөрчлөгдөхгүй (sha256 тогтвортой)', async () => {
    const buf = await buildPdf(syntheticStatement().spec);
    const before = sha(buf);
    const t = await make().extract({ fileName: 'a.pdf', content: buf });
    expect(sha(buf)).toBe(before);
    expect(t.meta.sha256).toBe(before);
  });
});

describe('StatementTextService: PDF алдаа ба OCR fallback', () => {
  it('нууц үгтэй → PDF_ENCRYPTED; нууц үггүй (owner-only) → нээгдэж meta.pdf.isEncrypted', async () => {
    expect(await codeOf(make().extract({ fileName: 'a.pdf', content: fixture('encrypted-user-password.pdf') }))).toBe('PDF_ENCRYPTED');
    const t = await make(undefined, { pdf: { minAvgCharsPerPage: 1 } }).extract({ fileName: 'a.pdf', content: fixture('encrypted-owner-only.pdf') });
    expect(t.meta.pdf?.isEncrypted).toBe(true);
    expect(t.pages[0].lines[1].cells).toEqual(['2026-03-01', '1,234.50']);
  });

  it('эвдэрсэн PDF → PDF_CORRUPT', async () => {
    const good = await buildPdf(syntheticStatement().spec);
    expect(await codeOf(make().extract({ fileName: 'a.pdf', content: good.subarray(0, 300) }))).toBe('PDF_CORRUPT');
    expect(await codeOf(make().extract({ fileName: 'a.pdf', content: Buffer.from('%PDF-1.4\ngarbage') }))).toBe('PDF_CORRUPT');
  });

  const scanned = () => buildPdf({ pages: [{ texts: [] }], producer: 'Scanner App' });

  it('text layer-гүй PDF, ocrFallback унтраалттай → PDF_NO_TEXT_LAYER (OCR дуудагдахгүй)', async () => {
    const ocr = fakeOcr();
    expect(await codeOf(make(ocr).extract({ fileName: 'scan.pdf', content: await scanned() }))).toBe('PDF_NO_TEXT_LAYER');
    expect(ocr.recognize).not.toHaveBeenCalled();
  });

  it('text layer-гүй PDF + ocrFallback: OcrProvider PDF-ийг (application/pdf) авч, source OCR, meta.pdf + meta.ocr хоёулаа', async () => {
    const ocr = fakeOcr();
    const buf = await scanned();
    const t = await make(ocr, { ocrFallback: true }).extract({ fileName: 'scan.pdf', content: buf });
    expect(t.source).toBe('OCR');
    expect(ocr.recognize).toHaveBeenCalledWith({ content: buf, mimeType: 'application/pdf' });
    expect(t.meta.pdf).toMatchObject({ producer: 'Scanner App', pageCount: 1 });
    expect(t.meta.ocr).toEqual({ engine: 'fake-ocr', meanConfidence: 0.91 });
    expect(t.meta.mimeType).toBe('application/pdf');
  });

  it('text layer-тэй PDF + ocrFallback асаалттай ч OCR дуудагдахгүй', async () => {
    const ocr = fakeOcr();
    const t = await make(ocr, { ocrFallback: true }).extract({ fileName: 'a.pdf', content: await buildPdf(syntheticStatement().spec) });
    expect(t.source).toBe('PDF_TEXT');
    expect(ocr.recognize).not.toHaveBeenCalled();
  });

  it('ocrFallback үед OCR алдаатай → OCR_FAILED', async () => {
    const bad = fakeOcr(async () => {
      throw new OcrError('ENGINE_FAILED', 'x');
    });
    expect(await codeOf(make(bad, { ocrFallback: true }).extract({ fileName: 'scan.pdf', content: await scanned() }))).toBe('OCR_FAILED');
  });

  it('OCR дутуу уншсан (warnings) → OCR_FAILED (хуудас чимээгүй алдагдахгүй)', async () => {
    const partial = fakeOcr(async () => ({ ...ocrResult(), warnings: ['PDF 20-оос олон хуудастай: эхний 20 хуудсыг л уншсан'] }));
    expect(await codeOf(make(partial, { ocrFallback: true }).extract({ fileName: 'scan.pdf', content: await scanned() }))).toBe('OCR_FAILED');
  });
});

describe('StatementTextService: тохиргоо ба DI', () => {
  it('ocrFallback=true боловч provider байхгүй → бүтээхэд Error (fail-fast)', () => {
    expect(() => make(undefined, { ocrFallback: true })).toThrow(/OCR_PROVIDER/);
  });

  it('буруу тохиргоо → бүтээхэд Error', () => {
    expect(() => make(undefined, { maxBytes: 0 })).toThrow(/text-extraction/);
  });

  it('Nest DI: тодорхой @Inject токенууд (OCR_PROVIDER, TEXT_EXTRACTION_OPTIONS) ажиллана', async () => {
    const ocr = fakeOcr();
    const moduleRef = await Test.createTestingModule({
      providers: [
        StatementTextService,
        { provide: OCR_PROVIDER, useValue: ocr },
        { provide: TEXT_EXTRACTION_OPTIONS, useValue: { maxBytes: 64 } },
      ],
    }).compile();
    const svc = moduleRef.get(StatementTextService);
    expect(await codeOf(svc.extract({ fileName: 'a.csv', content: Buffer.alloc(65, 0x61) }))).toBe('TOO_LARGE');
    expect((await svc.extract({ fileName: 'a.png', content: PNG })).source).toBe('OCR');
  });

  it('Nest DI: OCR_PROVIDER, TEXT_EXTRACTION_OPTIONS огт байхгүй ч (Optional) CSV уншина', async () => {
    const moduleRef = await Test.createTestingModule({ providers: [StatementTextService] }).compile();
    expect((await moduleRef.get(StatementTextService).extract({ fileName: 'a.csv', content: CSV })).source).toBe('CSV');
  });
});
