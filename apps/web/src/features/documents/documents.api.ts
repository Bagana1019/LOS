import {
  ApplicationDocumentMutationResponse, ApplicationDocumentsResponse, DocumentOcrCheck,
  type AttachDocumentRequest,
} from '@los/contracts';
import { originationFetch } from '../../lib/api';

// Gateway-ийн замаар origination руу: `/api/origination/applications/:aid/documents…` (docs/05 §3.2). Файлын байршуулалт/татаалт нь shared/files.ts (dms).
const base = (applicationId: string): string => `/applications/${encodeURIComponent(applicationId)}/documents`;

export const fetchDocuments = (applicationId: string): Promise<ApplicationDocumentsResponse> =>
  originationFetch(base(applicationId), { schema: ApplicationDocumentsResponse });

/** Хавсаргах. `fileId` нь dms-д аль хэдийн байршуулсан файл. */
export const attachDocument = (applicationId: string, body: AttachDocumentRequest): Promise<ApplicationDocumentMutationResponse> =>
  originationFetch(base(applicationId), { method: 'POST', json: body, schema: ApplicationDocumentMutationResponse });

export const removeDocument = (applicationId: string, documentId: string): Promise<ApplicationDocumentMutationResponse> =>
  originationFetch(`${base(applicationId)}/${encodeURIComponent(documentId)}`, { method: 'DELETE', schema: ApplicationDocumentMutationResponse });

/** Иргэний үнэмлэхийн регистрийг OCR-оор зээлдэгчтэй тулгана. Зөвлөмж; хадгалагдахгүй. */
export const ocrCheckDocument = (applicationId: string, documentId: string): Promise<DocumentOcrCheck> =>
  originationFetch(`${base(applicationId)}/${encodeURIComponent(documentId)}/ocr`, { method: 'POST', schema: DocumentOcrCheck });
