import { describe, expect, it } from 'vitest';
import { ApplicationDocumentsResponse, type DocumentView } from '@los/contracts';
import { buildApplicationDocuments, findChecklistItem, normalizeKey, parseProductChecklist, planDocumentStep, sameDocuments } from './document-checklist';

const CHECKLIST = [
  { key: 'id_card', name: 'Иргэний үнэмлэхний хуулбар', required: true },
  { key: 'salary_statement', name: 'Цалингийн тодорхойлолт', required: true },
  { key: 'application_form', name: 'Зээлийн хүсэлтийн маягт', required: true },
];

let n = 0;
const doc = (checklistKey: string | null, o: Partial<DocumentView> = {}): DocumentView => ({
  id: `d-${++n}`, applicationId: 'app-1', type: checklistKey ?? 'other', relatedEntity: 'APPLICATION', relatedId: null, note: null, fileId: `f-${n}`, fileName: 'a.pdf', mime: 'application/pdf', size: 10,
  checklistKey, uploadedBy: 'u-1', uploadedAt: '2026-10-29T01:00:00.000Z', ...o,
});

describe('normalizeKey', () => {
  it('trims, NFC-normalises, lowercases and joins whitespace with "_" (same as dms)', () => {
    expect(normalizeKey('  ID Card ')).toBe('id_card');
    expect(normalizeKey('ID_CARD')).toBe('id_card');
    expect(normalizeKey('Иргэний  Үнэмлэх')).toBe('иргэний_үнэмлэх');
  });
});

describe('parseProductChecklist (FR-9.2)', () => {
  it('parses the seeded shape; required defaults to true', () => {
    expect(parseProductChecklist(CHECKLIST)).toEqual({ items: CHECKLIST, invalid: false });
    expect(parseProductChecklist([{ key: 'photo', name: 'Зураг' }]).items).toEqual([{ key: 'photo', name: 'Зураг', required: true }]);
    expect(parseProductChecklist([]).items).toEqual([]);
  });
  it('missing (null / undefined) → empty checklist, not flagged as invalid', () => {
    expect(parseProductChecklist(null)).toEqual({ items: [], invalid: false });
    expect(parseProductChecklist(undefined)).toEqual({ items: [], invalid: false });
  });
  it('invalid JSON shapes → empty checklist, flagged invalid', () => {
    for (const bad of ['id_card', 42, true, {}, { key: 'a', name: 'A' }, [{ key: '', name: 'A' }], [{ key: 'a' }], [{ key: 'a', name: 'A', required: 'yes' }], [null], [1], [{ key: 'ok', name: 'OK' }, { nope: 1 }]]) {
      expect(parseProductChecklist(bad), JSON.stringify(bad)).toEqual({ items: [], invalid: true });
    }
  });
  it('drops a repeated key (compared normalised), first one wins', () => {
    const out = parseProductChecklist([{ key: 'id_card', name: 'A' }, { key: 'ID_CARD', name: 'B', required: false }, { key: 'x', name: 'X' }]);
    expect(out.items.map((i) => i.name)).toEqual(['A', 'X']);
  });
});

describe('findChecklistItem', () => {
  it('matches case/space-insensitively and returns the product item (canonical key)', () => {
    const list = parseProductChecklist([{ key: 'Id_Card', name: 'A' }]).items;
    expect(findChecklistItem(list, ' id card ')?.key).toBe('Id_Card');
    expect(findChecklistItem(list, 'nope')).toBeUndefined();
    expect(findChecklistItem([], 'id_card')).toBeUndefined();
  });
});

describe('buildApplicationDocuments', () => {
  const build = (documents: DocumentView[], o: { productPresent?: boolean; checklist?: typeof CHECKLIST } = {}) =>
    buildApplicationDocuments({ productPresent: o.productPresent ?? true, checklist: o.checklist ?? CHECKLIST.map((c) => ({ ...c })), documents });

  it('AC (docs/04 M9): 3 types, 2 uploaded → incomplete; the 3rd → complete', () => {
    const two = build([doc('id_card'), doc('salary_statement')]);
    expect(two.summary).toEqual({ productMissing: false, required: 3, satisfied: 2, complete: false, missing: ['application_form'] });
    expect(two.checklist.map((c) => c.satisfied)).toEqual([true, true, false]);
    const three = build([doc('id_card'), doc('salary_statement'), doc('application_form')]);
    expect(three.summary).toEqual({ productMissing: false, required: 3, satisfied: 3, complete: true, missing: [] });
  });

  it('removing one of three makes it incomplete again', () => {
    const docs = [doc('id_card'), doc('salary_statement'), doc('application_form')];
    expect(build(docs).summary.complete).toBe(true);
    const afterRemove = build(docs.filter((d) => d.checklistKey !== 'salary_statement'));
    expect(afterRemove.summary).toMatchObject({ complete: false, satisfied: 2, missing: ['salary_statement'] });
  });

  it('several documents under one key are all listed; the key is satisfied once', () => {
    const a = doc('id_card');
    const b = doc('id_card', { relatedEntity: 'BORROWER', relatedId: 'cust-2' });
    const out = build([a, b]);
    expect(out.checklist[0]).toMatchObject({ key: 'id_card', satisfied: true });
    expect(out.checklist[0]!.documents.map((d) => d.id)).toEqual([a.id, b.id]);
    expect(out.summary).toMatchObject({ required: 3, satisfied: 1 });
  });

  it('extras: documents without a key or with a key outside the checklist; items has everything in order', () => {
    const idCard = doc('id_card');
    const other = doc(null, { type: 'other' });
    const foreign = doc('old_key');
    const out = build([other, idCard, foreign]);
    expect(out.extras.map((d) => d.id)).toEqual([other.id, foreign.id]);
    expect(out.items.map((d) => d.id)).toEqual([other.id, idCard.id, foreign.id]);
    expect(out.checklist[0]!.documents).toEqual([idCard]);
    expect(out.summary.complete).toBe(false);
  });

  it('matches keys normalised: a stored lower-case key satisfies an upper-case product key', () => {
    const out = build([doc('id_card')], { checklist: [{ key: 'ID_CARD', name: 'A', required: true }] });
    expect(out.checklist[0]).toMatchObject({ key: 'ID_CARD', satisfied: true });
    expect(out.summary).toMatchObject({ complete: true, missing: [] });
  });

  it('optional items never block completion but show their documents', () => {
    const checklist = [{ key: 'a', name: 'A', required: true }, { key: 'b', name: 'B', required: false }];
    const out = build([doc('a')], { checklist });
    expect(out.summary).toEqual({ productMissing: false, required: 1, satisfied: 1, complete: true, missing: [] });
    expect(out.checklist[1]).toMatchObject({ key: 'b', required: false, satisfied: false });
    expect(build([doc('a'), doc('b')], { checklist }).checklist[1]!.satisfied).toBe(true);
  });

  it('product present with an empty checklist: nothing required → complete (vacuous)', () => {
    expect(build([], { checklist: [] }).summary).toEqual({ productMissing: false, required: 0, satisfied: 0, complete: true, missing: [] });
  });

  it('product missing: empty checklist, productMissing, never complete — every document is an extra', () => {
    const d = doc('id_card');
    const out = build([d], { productPresent: false });
    expect(out.checklist).toEqual([]);
    expect(out.extras).toEqual([d]);
    expect(out.summary).toEqual({ productMissing: true, required: 0, satisfied: 0, complete: false, missing: [] });
  });

  it('collateral documents belong to the collateral checklist: not in items, checklist or extras', () => {
    const collateral = doc('id_card', { relatedEntity: 'COLLATERAL', relatedId: 'col-1' });
    const out = build([collateral, doc('id_card')]);
    expect(out.items).toHaveLength(1);
    expect(out.extras).toHaveLength(0);
    expect(out.checklist[0]!.documents).toHaveLength(1);
  });

  it('a borrower document counts for its key (any document under the key satisfies it)', () => {
    const out = build([doc('id_card', { relatedEntity: 'BORROWER', relatedId: 'cust-9' })]);
    expect(out.checklist[0]!.satisfied).toBe(true);
  });

  it('result conforms to the contract schema (empty and full)', () => {
    expect(() => ApplicationDocumentsResponse.parse(build([]))).not.toThrow();
    expect(() => ApplicationDocumentsResponse.parse(build([doc('id_card'), doc(null)]))).not.toThrow();
  });
});

describe('planDocumentStep (step `document`)', () => {
  const NOW = new Date('2026-10-29T03:00:00Z');
  it('complete: PENDING/STALE → COMPLETED with completed_at; already COMPLETED → no change', () => {
    expect(planDocumentStep({ id: 's', status: 'PENDING' }, true, NOW)).toEqual({ id: 's', status: 'COMPLETED', staleReason: null, completedAt: NOW });
    expect(planDocumentStep({ id: 's', status: 'STALE' }, true, NOW)).toMatchObject({ status: 'COMPLETED', completedAt: NOW });
    expect(planDocumentStep({ id: 's', status: 'COMPLETED' }, true, NOW)).toBeNull();
  });
  it('incomplete: COMPLETED/STALE → PENDING with completed_at cleared; already PENDING → no change', () => {
    expect(planDocumentStep({ id: 's', status: 'COMPLETED' }, false, NOW)).toEqual({ id: 's', status: 'PENDING', staleReason: null, completedAt: null });
    expect(planDocumentStep({ id: 's', status: 'STALE' }, false, NOW)).toMatchObject({ status: 'PENDING' });
    expect(planDocumentStep({ id: 's', status: 'PENDING' }, false, NOW)).toBeNull();
  });
  it('never touches a LOCKED step, and a missing step row is skipped', () => {
    expect(planDocumentStep({ id: 's', status: 'LOCKED' }, true, NOW)).toBeNull();
    expect(planDocumentStep({ id: 's', status: 'LOCKED' }, false, NOW)).toBeNull();
    expect(planDocumentStep(null, true, NOW)).toBeNull();
    expect(planDocumentStep(undefined, false, NOW)).toBeNull();
  });
});

describe('sameDocuments', () => {
  it('compares by id + key + link, ignoring order', () => {
    const a = doc('id_card');
    const b = doc('salary_statement');
    expect(sameDocuments([a, b], [b, a])).toBe(true);
    expect(sameDocuments([a], [a, b])).toBe(false);
    expect(sameDocuments([a], [{ ...a, checklistKey: 'x' }])).toBe(false);
    expect(sameDocuments([], [])).toBe(true);
    expect(sameDocuments([a], [doc('id_card')])).toBe(false);
  });
});
