// text-extraction-ийн нийтлэг төрлүүд. Гэрээ (StatementText) нь ../statement.types.ts-д; энд зөвхөн дотоод төрөл, сонголт.
import type { PdfMetadata, StatementTextPage, StatementTextSource } from '../statement.types';

/** StatementTextService.extract-ийн оролт. Файлын агуулгыг л үнэмшинэ — mimeType/fileName зөвхөн сул hint (file-kind.ts). */
export interface ExtractInput {
  fileName: string;
  /** Клиентийн заасан Content-Type (итгэхгүй) */
  mimeType?: string;
  content: Buffer;
}

/** Extractor бүрийн гаралт; service үүнийг StatementFileMeta-тай нийлүүлж StatementText болгоно. */
export interface ExtractedText {
  source: StatementTextSource;
  pages: StatementTextPage[];
  /** PDF файл (скан хэлбэртэй байсан ч) бол metadata — BSA-FR-2.3 */
  pdf?: PdfMetadata;
  ocr?: { engine: string; meanConfidence: number };
}

/** PDF text item-ээс мөр/нүд барих геометрийн босго. Бүгд үсгийн өндөрт (font height) харьцангуй. */
export interface PdfLayoutOptions {
  /** Хоёр item ижил мөрөнд орох босоо зөрүү = ratio × min(өндөр) */
  lineToleranceRatio: number;
  /** Зай ≤ ratio × өндөр бол үсгүүд залгагдсан (зай нэмэхгүй) */
  wordGapRatio: number;
  /** Зай > ratio × өндөр бол шинэ нүд (багана) */
  cellGapRatio: number;
  /** Ижил текстийг давхар зурсан (хуурамч bold) item-ийг нэгэн мөр гэж үзэх зөрүү = ratio × өндөр */
  overdrawRatio: number;
}

export interface PdfTextOptions extends PdfLayoutOptions {
  /** Хуудасны дээд тоо; хэтэрвэл TOO_LARGE (чимээгүй таслахгүй — гүйлгээ алдагдана) */
  maxPages: number;
  /** Файлын дээд хэмжээ (байт); service мөн шалгана */
  maxBytes: number;
  /** Хуудас тутмын нийт хоосон бус тэмдэгтийн дундаж энээс бага бол text layer байхгүй гэж үзнэ */
  minAvgCharsPerPage: number;
}

export interface OcrLayoutOptions {
  /** Үгсийн зай > k × (мөрийн үсгийн медиан өргөн) бол шинэ нүд */
  cellGapCharWidths: number;
  /** Мөн > k × (мөрийн хайрцгийн өндөр) бол шинэ нүд (хоёуланг нь давсан үед л тасална) */
  cellGapLineHeights: number;
}

export interface OcrTextOptions extends OcrLayoutOptions {
  /** true: OcrResult.warnings (жишээ: хуудас таслагдсан) байвал дутуу уншсан гэж OCR_FAILED */
  rejectOnWarnings: boolean;
  /** OcrProvider-т дамжуулах хэл (анхдагч: provider-ийн өөрийн анхдагч) */
  languages?: string[];
}

export type CsvDelimiter = ',' | ';' | '\t' | '|';

export interface CsvTextOptions {
  /** Заавал зааж өгвөл auto-detect-ийг алгасна */
  delimiter?: CsvDelimiter;
  /** Delimiter таних үед шалгах бичлэгийн тоо */
  sniffRecords: number;
  /** Delimiter таних үед уншиж үзэх дээд тэмдэгт */
  sniffMaxChars: number;
  /** UTF-8 буруу үед кирилл үсгийн байт (0xC0-0xFF + Ё/Є/Ї-ийн байр)-ын эзлэх хувь ≥ энэ бол windows-1251 */
  cp1251Dominance: number;
  /** windows-1251 үед Є/є/Ї/ї → Ө/ө/Ү/ү (монгол кирилл) — TODO(samples) баталгаажаагүй */
  remapMongolianCp1251: boolean;
}

export interface TextExtractionOptions {
  /** Файлын дээд хэмжээ (байт) */
  maxBytes: number;
  /** true: text layer-гүй PDF-ийг OCR_PROVIDER-ээр уншина (удаан, нарийвчлал доогуур) */
  ocrFallback: boolean;
  pdf: PdfTextOptions;
  ocr: OcrTextOptions;
  csv: CsvTextOptions;
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
export type TextExtractionOptionsInput = DeepPartial<TextExtractionOptions>;
