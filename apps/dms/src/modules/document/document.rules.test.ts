import { describe, expect, it } from 'vitest';
import type { CreateDocumentRequest } from '@los/contracts';
import { DOCUMENT_ID, isViolation, normalizeCreate, normalizeKey, ocrDocTypeFor } from './document.rules';

const APP = '33333333-3333-4333-8333-333333333333';
const FILE = '22222222-2222-4222-8222-222222222222';
const base = (o: Partial<CreateDocumentRequest> = {}): CreateDocumentRequest => ({ applicationId: APP, type: 'id_card', relatedEntity: 'APPLICATION', fileId: FILE, ...o });

describe('normalizeKey', () => {
  it('trims, lowercases, NFC-normalises and joins inner whitespace with "_"', () => {
    expect(normalizeKey('  ID_Card ')).toBe('id_card');
    expect(normalizeKey('Salary   Statement')).toBe('salary_statement');
    expect(normalizeKey('Иргэний\tҮнэмлэх')).toBe('иргэний_үнэмлэх');
    expect(normalizeKey('é')).toBe('é'); // decomposed é → composed
  });
  it('is idempotent', () => {
    for (const s of ['ID_Card', ' a b ', 'Бизнесийн гэрчилгээ']) expect(normalizeKey(normalizeKey(s))).toBe(normalizeKey(s));
  });
});

describe('ocrDocTypeFor (checklist key → OCR document type)', () => {
  it('maps the known keys, case-insensitively, and defaults to GENERIC', () => {
    expect(ocrDocTypeFor('id_card')).toBe('ID_CARD');
    expect(ocrDocTypeFor(' ID_CARD ')).toBe('ID_CARD');
    expect(ocrDocTypeFor('salary_statement')).toBe('SALARY_CERTIFICATE');
    expect(ocrDocTypeFor('business_license')).toBe('GENERIC');
    expect(ocrDocTypeFor(null)).toBe('GENERIC');
    expect(ocrDocTypeFor(undefined)).toBe('GENERIC');
    expect(ocrDocTypeFor('')).toBe('GENERIC');
  });
  it('does not treat Object.prototype names as known keys', () => {
    for (const k of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) expect(ocrDocTypeFor(k)).toBe('GENERIC');
  });
});

describe('normalizeCreate (FR-9.1)', () => {
  it('normalises type and checklistKey, keeps the note, defaults optional parts to null', () => {
    const out = normalizeCreate(base({ type: ' Other ', checklistKey: ' ID_Card ', note: 'Тэмдэглэл' }));
    expect(isViolation(out)).toBe(false);
    expect(out).toEqual({ applicationId: APP, type: 'other', checklistKey: 'id_card', relatedEntity: 'APPLICATION', relatedId: null, note: 'Тэмдэглэл', fileId: FILE });
    expect(normalizeCreate(base())).toMatchObject({ checklistKey: null, note: null, relatedId: null });
  });

  it('BORROWER and COLLATERAL require a relatedId', () => {
    for (const relatedEntity of ['BORROWER', 'COLLATERAL'] as const) {
      expect(normalizeCreate(base({ relatedEntity }))).toMatchObject({ code: 'RELATED_ID_REQUIRED' });
      expect(normalizeCreate(base({ relatedEntity, relatedId: '   ' }))).toMatchObject({ code: 'RELATED_ID_REQUIRED' });
      expect(normalizeCreate(base({ relatedEntity, relatedId: ' c-1 ' }))).toMatchObject({ relatedEntity, relatedId: 'c-1' });
    }
  });

  it('APPLICATION must not carry a relatedId', () => {
    expect(normalizeCreate(base({ relatedId: 'c-1' }))).toMatchObject({ code: 'RELATED_ID_NOT_ALLOWED' });
  });

  it('re-validates the length after normalisation (lower-casing can lengthen some characters)', () => {
    // "İ".toLowerCase() === "i̇" (2 code units): 60 × "İ" fits the DTO limit but not once lower-cased
    const long = 'İ'.repeat(60);
    expect(normalizeCreate(base({ checklistKey: long }))).toMatchObject({ code: 'CHECKLIST_KEY_INVALID' });
    expect(normalizeCreate(base({ type: 'İ'.repeat(100) }))).toMatchObject({ code: 'DOCUMENT_TYPE_INVALID' });
  });
});

describe('DOCUMENT_ID', () => {
  it('accepts UUIDs only', () => {
    expect(DOCUMENT_ID.test(APP)).toBe(true);
    for (const s of ['', 'x', `${APP}x`, '../etc', `${APP}\n`]) expect(DOCUMENT_ID.test(s)).toBe(false);
  });
});
