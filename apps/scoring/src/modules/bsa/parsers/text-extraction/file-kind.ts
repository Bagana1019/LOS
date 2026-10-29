// Файлын төрөл тодорхойлох. БИТ (magic bytes) ЭХЭНД, дараа нь MIME, дараа нь өргөтгөл. Клиентийн MIME-д ганцаараа итгэхгүй:
// MIME/өргөтгөл нь зөвхөн агуулга нь ТЕКСТ болох үед CSV/TEXT-ийг ялгахад л нөлөөлнө; PDF/зураг/XLSX нь зөвхөн бит-ээр.
import { detectOcrMime } from '@los/ocr';

export type FileKind = 'PDF' | 'IMAGE' | 'CSV' | 'TEXT' | 'XLSX' | 'UNKNOWN';

export interface FileKindInput {
  fileName: string;
  mimeType?: string;
  content: Buffer;
}

export interface FileInspection {
  kind: FileKind;
  /** Агуулгаас гарсан каноник MIME (клиентийнхийг давтахгүй). UNKNOWN үед 'application/octet-stream' */
  mimeType: string;
}

const MIME_PDF = 'application/pdf';
const MIME_CSV = 'text/csv';
const MIME_TEXT = 'text/plain';
const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MIME_XLS = 'application/vnd.ms-excel';
const MIME_UNKNOWN = 'application/octet-stream';

const CSV_MIMES: ReadonlySet<string> = new Set([
  MIME_CSV, 'text/x-csv', 'application/csv', 'text/comma-separated-values', 'text/tab-separated-values', MIME_XLS,
]);
const CSV_EXTS: ReadonlySet<string> = new Set(['csv', 'tsv']);
const TEXT_EXTS: ReadonlySet<string> = new Set(['txt', 'text']);

/** Хоёртын эсэхийг шалгахад харах эхний байтын тоо */
const TEXT_SNIFF_BYTES = 8192;
/** Удирдлагын тэмдэгтийн (TAB/LF/CR/FF-ээс бусад) эзлэх хувь энээс их бол хоёртын файл */
const TEXT_MAX_CONTROL_RATIO = 0.02;

const startsWith = (buf: Buffer, bytes: readonly number[]): boolean => buf.length >= bytes.length && bytes.every((b, i) => buf[i] === b);

const baseMime = (mime: string | undefined): string => (typeof mime === 'string' ? mime.split(';')[0].trim().toLowerCase() : '');

function extensionOf(fileName: string): string {
  const base = typeof fileName === 'string' ? fileName.split(/[\\/]/).pop() ?? '' : '';
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1).trim().toLowerCase() : '';
}

/** BOM-той Unicode, эсвэл NUL-гүй, удирдлагын тэмдэгт цөөн агуулга = текст (UTF-8, windows-1251 орно). */
export function looksLikeText(content: Buffer): boolean {
  if (content.length === 0) return false;
  if (startsWith(content, [0xef, 0xbb, 0xbf]) || startsWith(content, [0xff, 0xfe]) || startsWith(content, [0xfe, 0xff])) return true;
  const n = Math.min(content.length, TEXT_SNIFF_BYTES);
  let control = 0;
  for (let i = 0; i < n; i++) {
    const b = content[i];
    if (b === 0) return false;
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c) control++;
  }
  return control / n <= TEXT_MAX_CONTROL_RATIO;
}

/** FileKind + каноник MIME. Хоосон агуулга UNKNOWN (EMPTY-г service өмнө нь шалгана). */
export function inspectFile(input: FileKindInput): FileInspection {
  const { content } = input;
  if (!Buffer.isBuffer(content) || content.length === 0) return { kind: 'UNKNOWN', mimeType: MIME_UNKNOWN };

  // 1) Бит (magic bytes): PDF (%PDF- файлын эхэнд), PNG, JPEG, TIFF, WEBP — @los/ocr-тэй ижил тодорхойлолт
  const magic = detectOcrMime(content);
  if (magic === MIME_PDF) return { kind: 'PDF', mimeType: MIME_PDF };
  if (magic) return { kind: 'IMAGE', mimeType: magic };
  // PK\x03\x04 / PK\x05\x06 (zip) → XLSX (docx/zip ч мөн энд орно: бүгд "Excel/багц файл дэмжигдэхгүй")
  if (startsWith(content, [0x50, 0x4b, 0x03, 0x04]) || startsWith(content, [0x50, 0x4b, 0x05, 0x06])) {
    return { kind: 'XLSX', mimeType: MIME_XLSX };
  }
  const ext = extensionOf(input.fileName);
  // OLE2 (хуучин .xls) — зөвхөн өргөтгөл нь xls үед хүснэгт гэж үзнэ (.doc ч мөн OLE2)
  if (startsWith(content, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) && ext === 'xls') return { kind: 'XLSX', mimeType: MIME_XLS };

  // 2) Бит танигдаагүй: зөвхөн ТЕКСТ агуулгыг MIME/өргөтгөлөөр CSV | TEXT гэж ялгана. Хоёртын хог бол MIME/өргөтгөл ямар ч байсан UNKNOWN.
  if (!looksLikeText(content)) return { kind: 'UNKNOWN', mimeType: MIME_UNKNOWN };
  const mime = baseMime(input.mimeType);
  if (CSV_MIMES.has(mime)) return { kind: 'CSV', mimeType: MIME_CSV };
  if (mime === MIME_TEXT) return CSV_EXTS.has(ext) ? { kind: 'CSV', mimeType: MIME_CSV } : { kind: 'TEXT', mimeType: MIME_TEXT };
  // 3) MIME ерөнхий/хоосон/агуулгатай зөрчилтэй: өргөтгөл
  if (CSV_EXTS.has(ext)) return { kind: 'CSV', mimeType: MIME_CSV };
  if (TEXT_EXTS.has(ext)) return { kind: 'TEXT', mimeType: MIME_TEXT };
  return { kind: 'UNKNOWN', mimeType: MIME_UNKNOWN };
}

export function detectFileKind(input: FileKindInput): FileKind {
  return inspectFile(input).kind;
}
