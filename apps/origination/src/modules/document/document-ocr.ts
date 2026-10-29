import type { DocumentOcrCheck } from '@los/contracts';
import { blindIndex, maskRegisterNo, normalizeRegisterNo } from '@los/database';
import type { DmsOcrOutcome, DmsOcrUnreadableReason } from './dms-documents.port';

// Цэвэр тулгалт (I/O байхгүй): иргэний үнэмлэхийн OCR-ийн регистрийг зээлдэгчийн регистртэй харьцуулна.
// Дүгнэлт нь зөвлөмж — хүн баталгаажуулна (`DocumentOcrCheck`). Түүхий регистрийг буцаахгүй, логлохгүй, хадгалахгүй.

export type RegisterVerdict = Extract<DocumentOcrCheck['verdict'], 'MATCH' | 'MISMATCH' | 'UNREADABLE'>;

/** Хоёр регистрийг `normalizeRegisterNo` + blind index (HMAC) тэнцэлээр харьцуулна. Уншигдаагүй (хоосон) бол UNREADABLE. */
export function compareRegisterNo(expectedRegisterNo: string, readRegisterNo: string | null | undefined): RegisterVerdict {
  const read = readRegisterNo ? normalizeRegisterNo(readRegisterNo) : '';
  if (!read) return 'UNREADABLE';
  return blindIndex(normalizeRegisterNo(expectedRegisterNo)) === blindIndex(read) ? 'MATCH' : 'MISMATCH';
}

export const OCR_MESSAGES = {
  UNSUPPORTED_FILE: 'Файлын төрөл OCR-д тохирохгүй байна (PNG, JPEG, TIFF, WebP, PDF зөвшөөрнө) - гараар шалгана уу',
  NO_TEXT: 'Файлаас текст уншигдсангүй - гараар шалгана уу',
  FILE_TOO_LARGE: 'Файл OCR-д хэт том байна - гараар шалгана уу',
  INVALID_FILE: 'Файл буруу эсвэл унших боломжгүй байна - гараар шалгана уу',
  NO_REGISTER: 'Үнэмлэхээс регистрийн дугаар уншигдсангүй - гараар шалгана уу',
  MISMATCH: 'Үнэмлэхний регистр зээлдэгчийн регистртэй таарахгүй байна - гараар шалгана уу',
} as const satisfies Record<DmsOcrUnreadableReason | 'NO_REGISTER' | 'MISMATCH', string>;

export type OcrEvaluation = Pick<DocumentOcrCheck, 'verdict' | 'docType' | 'registerMasked' | 'confidence' | 'warnings'>;

/**
 * OCR-ийн үр дүнг (dms) зээлдэгчийн регистртэй тулгана.
 *  - файл уншигдаагүй → UNREADABLE (шалтгаан warnings-д);
 *  - регистр олдоогүй → UNREADABLE;
 *  - тэнцүү → MATCH, бусад → MISMATCH (+ анхааруулга).
 * `registerMasked` нь зөвхөн OCR-аар уншсан регистрийн далдлагдсан хэлбэр (УБ****5678); OCR-ийн анхааруулгад регистр орсон бол хасна.
 */
export function evaluateIdCardOcr(expectedRegisterNo: string, outcome: DmsOcrOutcome): OcrEvaluation {
  if (!outcome.readable) return { verdict: 'UNREADABLE', docType: null, registerMasked: null, confidence: null, warnings: [OCR_MESSAGES[outcome.reason]] };
  const { ocr } = outcome;
  const read = ocr.registerNo ? normalizeRegisterNo(ocr.registerNo) : '';
  const engineWarnings = ocr.warnings.filter((w) => !read || !normalizeRegisterNo(w).includes(read));
  const verdict = compareRegisterNo(expectedRegisterNo, ocr.registerNo);
  if (verdict === 'UNREADABLE') return { verdict, docType: ocr.docType, registerMasked: null, confidence: null, warnings: [...engineWarnings, OCR_MESSAGES.NO_REGISTER] };
  return {
    verdict,
    docType: ocr.docType,
    registerMasked: maskRegisterNo(read),
    confidence: ocr.registerConfidence ?? ocr.meanConfidence,
    warnings: verdict === 'MISMATCH' ? [...engineWarnings, OCR_MESSAGES.MISMATCH] : engineWarnings,
  };
}
