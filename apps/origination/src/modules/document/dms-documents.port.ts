import { z } from 'zod';
import type { CreateDocumentRequest, DocumentListQuery, DocumentView, RequestContext } from '@los/contracts';

// origination → dms sync REST (CLAUDE.md §3.2.2): dms-ийн `document` API-ийн порт. Бодит нь `HttpDmsDocuments`; e2e тест `testing/fake-dms-documents.ts`.
// Байгууллага (X-Org-Id), хэрэглэгч, эрх, correlationId нь ctx-ээс толгойгоор дамжина — body/query-д orgId байхгүй.

/**
 * dms `POST /documents/:id/ocr` хариуны ЗӨВХӨН бидэнд хэрэгтэй хэсэг. Бусад талбар (нэр, төрсөн огноо, …) zod-оор хаягдана —
 * регистрээс бусад хувийн мэдээлэл origination-д хадгалагдахгүй, дамжихгүй.
 */
export const DmsDocumentOcr = z
  .object({
    documentId: z.string(),
    docType: z.string(),
    warnings: z.array(z.string()).default([]),
    fields: z.object({ registerNo: z.object({ value: z.unknown(), confidence: z.number() }).optional() }).default({}),
    ocr: z.object({ meanConfidence: z.number() }),
  })
  .transform((r) => {
    const reg = r.fields.registerNo;
    return {
      documentId: r.documentId,
      docType: r.docType,
      warnings: r.warnings,
      /** OCR-аар уншсан түүхий регистр (зөвхөн тулгалтад; лог/хариунд гаргахгүй). */
      registerNo: typeof reg?.value === 'string' && reg.value.trim() ? reg.value : null,
      registerConfidence: reg ? Math.min(1, Math.max(0, reg.confidence)) : null,
      meanConfidence: Math.min(1, Math.max(0, r.ocr.meanConfidence)),
    };
  });
export type DmsDocumentOcr = z.infer<typeof DmsDocumentOcr>;

/** OCR файлыг уншиж чадаагүй шалтгаан (dms 4xx) — алдаа биш, `UNREADABLE` дүгнэлт болно. */
export type DmsOcrUnreadableReason = 'UNSUPPORTED_FILE' | 'NO_TEXT' | 'FILE_TOO_LARGE' | 'INVALID_FILE';
export type DmsOcrOutcome = { readable: true; ocr: DmsDocumentOcr } | { readable: false; reason: DmsOcrUnreadableReason };

export interface DmsDocumentsPort {
  /** `fileId` олдохгүй (өөр байгууллага, устгагдсан) бол 422 `FILE_NOT_FOUND`. */
  create(request: CreateDocumentRequest, ctx: RequestContext): Promise<DocumentView>;
  /** Оруулсан цагаар өсөхөөр (хуучин нь эхэнд). */
  list(query: DocumentListQuery, ctx: RequestContext): Promise<DocumentView[]>;
  /** `true` — устгасан; `false` — аль хэдийн байхгүй (зэрэг устгал) тул идемпотент. */
  remove(documentId: string, ctx: RequestContext): Promise<boolean>;
  /** Баримтыг OCR-д өгнө. Үр дүнг хадгалахгүй. Файл уншигдахгүй бол `readable: false`; dms унасан/завгүй бол алдаа шиднэ. */
  ocr(documentId: string, ctx: RequestContext): Promise<DmsOcrOutcome>;
}
export const DMS_DOCUMENTS = Symbol('DMS_DOCUMENTS');
