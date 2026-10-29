import { describe, expect, it } from 'vitest';
import { resolveTextExtractionOptions, TEXT_EXTRACTION_DEFAULTS } from './text-extraction.defaults';

describe('resolveTextExtractionOptions', () => {
  it('оролтгүй бол анхдагч утга', () => {
    expect(resolveTextExtractionOptions()).toEqual({
      ...TEXT_EXTRACTION_DEFAULTS,
      ocr: { ...TEXT_EXTRACTION_DEFAULTS.ocr, languages: undefined },
      csv: { ...TEXT_EXTRACTION_DEFAULTS.csv, delimiter: undefined },
    });
  });

  it('хэсэгчилсэн даралт: бусад утга анхдагч хэвээр', () => {
    const o = resolveTextExtractionOptions({ maxBytes: 1000, ocrFallback: true, pdf: { maxPages: 5 }, csv: { delimiter: ';' }, ocr: { languages: ['mon'] } });
    expect(o.maxBytes).toBe(1000);
    expect(o.ocrFallback).toBe(true);
    expect(o.pdf.maxPages).toBe(5);
    expect(o.pdf.cellGapRatio).toBe(TEXT_EXTRACTION_DEFAULTS.pdf.cellGapRatio);
    expect(o.csv.delimiter).toBe(';');
    expect(o.ocr).toMatchObject({ languages: ['mon'], rejectOnWarnings: true });
  });

  it('PDF-ийн maxBytes тусад нь өгөөгүй бол нийт maxBytes-ийг дагана', () => {
    expect(resolveTextExtractionOptions({ maxBytes: 5000 }).pdf.maxBytes).toBe(5000);
    expect(resolveTextExtractionOptions({ maxBytes: 5000, pdf: { maxBytes: 100 } }).pdf.maxBytes).toBe(100);
  });

  it.each([
    [{ maxBytes: 0 }],
    [{ maxBytes: -1 }],
    [{ maxBytes: Number.NaN }],
    [{ maxBytes: Number.POSITIVE_INFINITY }],
    [{ pdf: { maxPages: 0 } }],
    [{ pdf: { cellGapRatio: -0.1 } }],
    [{ pdf: { lineToleranceRatio: 11 } }],
    [{ ocr: { cellGapCharWidths: 0 } }],
    [{ csv: { cp1251Dominance: 1.5 } }],
    [{ csv: { sniffRecords: 0 } }],
    [{ csv: { delimiter: ':' as never } }],
  ])('буруу тохиргоо %j → Error (эхлэхэд унана)', (bad) => {
    expect(() => resolveTextExtractionOptions(bad)).toThrow(/text-extraction/);
  });
});
