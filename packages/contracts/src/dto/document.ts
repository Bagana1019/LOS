import { z } from 'zod';
import { DocumentRelatedEntity } from '../enums';

// ── Баримт бичиг (FR-9, 8-р алхам `document`) ───────────────────────────────────────────────────────────────────────────────
// dms нь `document` (файлын холбоос) эзэмшинэ; checklist-ийн тодорхойлолт нь `origination.product.document_checklist_json`, дүгнэлт (алхам PENDING/COMPLETED) origination-д.
// Ажилтан origination `/api/applications/:id/documents`-оор ажиллана; origination → dms `/api/documents` (sync) — ажилтны proxy-оор шууд гаргахгүй.

const text = (max: number) => z.string().trim().min(1).max(max);

/** `product.document_checklist_json` нэг мөр. */
export const DocumentChecklistItem = z.object({ key: text(60), name: text(200), required: z.boolean().default(true) });
export type DocumentChecklistItem = z.infer<typeof DocumentChecklistItem>;
export const ProductDocumentChecklist = z.array(DocumentChecklistItem);
export type ProductDocumentChecklist = z.infer<typeof ProductDocumentChecklist>;

/** Checklist-д ороогүй нэмэлт баримтын төрөл. */
export const DOCUMENT_OTHER_TYPE = 'other';

// ── dms дотоод API ───────────────────────────────────────────────────────────────────────────────────────────────────────────
export const CreateDocumentRequest = z.object({
  applicationId: z.string().uuid(),
  /** Баримтын төрөл: checklist-ийн түлхүүр эсвэл чөлөөт (`other`). */
  type: text(100),
  relatedEntity: z.enum(DocumentRelatedEntity).default('APPLICATION'),
  /** BORROWER → `customer.id`; COLLATERAL → `collateral.id`; APPLICATION → хоосон. */
  relatedId: text(100).optional(),
  note: z.string().trim().min(1).max(1000).optional(),
  fileId: z.string().uuid(),
  checklistKey: text(60).optional(),
});
export type CreateDocumentRequest = z.infer<typeof CreateDocumentRequest>;

export const DocumentListQuery = z.object({
  applicationId: z.string().uuid(),
  relatedEntity: z.enum(DocumentRelatedEntity).optional(),
  relatedId: text(100).optional(),
});
export type DocumentListQuery = z.infer<typeof DocumentListQuery>;

/** FR-9.1: төрөл, холбогдох зүйл, тайлбар, файл; оруулсан огноо, ажилтан автоматаар. */
export const DocumentView = z.object({
  id: z.string(),
  applicationId: z.string(),
  type: z.string(),
  relatedEntity: z.enum(DocumentRelatedEntity),
  relatedId: z.string().nullable(),
  note: z.string().nullable(),
  fileId: z.string(),
  fileName: z.string(),
  mime: z.string(),
  size: z.number().int(),
  checklistKey: z.string().nullable(),
  uploadedBy: z.string().nullable(),
  uploadedAt: z.string().datetime(),
});
export type DocumentView = z.infer<typeof DocumentView>;

export const DocumentListResponse = z.object({ items: z.array(DocumentView) });
export type DocumentListResponse = z.infer<typeof DocumentListResponse>;

// ── origination (ажилтны UI) ────────────────────────────────────────────────────────────────────────────────────────────────
export const AttachDocumentRequest = z
  .object({
    fileId: z.string().uuid(),
    /** Checklist-ийн түлхүүр. Өгвөл `type` анхдагчаар түүнтэй ижил. */
    checklistKey: text(60).optional(),
    type: text(100).optional(),
    relatedEntity: z.enum(DocumentRelatedEntity).default('APPLICATION'),
    relatedId: text(100).optional(),
    note: z.string().trim().min(1).max(1000).optional(),
  })
  .refine((b) => !!(b.checklistKey || b.type), { message: 'Баримтын төрөл эсвэл checklist-ийн түлхүүрийг заана уу', path: ['type'] });
export type AttachDocumentRequest = z.infer<typeof AttachDocumentRequest>;

export const DocumentChecklistStatus = z.object({
  key: z.string(),
  name: z.string(),
  required: z.boolean(),
  satisfied: z.boolean(),
  documents: z.array(DocumentView),
});
export type DocumentChecklistStatus = z.infer<typeof DocumentChecklistStatus>;

export const DocumentSummary = z.object({
  /** Бүтээгдэхүүн (4-р алхам) сонгогдоогүй → checklist тодорхойгүй, алхам PENDING. */
  productMissing: z.boolean(),
  required: z.number().int(),
  satisfied: z.number().int(),
  /** Заавал баримт бүрэн → 8-р алхам COMPLETED (FR-9.2: дутуу бол илгээхийг хориглоно). */
  complete: z.boolean(),
  missing: z.array(z.string()),
});
export type DocumentSummary = z.infer<typeof DocumentSummary>;

export const ApplicationDocumentsResponse = z.object({
  /** Бүх баримт (checklist + нэмэлт). */
  items: z.array(DocumentView),
  checklist: z.array(DocumentChecklistStatus),
  /** Checklist-ийн түлхүүртэй таараагүй нэмэлт баримт. */
  extras: z.array(DocumentView),
  summary: DocumentSummary,
});
export type ApplicationDocumentsResponse = z.infer<typeof ApplicationDocumentsResponse>;

export const ApplicationDocumentMutationResponse = z.object({ document: DocumentView.nullable(), documents: ApplicationDocumentsResponse });
export type ApplicationDocumentMutationResponse = z.infer<typeof ApplicationDocumentMutationResponse>;

// ── OCR-оор баримт шалгах (dms OCR-г дахин ашиглана; үр дүнг хадгалахгүй, регистр далдлагдана) ──────────────────────────────────
export const DocumentOcrVerdict = ['MATCH', 'MISMATCH', 'UNREADABLE', 'NOT_APPLICABLE'] as const;
export type DocumentOcrVerdict = (typeof DocumentOcrVerdict)[number];
/** `POST /applications/:id/documents/:docId/ocr` — иргэний үнэмлэхийн (checklist `id_card`) регистрийг зээлдэгчтэй тулгана. Бусад баримтад NOT_APPLICABLE. OCR үр дүнг хүн шалгаж баталгаажуулна. */
export const DocumentOcrCheck = z.object({
  documentId: z.string(),
  verdict: z.enum(DocumentOcrVerdict),
  docType: z.string().nullable(),
  /** OCR-аар уншсан регистр, зөвхөн далдлагдсан (УБ****5678). */
  registerMasked: z.string().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  warnings: z.array(z.string()),
  checkedAt: z.string().datetime(),
});
export type DocumentOcrCheck = z.infer<typeof DocumentOcrCheck>;
