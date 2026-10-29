import { describe, expect, it } from 'vitest';
import { AttachDocumentRequest, CreateDocumentRequest, DocumentListQuery, ProductDocumentChecklist } from './document';

const FILE = '22222222-2222-4222-8222-222222222222';
const APP = '33333333-3333-4333-8333-333333333333';

describe('document DTOs (FR-9)', () => {
  it('the seeded product checklist shape parses; required defaults to true', () => {
    const items = ProductDocumentChecklist.parse([{ key: 'id_card', name: 'Иргэний үнэмлэхний хуулбар', required: true }, { key: 'photo', name: 'Зураг' }]);
    expect(items.map((i) => i.required)).toEqual([true, true]);
  });
  it('AttachDocumentRequest needs a type or a checklist key', () => {
    expect(AttachDocumentRequest.parse({ fileId: FILE, checklistKey: 'id_card' }).relatedEntity).toBe('APPLICATION');
    expect(AttachDocumentRequest.parse({ fileId: FILE, type: 'other', note: 'Нэмэлт' }).type).toBe('other');
    expect(() => AttachDocumentRequest.parse({ fileId: FILE })).toThrow(/төрөл/);
    expect(() => AttachDocumentRequest.parse({ fileId: 'x', checklistKey: 'id_card' })).toThrow();
  });
  it('CreateDocumentRequest (dms internal) validates ids and defaults the related entity', () => {
    expect(CreateDocumentRequest.parse({ applicationId: APP, type: 'id_card', fileId: FILE }).relatedEntity).toBe('APPLICATION');
    expect(() => CreateDocumentRequest.parse({ applicationId: 'nope', type: 'id_card', fileId: FILE })).toThrow();
  });
  it('DocumentListQuery', () => {
    expect(DocumentListQuery.parse({ applicationId: APP, relatedEntity: 'BORROWER', relatedId: 'abc' }).relatedEntity).toBe('BORROWER');
  });
});
