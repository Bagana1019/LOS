import { describe, expect, it } from 'vitest';
import { DocumentOcrVerdict } from '@los/contracts';
import { hasMessage } from '../../lib/i18n';
import { makeBorrower, IDS } from '../collateral/collateral.fixtures';
import { makeDocument } from './documents.fixtures';
import {
  attachNoteError, borrowerOptionLabel, borrowerOptions, buildAttachRequest, isIdCardRow, OCR_VERDICT_TONE, ocrAdviceKey, ocrVerdictKey, ocrWarningText, relatedLabel, summaryState,
} from './documents.utils';

const FILE = IDS.file;

describe('OCR', () => {
  it('зөвхөн id_card мөрөнд OCR', () => {
    expect(isIdCardRow('id_card')).toBe(true);
    expect(isIdCardRow('income_proof')).toBe(false);
    expect(isIdCardRow(null)).toBe(false);
    expect(isIdCardRow(undefined)).toBe(false);
  });
  it.each(DocumentOcrVerdict.map((v) => [v]))('%s: дүгнэлт, зөвлөмж орчуулгатай, өнгөтэй', (verdict) => {
    expect(hasMessage(ocrVerdictKey(verdict))).toBe(true);
    expect(hasMessage(ocrAdviceKey(verdict))).toBe(true);
    expect(OCR_VERDICT_TONE[verdict]).toBeDefined();
  });
  it('MISMATCH алдаа, MATCH амжилт, UNREADABLE анхааруулга', () => {
    expect(OCR_VERDICT_TONE).toEqual({ MATCH: 'success', MISMATCH: 'error', UNREADABLE: 'warning', NOT_APPLICABLE: 'default' });
  });
  it('анхааруулга: монгол бол хэвээр, англи бол нийтлэг тайлбар', () => {
    expect(ocrWarningText('Зураг бүдэг байна')).toBe('Зураг бүдэг байна');
    expect(ocrWarningText('low image quality')).toBe('OCR анхааруулга гарсан — баримтыг гараар шалгана уу.');
    expect(ocrWarningText('low quality, e.g. УБ')).toBe('OCR анхааруулга гарсан — баримтыг гараар шалгана уу.');
  });
});

describe('оролцогчид', () => {
  const primary = makeBorrower();
  const guarantor = makeBorrower({ id: 'b2', customerId: IDS.guarantor, role: 'GUARANTOR', isPrimary: false, name: 'Дорж Батаа' });
  const guarantorPledgor = makeBorrower({ id: 'b3', customerId: IDS.guarantor, role: 'PLEDGOR', isPrimary: false, name: 'Дорж Батаа' });

  it('харилцагчаар нэгтгэнэ', () => {
    const options = borrowerOptions([primary, guarantor, guarantorPledgor]);
    expect(options).toEqual([
      { customerId: IDS.owner, name: 'Бат Болд', registerMasked: 'УБ******78', roles: ['PRIMARY'] },
      { customerId: IDS.guarantor, name: 'Дорж Батаа', registerMasked: 'УБ******78', roles: ['GUARANTOR', 'PLEDGOR'] },
    ]);
  });
  it('шошго: нэр · далдлагдсан регистр · дүрүүд', () => {
    const [first, second] = borrowerOptions([primary, guarantor, guarantorPledgor]);
    expect(borrowerOptionLabel(first!)).toBe('Бат Болд · УБ******78 · Үндсэн зээлдэгч');
    expect(borrowerOptionLabel(second!)).toBe('Дорж Батаа · УБ******78 · Батлан даагч, Барьцаалагч');
  });
  it('relatedLabel', () => {
    const options = borrowerOptions([primary]);
    expect(relatedLabel(makeDocument({ relatedEntity: 'BORROWER', relatedId: IDS.owner }), options)).toBe('Зээлдэгч: Бат Болд');
    expect(relatedLabel(makeDocument({ relatedEntity: 'BORROWER', relatedId: 'unknown' }), options)).toBe('Зээлдэгч');
    expect(relatedLabel(makeDocument({ relatedEntity: 'COLLATERAL', relatedId: 'c1' }), options)).toBe('Барьцаа');
    expect(relatedLabel(makeDocument({ relatedEntity: 'APPLICATION' }), options)).toBeNull();
  });
});

describe('attachNoteError', () => {
  it('нэмэлт баримтад тайлбар заавал; checklist мөрөнд шаардахгүй', () => {
    expect(attachNoteError({ kind: 'extra' }, undefined)).toBe('Нэмэлт баримтад тайлбар заавал бичнэ');
    expect(attachNoteError({ kind: 'extra' }, '  ')).toBe('Нэмэлт баримтад тайлбар заавал бичнэ');
    expect(attachNoteError({ kind: 'extra' }, 'Зураг')).toBeNull();
    expect(attachNoteError({ kind: 'checklist', key: 'id_card', name: 'x' }, undefined)).toBeNull();
  });
});

describe('buildAttachRequest', () => {
  const row = { kind: 'checklist' as const, key: 'id_card', name: 'Иргэний үнэмлэх' };

  it('checklist мөр: checklistKey, хүсэлтэд холбоно', () => {
    expect(buildAttachRequest({ target: row, fileId: FILE })).toEqual({ ok: true, body: { fileId: FILE, checklistKey: 'id_card', relatedEntity: 'APPLICATION' } });
  });
  it('зээлдэгчид холбох', () => {
    const r = buildAttachRequest({ target: row, fileId: FILE, borrowerId: IDS.owner, note: ' урд тал ' });
    expect(r).toEqual({ ok: true, body: { fileId: FILE, checklistKey: 'id_card', relatedEntity: 'BORROWER', relatedId: IDS.owner, note: 'урд тал' } });
  });
  it('нэмэлт баримт: type other + тайлбар заавал', () => {
    expect(buildAttachRequest({ target: { kind: 'extra' }, fileId: FILE })).toEqual({ ok: false, field: 'note', message: 'Нэмэлт баримтад тайлбар заавал бичнэ' });
    expect(buildAttachRequest({ target: { kind: 'extra' }, fileId: FILE, note: '   ' }).ok).toBe(false);
    expect(buildAttachRequest({ target: { kind: 'extra' }, fileId: FILE, note: 'Тодорхойлолт' })).toEqual({ ok: true, body: { fileId: FILE, type: 'other', relatedEntity: 'APPLICATION', note: 'Тодорхойлолт' } });
  });
  it('файлын id буруу бол «file» талбарт', () => {
    const r = buildAttachRequest({ target: row, fileId: 'not-a-uuid' });
    expect(r).toMatchObject({ ok: false, field: 'file' });
  });
});

describe('summaryState', () => {
  const s = { productMissing: false, required: 3, satisfied: 3, complete: true, missing: [] as string[] };
  it('төлөвүүд', () => {
    expect(summaryState(s)).toBe('complete');
    expect(summaryState({ ...s, satisfied: 2, complete: false, missing: ['a'] })).toBe('incomplete');
    expect(summaryState({ ...s, required: 0, satisfied: 0 })).toBe('noRequired');
    expect(summaryState({ ...s, productMissing: true })).toBe('productMissing');
  });
});
