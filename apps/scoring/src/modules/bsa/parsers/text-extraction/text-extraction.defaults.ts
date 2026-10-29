// text-extraction-ийн анхдагч утгууд — НЭГ газар (CLAUDE.md §6.2). Бизнесийн босго БИШ: файлын хязгаар, геометрийн heuristic.
// TODO(samples): геометрийн босго (cellGapRatio, cellGapCharWidths) нь жинхэнэ банкны PDF/скан хуулгаар тохируулагдаагүй.
// Дарах: StatementTextService-ийн TEXT_EXTRACTION_OPTIONS (TextExtractionModule.register({ options })).
import type { CsvDelimiter, TextExtractionOptions, TextExtractionOptionsInput } from './types';

/** 20 MiB — @los/ocr-ийн OCR_DEFAULTS.maxInputBytes-тэй нэгдмэл */
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

export const TEXT_EXTRACTION_DEFAULTS: TextExtractionOptions = {
  maxBytes: DEFAULT_MAX_BYTES,
  ocrFallback: false,
  pdf: {
    // NFR-1: 6 сар ≈ 2,500 гүйлгээ ≈ 60-70 хуудас; нөөцтэй
    maxPages: 200,
    maxBytes: DEFAULT_MAX_BYTES,
    minAvgCharsPerPage: 30,
    lineToleranceRatio: 0.5,
    wordGapRatio: 0.15,
    // 2 зай (Helvetica) ≈ 0.56 × өндөр; үүнээс арай их зайг багана гэж үзнэ
    cellGapRatio: 0.65,
    overdrawRatio: 0.2,
  },
  ocr: {
    // Tesseract-ийн үгийн хайрцгийн завсар ≈ 0.5 em (≈ 0.9 үсгийн өргөн); багана ≥ 0.8 em. Синтетик зургаар тохируулсан (TODO(samples))
    cellGapCharWidths: 1.2,
    cellGapLineHeights: 0.6,
    rejectOnWarnings: true,
  },
  csv: {
    sniffRecords: 50,
    sniffMaxChars: 200_000,
    cp1251Dominance: 0.7,
    remapMongolianCp1251: true,
  },
};

const DELIMITERS: readonly CsvDelimiter[] = [',', ';', '\t', '|'];
export const CSV_DELIMITER_CANDIDATES = DELIMITERS;

function positive(name: string, v: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > max) {
    throw new Error(`text-extraction: ${name} нь 0-ээс их, ${max}-аас ихгүй тоо байх ёстой`);
  }
  return v;
}

/** Анхдагч + дарсан утгыг нэгтгэж, буруу тохиргоог эхлэхэд нь (fail-fast) Error-оор шиднэ. */
export function resolveTextExtractionOptions(input: TextExtractionOptionsInput = {}): TextExtractionOptions {
  const d = TEXT_EXTRACTION_DEFAULTS;
  const pdf = { ...d.pdf, ...input.pdf };
  const ocr = { ...d.ocr, ...input.ocr };
  const csv = { ...d.csv, ...input.csv };
  const maxBytes = input.maxBytes ?? d.maxBytes;
  if (csv.delimiter !== undefined && !DELIMITERS.includes(csv.delimiter)) {
    throw new Error('text-extraction: csv.delimiter нь , ; TAB | -ийн нэг байх ёстой');
  }
  if (csv.cp1251Dominance > 1) throw new Error('text-extraction: csv.cp1251Dominance нь 0..1 байх ёстой');
  return {
    maxBytes: positive('maxBytes', maxBytes),
    ocrFallback: input.ocrFallback ?? d.ocrFallback,
    pdf: {
      // PDF-ийн maxBytes: тусад нь өгөөгүй бол service-ийн нийт хязгаартай нэгдүүлнэ
      maxBytes: positive('pdf.maxBytes', input.pdf?.maxBytes ?? maxBytes),
      maxPages: positive('pdf.maxPages', pdf.maxPages, 100_000),
      minAvgCharsPerPage: positive('pdf.minAvgCharsPerPage', pdf.minAvgCharsPerPage),
      lineToleranceRatio: positive('pdf.lineToleranceRatio', pdf.lineToleranceRatio, 10),
      wordGapRatio: positive('pdf.wordGapRatio', pdf.wordGapRatio, 10),
      cellGapRatio: positive('pdf.cellGapRatio', pdf.cellGapRatio, 20),
      overdrawRatio: positive('pdf.overdrawRatio', pdf.overdrawRatio, 10),
    },
    ocr: {
      cellGapCharWidths: positive('ocr.cellGapCharWidths', ocr.cellGapCharWidths, 50),
      cellGapLineHeights: positive('ocr.cellGapLineHeights', ocr.cellGapLineHeights, 50),
      rejectOnWarnings: ocr.rejectOnWarnings,
      languages: ocr.languages,
    },
    csv: {
      delimiter: csv.delimiter,
      sniffRecords: positive('csv.sniffRecords', csv.sniffRecords, 100_000),
      sniffMaxChars: positive('csv.sniffMaxChars', csv.sniffMaxChars),
      cp1251Dominance: positive('csv.cp1251Dominance', csv.cp1251Dominance, 1),
      remapMongolianCp1251: csv.remapMongolianCp1251,
    },
  };
}
