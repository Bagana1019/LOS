import type { ApplicationDocumentsResponse, DocumentChecklistStatus, DocumentOcrCheck, DocumentView } from '@los/contracts';

// Тестийн өгөгдлийн жишээ (vitest + Playwright e2e). Зөвхөн `@los/contracts`-ийн төрөл.

export const DOC_APP_ID = '0a1b2c3d-1111-4a11-8a11-000000000001';
export const DOC_NOW = '2026-10-29T03:00:00.000Z';

export const makeDocument = (overrides: Partial<DocumentView> = {}): DocumentView => ({
  id: '0a1b2c3d-7777-4a77-8a77-000000000001',
  applicationId: DOC_APP_ID,
  type: 'id_card',
  relatedEntity: 'APPLICATION',
  relatedId: null,
  note: null,
  fileId: '0a1b2c3d-4444-4a44-8a44-000000000001',
  fileName: 'id-front.pdf',
  mime: 'application/pdf',
  size: 2048,
  checklistKey: 'id_card',
  uploadedBy: 'officer.a',
  uploadedAt: DOC_NOW,
  ...overrides,
});

export const makeRow = (overrides: Partial<DocumentChecklistStatus> & { key: string }): DocumentChecklistStatus => {
  const documents = overrides.documents ?? [];
  return { name: overrides.key, required: true, satisfied: documents.length > 0, documents, ...overrides };
};

/** Checklist мөрүүдээс хариуг угсарна (`summary`-г мөрүүдээс тооцно — зөвхөн тестийн туслах). */
export const makeDocumentsResponse = (rows: DocumentChecklistStatus[], extras: DocumentView[] = [], productMissing = false): ApplicationDocumentsResponse => {
  const required = rows.filter((r) => r.required);
  const missing = required.filter((r) => !r.satisfied).map((r) => r.key);
  const items = [...rows.flatMap((r) => r.documents), ...extras];
  return {
    items,
    checklist: rows,
    extras,
    summary: { productMissing, required: required.length, satisfied: required.length - missing.length, complete: !productMissing && missing.length === 0, missing },
  };
};

export const makeOcr = (overrides: Partial<DocumentOcrCheck> = {}): DocumentOcrCheck => ({
  documentId: '0a1b2c3d-7777-4a77-8a77-000000000001',
  verdict: 'MATCH',
  docType: 'ID_CARD',
  registerMasked: 'УБ****5678',
  confidence: 0.93,
  warnings: [],
  checkedAt: DOC_NOW,
  ...overrides,
});
