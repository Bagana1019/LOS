// MIME тодорхойлолт (NFR-7: гар утаснаас зураг). Клиентийн Content-Type-д итгэхгүй — файлын эхний байтаар (magic bytes) шалгана.
import { OCR_IMAGE_MIME_TYPES, OCR_PDF_MIME_TYPE } from './types';

export type OcrSupportedMime = (typeof OCR_IMAGE_MIME_TYPES)[number] | typeof OCR_PDF_MIME_TYPE;

const SUPPORTED: ReadonlySet<string> = new Set<string>([...OCR_IMAGE_MIME_TYPES, OCR_PDF_MIME_TYPE]);
const MIME_ALIASES: Readonly<Record<string, OcrSupportedMime>> = { 'image/jpg': 'image/jpeg', 'image/pjpeg': 'image/jpeg', 'image/tif': 'image/tiff' };

/** Файлын өргөтгөл (ТЕМП файлд; клиентийн файлын нэрийг хэзээ ч ашиглахгүй) */
export const OCR_MIME_EXTENSIONS: Readonly<Record<OcrSupportedMime, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/tiff': 'tif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

/** Content-Type толгойг (параметртэй байж болно) дэмжигдэх MIME болгоно; үгүй бол null. */
export function normalizeOcrMime(mime: string | undefined | null): OcrSupportedMime | null {
  if (typeof mime !== 'string') return null;
  const base = mime.split(';')[0].trim().toLowerCase();
  const canonical = MIME_ALIASES[base] ?? base;
  return SUPPORTED.has(canonical) ? (canonical as OcrSupportedMime) : null;
}

const startsWith = (buf: Buffer, bytes: readonly number[], offset = 0): boolean =>
  buf.length >= offset + bytes.length && bytes.every((b, i) => buf[offset + i] === b);

/**
 * Magic bytes-аар төрөл тодорхойлно: PNG, JPEG, TIFF (II*\0 / MM\0*), WebP (RIFF....WEBP), PDF (%PDF-). Танигдаагүй бол null.
 * PDF: заавал файлын эхэнд `%PDF-` (спецификаци эхний 1024 байтыг зөвшөөрдөг ч эхлэлийн өмнөх хог өгөгдөл нь polyglot эрсдэл).
 */
export function detectOcrMime(content: Buffer): OcrSupportedMime | null {
  if (!Buffer.isBuffer(content)) return null;
  if (startsWith(content, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(content, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(content, [0x49, 0x49, 0x2a, 0x00]) || startsWith(content, [0x4d, 0x4d, 0x00, 0x2a])) return 'image/tiff';
  if (startsWith(content, [0x52, 0x49, 0x46, 0x46]) && startsWith(content, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  if (startsWith(content, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  return null;
}
