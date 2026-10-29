import { AttachDocumentRequest, type BorrowerView, type DocumentChecklistStatus, type DocumentOcrVerdict, type DocumentView } from '@los/contracts';
import { IDS, makeBorrower, makeBorrowerList } from '../src/features/collateral/collateral.fixtures';
import { DOC_NOW, makeDocument, makeDocumentsResponse, makeOcr, makeRow } from '../src/features/documents/documents.fixtures';
import { installDms } from './collateral-mock';
import type { MockApi, MockReply } from './mock-api';

// Баримтын алхмын e2e: origination `/applications/:aid/documents…` ба dms файл сангийн дуудлагуудыг санах ойн төлөвтэйгөөр дууриана.

export interface DocWorld {
  rows: DocumentChecklistStatus[];
  extras: DocumentView[];
  borrowers: BorrowerView[];
  editable: boolean;
  productMissing: boolean;
  /** `POST …/ocr`-ийн дүгнэлт. */
  ocrVerdict: DocumentOcrVerdict;
  ocrWarnings: string[];
  uploads: Array<{ id: string; name: string }>;
  seq: number;
}

export const CHECKLIST = [
  { key: 'id_card', name: 'Иргэний үнэмлэх', required: true },
  { key: 'income_proof', name: 'Орлогын тодорхойлолт', required: true },
  { key: 'photo', name: 'Цээж зураг', required: false },
] as const;

export function newDocWorld(overrides: Partial<DocWorld> = {}): DocWorld {
  return {
    rows: CHECKLIST.map((r) => makeRow({ key: r.key, name: r.name, required: r.required })),
    extras: [],
    borrowers: [makeBorrower(), makeBorrower({ id: 'b-guarantor', customerId: IDS.guarantor, role: 'GUARANTOR', isPrimary: false, name: 'Дорж Батаа' })],
    editable: true,
    productMissing: false,
    ocrVerdict: 'MATCH',
    ocrWarnings: [],
    uploads: [],
    seq: 0,
    ...overrides,
  };
}

const fail = (status: number, code: string, message: string): MockReply => ({ status, json: { code, message } });

const withState = (w: DocWorld) => makeDocumentsResponse(w.rows, w.extras, w.productMissing);

export function installDocumentsApi(api: MockApi, w: DocWorld): DocWorld {
  api.get('/applications/:aid/borrowers', () => ({ json: makeBorrowerList(w.borrowers, w.editable) }));
  api.get('/applications/:aid/documents', () => ({ json: withState(w) }));

  api.post('/applications/:aid/documents', ({ body }) => {
    if (!w.editable) return fail(409, 'APPLICATION_NOT_EDITABLE', 'Хүсэлт «Шинэ» эсвэл «Буцаасан» төлөвт байх үед л өөрчилнө');
    const parsed = AttachDocumentRequest.safeParse(body);
    if (!parsed.success) return { status: 422, json: { code: 'VALIDATION_FAILED', message: 'Оруулсан мэдээлэл буруу', details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } };
    const d = parsed.data;
    const upload = w.uploads.find((u) => u.id === d.fileId);
    if (!upload) return fail(422, 'FILE_NOT_FOUND', 'Файл олдсонгүй');
    const row = d.checklistKey ? w.rows.find((r) => r.key === d.checklistKey) : undefined;
    if (d.checklistKey && !row) return fail(422, 'UNKNOWN_CHECKLIST_KEY', 'Баримтын checklist-д ийм мөр байхгүй байна');
    const created = makeDocument({
      id: `0a1b2c3d-7777-4a77-8a77-${String(100 + ++w.seq).padStart(12, '0')}`,
      type: d.type ?? d.checklistKey ?? 'other',
      checklistKey: d.checklistKey ?? null,
      relatedEntity: d.relatedEntity,
      relatedId: d.relatedId ?? null,
      note: d.note ?? null,
      fileId: d.fileId,
      fileName: upload.name,
      size: 2048,
      uploadedAt: DOC_NOW,
    });
    if (row) w.rows = w.rows.map((r) => (r.key === row.key ? { ...r, documents: [...r.documents, created], satisfied: true } : r));
    else w.extras = [...w.extras, created];
    return { status: 201, json: { document: created, documents: withState(w) } };
  });

  api.on('DELETE', '/applications/:aid/documents/:docId', ({ params }) => {
    if (!w.editable) return fail(409, 'APPLICATION_NOT_EDITABLE', 'Хүсэлт «Шинэ» эсвэл «Буцаасан» төлөвт байх үед л өөрчилнө');
    const exists = [...w.rows.flatMap((r) => r.documents), ...w.extras].some((d) => d.id === params.docId);
    if (!exists) return fail(404, 'DOCUMENT_NOT_FOUND', 'Баримт олдсонгүй');
    w.rows = w.rows.map((r) => {
      const documents = r.documents.filter((d) => d.id !== params.docId);
      return { ...r, documents, satisfied: documents.length > 0 };
    });
    w.extras = w.extras.filter((d) => d.id !== params.docId);
    return { json: { document: null, documents: withState(w) } };
  });

  api.post('/applications/:aid/documents/:docId/ocr', ({ params }) => ({
    json: makeOcr({ documentId: params.docId!, verdict: w.ocrVerdict, warnings: w.ocrWarnings, registerMasked: w.ocrVerdict === 'UNREADABLE' ? null : 'УБ****5678', confidence: w.ocrVerdict === 'UNREADABLE' ? null : 0.93 }),
  }));

  installDms(api, w.uploads, () => ++w.seq);
  return w;
}
