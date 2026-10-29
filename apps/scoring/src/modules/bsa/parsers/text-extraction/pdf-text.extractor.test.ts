// PDF extractor тест: pdf-lib-ээр бодит PDF-ийг тест дотор үүсгэнэ (ЗОХИОМОЛ), мөн test-fixtures дахь SYNTHETIC PDF-үүд.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { StatementExtractionError } from './errors';
import { extractPdfText, readPdf } from './pdf-text.extractor';
import { TEXT_EXTRACTION_DEFAULTS } from './text-extraction.defaults';
import { buildPdf, syntheticStatement } from './testing/pdf-builder';

const O = TEXT_EXTRACTION_DEFAULTS.pdf;
const FIXTURES = join(__dirname, '..', '..', '..', '..', '..', 'test-fixtures', 'bsa', 'text-extraction');
const fixture = (name: string) => readFileSync(join(FIXTURES, name));

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof StatementExtractionError) return err.code;
    throw err;
  }
  return 'NO_ERROR';
}

describe('readPdf: хүснэгт сэргээлт', () => {
  it('толгой + 20 мөр + шилжсэн тайлбар + 2 дахь хуудас: нүд, дараалал, тоон нүд бүтэн', async () => {
    const { spec, expected } = syntheticStatement();
    const r = await readPdf(await buildPdf(spec), O);
    expect(r.hasTextLayer).toBe(true);
    expect(r.pages.map((p) => p.pageNo)).toEqual([1, 2]);
    expect(r.pages.map((p) => p.lines.map((l) => l.cells))).toEqual(expected);
  });

  it('мөр бүр дээрээс доош (y өсөх), text = нүднүүдийн нэг зайгаар залгасан', async () => {
    const r = await readPdf(await buildPdf(syntheticStatement().spec), O);
    for (const page of r.pages) {
      const ys = page.lines.map((l) => l.y as number);
      expect(ys).toEqual([...ys].sort((a, b) => a - b));
      for (const l of page.lines) expect(l.text).toBe(l.cells.join(' '));
    }
  });

  it('шилжсэн тайлбар: үргэлжлэл мөр тайлбарын баганад, эх мөрийн дараа шууд', async () => {
    const r = await readPdf(await buildPdf(syntheticStatement().spec), O);
    const lines = r.pages[0].lines;
    const i = lines.findIndex((l) => l.cells[0] === '2026-03-05');
    expect(lines[i].cells[1]).toBe('Payment for services rendered under agreement');
    expect(lines[i + 1].cells).toEqual(['no. 17 (synthetic continuation line)']);
    expect(lines[i + 2].cells[0]).toBe('2026-03-06');
  });

  it('тоон нүд мянгатын таслалтай бүтэн: 1,125,000.00 / 9,062,000.00', async () => {
    const r = await readPdf(await buildPdf(syntheticStatement().spec), O);
    const flat = r.pages.flatMap((p) => p.lines.flatMap((l) => l.cells));
    expect(flat).toEqual(expect.arrayContaining(['1,125,000.00', '9,062,000.00', '7,750.00']));
  });

  it('page /Rotate 90 + эргүүлсэн текст: харагдах чиглэлээр хэвтээ мөр болно', async () => {
    const buf = await buildPdf({
      pages: [{ rotation: 90, texts: [{ text: 'Date', x: 100, y: 100, rotate: 90 }, { text: 'Amount', x: 100, y: 300, rotate: 90 }] }],
    });
    const r = await readPdf(buf, { ...O, minAvgCharsPerPage: 1 });
    expect(r.pages[0].lines.map((l) => l.cells)).toEqual([['Date', 'Amount']]);
  });

  it('хэвтээ мөртэй холилдохгүй босоо текст: тусдаа мөр, хуудасны төгсгөлд', async () => {
    const buf = await buildPdf({
      pages: [{ texts: [{ text: 'Row text on the page', x: 40, y: 700 }, { text: 'Vertical', x: 300, y: 705, rotate: 90 }, { text: 'Second row text', x: 40, y: 680 }] }],
    });
    const r = await readPdf(buf, { ...O, minAvgCharsPerPage: 1 });
    expect(r.pages[0].lines.map((l) => l.cells)).toEqual([['Row text on the page'], ['Second row text'], ['Vertical']]);
  });

  describe('давамгайлсан унших чиглэл (хуудас /Rotate-гүй ч контент эргэсэн / ташуу скан)', () => {
    const ROWS = [
      ['Date', 'Description', 'Amount', 'Balance'],
      ['2026-03-01', 'Transfer ref 1001', '7,750.00', '1,992,250.00'],
      ['2026-03-02', 'Transfer ref 1002', '15,250.00', '1,977,000.00'],
      ['2026-03-03', 'Payment for services', '375,000.00', '2,352,000.00'],
      ['2026-03-04', 'Transfer ref 1004', '30,250.00', '2,321,750.00'],
    ];
    const COLS = [40, 110, 300, 410];
    /** Хүснэгтийг (x, y) → эргүүлсэн хүрээнд буулгана. deg: ccw градус */
    const table = (place: (x: number, y: number) => { x: number; y: number }, rotate: number) =>
      ROWS.flatMap((row, i) => row.map((text, c) => ({ text, ...place(COLS[c], 800 - 14 * i), rotate })));

    it('бүх текст 90° эргэсэн (page /Rotate 0): мөр, нүд хэвтээ хүрээнд сэргэнэ', async () => {
      const buf = await buildPdf({ pages: [{ texts: table((x, y) => ({ x: 840 - y, y: x }), 90) }] });
      const r = await readPdf(buf, O);
      expect(r.pages[0].lines.map((l) => l.cells)).toEqual(ROWS);
    });

    it('3° ташуу (скан шиг): 500pt өргөнд 26pt шилжих ч мөр тус бүр нэг мөр хэвээр', async () => {
      const th = (3 * Math.PI) / 180;
      const place = (x: number, y: number) => ({ x: x * Math.cos(th) - y * Math.sin(th) + 100, y: x * Math.sin(th) + y * Math.cos(th) });
      const r = await readPdf(await buildPdf({ pages: [{ texts: table(place, 3) }] }), O);
      expect(r.pages[0].lines.map((l) => l.cells)).toEqual(ROWS);
    });

    it('90° эргэсэн хуудсанд хэвтээ усан тэмдэг: давамгайлсан чиглэлээс зөрсөн тул тусдаа мөр, төгсгөлд', async () => {
      const texts = [...table((x, y) => ({ x: 840 - y, y: x }), 90), { text: 'WATERMARK', x: 200, y: 420, size: 40 }];
      const r = await readPdf(await buildPdf({ pages: [{ texts }] }), O);
      expect(r.pages[0].lines.map((l) => l.cells)).toEqual([...ROWS, ['WATERMARK']]);
    });
  });

  it('моноширин (Courier) мөр нэг Tj-д олон зайтай: нүдэнд тасарна', async () => {
    const line = (d: string, desc: string, amt: string) => `${d}   ${desc.padEnd(22)}   ${amt.padStart(12)}`;
    const buf = await buildPdf({
      pages: [{
        texts: [
          { text: line('2026-03-01', 'Transfer ref 1001', '7,750.00'), x: 40, y: 700, font: 'Courier' },
          { text: line('2026-03-02', 'Payment 77', '1,500,000.00'), x: 40, y: 686, font: 'Courier' },
        ],
      }],
    });
    const r = await readPdf(buf, { ...O, minAvgCharsPerPage: 1 });
    expect(r.pages[0].lines.map((l) => l.cells)).toEqual([
      ['2026-03-01', 'Transfer ref 1001', '7,750.00'],
      ['2026-03-02', 'Payment 77', '1,500,000.00'],
    ]);
  });

  it('хуурамч bold (ижил текст бага зэрэг шилжүүлж 2 удаа зурсан) давхардахгүй', async () => {
    const buf = await buildPdf({
      pages: [{ texts: [{ text: 'Closing balance 1,000.00', x: 40, y: 700 }, { text: 'Closing balance 1,000.00', x: 40.3, y: 700 }] }],
    });
    const r = await readPdf(buf, { ...O, minAvgCharsPerPage: 1 });
    expect(r.pages[0].lines.map((l) => l.cells)).toEqual([['Closing balance 1,000.00']]);
  });

  it('SYNTHETIC кирилл PDF (шигтгэсэн TTF): толгой + мөр, Ө/Ү тэмдэгт алдагдахгүй', async () => {
    const r = await readPdf(fixture('cyrillic-statement.pdf'), O);
    const lines = r.pages[0].lines.map((l) => l.cells);
    expect(lines[0]).toEqual(['Огноо', 'Гүйлгээний утга', 'Зарлага', 'Орлого', 'Үлдэгдэл']);
    expect(lines[1]).toEqual(['2026-03-01', 'Цалин 2026 оны 02 сар', '1,500,000.00', '2,300,000.00']);
    expect(lines.at(-1)).toEqual(['Өндөр Үнэтэй Өрөө Үйлчилгээ']);
  });
});

describe('readPdf: metadata (BSA-FR-2.3)', () => {
  it('producer, creator, title, author, огноо (ISO), хуудасны тоо', async () => {
    const { spec } = syntheticStatement({
      producer: 'Acme Report Engine 4.2',
      creator: 'Acme Exporter',
      title: 'Synthetic statement',
      author: 'Synthetic Author',
      creationDate: new Date('2026-03-01T10:20:30Z'),
      modDate: new Date('2026-03-02T11:00:00Z'),
    });
    const { pdf } = await readPdf(await buildPdf(spec), O);
    expect(pdf).toEqual({
      producer: 'Acme Report Engine 4.2',
      creator: 'Acme Exporter',
      title: 'Synthetic statement',
      author: 'Synthetic Author',
      creationDate: '2026-03-01T10:20:30.000Z',
      modDate: '2026-03-02T11:00:00.000Z',
      pageCount: 2,
      isEncrypted: false,
      hasSignature: false,
    });
  });

  it('metadata байхгүй PDF: талбарууд null, алдаа гарахгүй', async () => {
    const { pdf } = await readPdf(await buildPdf({ pages: [{ texts: [{ text: 'x'.repeat(40), x: 40, y: 700 }] }] }), O);
    expect(pdf).toMatchObject({ producer: null, creator: null, title: null, author: null, creationDate: null, modDate: null, pageCount: 1 });
  });

  it('гарын үсэг: SigFlags-тай (гарын үсэг зурсан) PDF → hasSignature', async () => {
    const buf = await buildPdf({ ...syntheticStatement().spec, signature: 'signed' });
    expect((await readPdf(buf, O)).pdf.hasSignature).toBe(true);
  });

  it('гарын үсгийн талбар (хоосон) бас hasSignature=true; талбар огт үгүй бол false', async () => {
    const unsigned = await buildPdf({ ...syntheticStatement().spec, signature: 'unsigned' });
    expect((await readPdf(unsigned, O)).pdf.hasSignature).toBe(true);
    expect((await readPdf(await buildPdf(syntheticStatement().spec), O)).pdf.hasSignature).toBe(false);
  });

  it('нууц үггүй нээгддэг (owner password-тэй) PDF: isEncrypted=true, текст уншигдана (SYNTHETIC fixture)', async () => {
    const r = await readPdf(fixture('encrypted-owner-only.pdf'), O);
    expect(r.pdf.isEncrypted).toBe(true);
    expect(r.pages[0].lines.map((l) => l.cells)).toEqual([['Date', 'Amount'], ['2026-03-01', '1,234.50']]);
  });
});

describe('readPdf: алдаа', () => {
  it('нууц үг шаардсан PDF → PDF_ENCRYPTED (SYNTHETIC fixture)', async () => {
    const err = await readPdf(fixture('encrypted-user-password.pdf'), O).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StatementExtractionError);
    expect((err as StatementExtractionError).code).toBe('PDF_ENCRYPTED');
    expect((err as StatementExtractionError).detail).toBe('PasswordException');
  });

  it('эвдэрсэн PDF → PDF_CORRUPT: толгойтой хог, таслагдсан, хоосон', async () => {
    const good = await buildPdf(syntheticStatement().spec);
    expect(await codeOf(readPdf(Buffer.from('%PDF-1.4\nthis is not really a pdf\n%%EOF'), O))).toBe('PDF_CORRUPT');
    expect(await codeOf(readPdf(good.subarray(0, 300), O))).toBe('PDF_CORRUPT');
    expect(await codeOf(readPdf(Buffer.alloc(0), O))).toBe('PDF_CORRUPT');
  });

  it('нэг ч хуудасгүй (хоосон хуудасны мод) PDF: pdfjs хоосон 1 хуудас гэж уншдаг → текстгүй (PDF_NO_TEXT_LAYER)', async () => {
    const empty = await buildPdf({ pages: [] });
    expect((await readPdf(empty, O)).pages).toEqual([{ pageNo: 1, lines: [] }]);
    expect(await codeOf(extractPdfText(empty, O))).toBe('PDF_NO_TEXT_LAYER');
  });

  it('хэмжээ хэтэрвэл TOO_LARGE (pdfjs-д өгөхөөс өмнө)', async () => {
    const good = await buildPdf(syntheticStatement().spec);
    expect(await codeOf(readPdf(good, { ...O, maxBytes: good.length - 1 }))).toBe('TOO_LARGE');
    expect(await codeOf(readPdf(good, { ...O, maxBytes: good.length }))).toBe('NO_ERROR');
  });

  it('хуудасны тоо хэтэрвэл TOO_LARGE (чимээгүй таслахгүй)', async () => {
    const good = await buildPdf(syntheticStatement().spec); // 2 хуудас
    const err = await readPdf(good, { ...O, maxPages: 1 }).catch((e: unknown) => e as StatementExtractionError);
    expect((err as StatementExtractionError).code).toBe('TOO_LARGE');
    expect((err as StatementExtractionError).message).toContain('1');
    expect(await codeOf(readPdf(good, { ...O, maxPages: 2 }))).toBe('NO_ERROR');
  });

  it('алдааны мессеж монгол, файлын агуулга/текстгүй', async () => {
    const err = (await readPdf(fixture('encrypted-user-password.pdf'), O).catch((e: unknown) => e)) as StatementExtractionError;
    expect(err.message).toMatch(/[А-Яа-я]/);
    expect(err.message).not.toContain('2026-03-01');
    expect(err.userMessage).toBe(err.message);
  });

  it('дуудагчийн буфер өөрчлөгдөхгүй', async () => {
    const buf = await buildPdf(syntheticStatement().spec);
    const copy = Buffer.from(buf);
    await readPdf(buf, O);
    expect(buf.equals(copy)).toBe(true);
  });
});

describe('extractPdfText: text layer ба OCR fallback', () => {
  const scanned = () => buildPdf({ pages: [{ texts: [] }], producer: 'Scanner App' }); // зураг/текстгүй хуудас
  const fallbackResult = { pages: [{ pageNo: 1, lines: [{ text: 'OCR line', cells: ['OCR line'] }] }], ocr: { engine: 'fake', meanConfidence: 0.9 } };

  it('text layer-тэй → source PDF_TEXT, fallback дуудагдахгүй', async () => {
    const fallback = vi.fn();
    const r = await extractPdfText(await buildPdf(syntheticStatement().spec), O, fallback);
    expect(r.source).toBe('PDF_TEXT');
    expect(r.pdf?.pageCount).toBe(2);
    expect(r.ocr).toBeUndefined();
    expect(fallback).not.toHaveBeenCalled();
  });

  it('text layer-гүй, fallback-гүй → PDF_NO_TEXT_LAYER', async () => {
    expect(await codeOf(extractPdfText(await scanned(), O))).toBe('PDF_NO_TEXT_LAYER');
  });

  it('text layer-гүй, fallback-тай → source OCR, meta.pdf хадгалагдана, fallback PDF-ийн бит-ийг авна', async () => {
    const fallback = vi.fn().mockResolvedValue(fallbackResult);
    const buf = await scanned();
    const r = await extractPdfText(buf, O, fallback);
    expect(fallback).toHaveBeenCalledWith(buf);
    expect(r).toMatchObject({ source: 'OCR', pages: fallbackResult.pages, ocr: fallbackResult.ocr });
    expect(r.pdf).toMatchObject({ producer: 'Scanner App', pageCount: 1 });
  });

  it('fallback алдаа шидвэл дамжина (OCR_FAILED)', async () => {
    const fallback = vi.fn().mockRejectedValue(new StatementExtractionError('OCR_FAILED'));
    expect(await codeOf(extractPdfText(await scanned(), O, fallback))).toBe('OCR_FAILED');
  });

  it('text layer хэт бага (хуудас тутамд дундаж < минимум): скан гэж үзнэ; босго доошоо бол text', async () => {
    const buf = await buildPdf({ pages: [{ texts: [{ text: 'Page 1 of 1', x: 40, y: 40 }] }] }); // хоосон биш 8 тэмдэгт
    expect(await codeOf(extractPdfText(buf, { ...O, minAvgCharsPerPage: 9 }))).toBe('PDF_NO_TEXT_LAYER');
    expect(await codeOf(extractPdfText(buf, { ...O, minAvgCharsPerPage: 8 }))).toBe('NO_ERROR');
  });
});
