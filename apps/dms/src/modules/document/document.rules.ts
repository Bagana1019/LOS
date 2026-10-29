// FR-9.1 dms `document`-ийн цэвэр дүрмүүд (I/O байхгүй): түлхүүр нормчлол, холбоосын шалгалт, OCR төрөл сонгох.
import type { CreateDocumentRequest, DocumentRelatedEntity } from '@los/contracts';
import type { OcrDocType } from '@los/ocr';

/** Баримтын төрөл (`type`) ба checklist түлхүүрийн (`checklistKey`) уртын дээд хязгаар — `CreateDocumentRequest`-тэй ижил. */
export const MAX_TYPE_LENGTH = 100;
export const MAX_KEY_LENGTH = 60;

/**
 * Түлхүүрийг харьцуулахад тогтвортой хэлбэрт оруулна: зай тайрах → NFC → жижиг үсэг → дотоод хоосон зай `_`.
 * Checklist-ийн түлхүүр бол танигч (`id_card`) тул том/жижиг үсгийн зөрүү өөр түлхүүр болохгүй.
 * origination `document-checklist.ts`-ийн `normalizeKey`-тэй ИЖИЛ байх ёстой (хоёр сервис тусдаа тул хуулбар).
 */
export function normalizeKey(raw: string): string {
  return raw.trim().normalize('NFC').toLowerCase().replace(/\s+/g, '_');
}

/**
 * DEMO: OCR-ийн баримтын төрлийг checklist-ийн түлхүүрээр сонгоно. Түлхүүрүүд нь seed-ийн бүтээгдэхүүний checklist-ийнх
 * (`apps/origination/prisma/seed.ts`); бусад түлхүүр, түлхүүргүй баримт нь GENERIC. Төрөл нэмэх бол энэ ганц хүснэгтийг засна.
 */
export const OCR_DOC_TYPE_BY_CHECKLIST_KEY: Readonly<Record<string, OcrDocType>> = {
  id_card: 'ID_CARD',
  salary_statement: 'SALARY_CERTIFICATE',
};

export function ocrDocTypeFor(checklistKey: string | null | undefined): OcrDocType {
  const key = checklistKey ? normalizeKey(checklistKey) : '';
  return Object.prototype.hasOwnProperty.call(OCR_DOC_TYPE_BY_CHECKLIST_KEY, key) ? OCR_DOC_TYPE_BY_CHECKLIST_KEY[key]! : 'GENERIC';
}

export interface NormalizedDocumentInput {
  applicationId: string;
  type: string;
  checklistKey: string | null;
  relatedEntity: DocumentRelatedEntity;
  relatedId: string | null;
  note: string | null;
  fileId: string;
}

/** Дүрмийн зөрчил: `code` тогтвортой, `message` монгол. status 422 (утгын алдаа). */
export interface DocumentViolation { code: string; message: string }

/** `COLLATERAL`/`BORROWER` холбоос `relatedId` заавал; `APPLICATION` нь `relatedId`-гүй. Нормчилсон утга эсвэл зөрчил буцаана. */
export function normalizeCreate(input: CreateDocumentRequest): NormalizedDocumentInput | DocumentViolation {
  const type = normalizeKey(input.type);
  const checklistKey = input.checklistKey === undefined ? null : normalizeKey(input.checklistKey);
  // toLowerCase зарим тэмдэгтийг уртасгаж болох тул нормчилсны дараа дахин шалгана
  if (!type || type.length > MAX_TYPE_LENGTH) return { code: 'DOCUMENT_TYPE_INVALID', message: `Баримтын төрөл 1–${MAX_TYPE_LENGTH} тэмдэгт байх ёстой` };
  if (checklistKey !== null && (!checklistKey || checklistKey.length > MAX_KEY_LENGTH)) return { code: 'CHECKLIST_KEY_INVALID', message: `Checklist-ийн түлхүүр 1–${MAX_KEY_LENGTH} тэмдэгт байх ёстой` };
  const relatedId = input.relatedId?.trim() || null;
  if (input.relatedEntity !== 'APPLICATION' && !relatedId)
    return { code: 'RELATED_ID_REQUIRED', message: `"${input.relatedEntity === 'BORROWER' ? 'Зээлдэгч' : 'Барьцаа'}" холбоостой баримтад холбогдох бичлэгийн ID заавал` };
  if (input.relatedEntity === 'APPLICATION' && relatedId) return { code: 'RELATED_ID_NOT_ALLOWED', message: 'Хүсэлтийн түвшний баримтад холбогдох бичлэгийн ID өгөхгүй' };
  return { applicationId: input.applicationId, type, checklistKey, relatedEntity: input.relatedEntity, relatedId, note: input.note ?? null, fileId: input.fileId };
}

export const isViolation = (v: NormalizedDocumentInput | DocumentViolation): v is DocumentViolation => 'code' in v;

/** Prisma `id` нь String тул хэлбэрийг урьдчилж шалгаад буруу бол DB-д хүрэхгүйгээр 404. */
export const DOCUMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
