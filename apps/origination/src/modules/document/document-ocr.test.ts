import { describe, expect, it } from 'vitest';
import { DocumentOcrCheck } from '@los/contracts';
import { OCR_MESSAGES, compareRegisterNo, evaluateIdCardOcr } from './document-ocr';
import { readableOcr } from './testing/fake-dms-documents';
import type { DmsOcrOutcome, DmsOcrUnreadableReason } from './dms-documents.port';

const REG = 'УБ90000001';

describe('compareRegisterNo', () => {
  it('MATCH after normalisation (case, spaces, separators, Latin look-alikes)', () => {
    expect(compareRegisterNo(REG, 'УБ90000001')).toBe('MATCH');
    expect(compareRegisterNo(REG, ' уб 9000-0001 ')).toBe('MATCH');
    expect(compareRegisterNo('УБ90000001', 'YБ90000001')).toBe('MATCH'); // латин Y ≡ кирилл У
  });
  it('MISMATCH on any different digit or letter', () => {
    expect(compareRegisterNo(REG, 'УБ90000002')).toBe('MISMATCH');
    expect(compareRegisterNo(REG, 'ЖЮ90000001')).toBe('MISMATCH');
    expect(compareRegisterNo(REG, '90000001')).toBe('MISMATCH');
  });
  it('UNREADABLE when nothing (or only noise) was read', () => {
    for (const none of [null, undefined, '', '   ', '---', '...']) expect(compareRegisterNo(REG, none as string | null)).toBe('UNREADABLE');
  });
});

describe('evaluateIdCardOcr', () => {
  it('MATCH: masked read register, confidence, engine warnings kept', () => {
    const out = evaluateIdCardOcr(REG, readableOcr('d-1', { registerNo: REG, registerConfidence: 0.88, warnings: ['expiryDate: үнэмлэхний хүчинтэй хугацаа дууссан байна'] }));
    expect(out).toEqual({ verdict: 'MATCH', docType: 'ID_CARD', registerMasked: 'УБ****0001', confidence: 0.88, warnings: ['expiryDate: үнэмлэхний хүчинтэй хугацаа дууссан байна'] });
  });

  it('MISMATCH adds an advisory warning; the mask shows only the OCR-read register', () => {
    const out = evaluateIdCardOcr(REG, readableOcr('d-1', { registerNo: 'УБ91112222' }));
    expect(out.verdict).toBe('MISMATCH');
    expect(out.registerMasked).toBe('УБ****2222');
    expect(out.warnings).toEqual([OCR_MESSAGES.MISMATCH]);
    expect(JSON.stringify(out)).not.toContain(REG);
    expect(JSON.stringify(out)).not.toContain('91112222');
  });

  it('no register read → UNREADABLE with a reason; confidence/mask are null', () => {
    const out = evaluateIdCardOcr(REG, readableOcr('d-1', { registerNo: null, registerConfidence: null }));
    expect(out).toEqual({ verdict: 'UNREADABLE', docType: 'ID_CARD', registerMasked: null, confidence: null, warnings: [OCR_MESSAGES.NO_REGISTER] });
  });

  it('falls back to the mean OCR confidence when the register field has none', () => {
    expect(evaluateIdCardOcr(REG, readableOcr('d-1', { registerNo: REG, registerConfidence: null, meanConfidence: 0.71 })).confidence).toBe(0.71);
  });

  it.each(['UNSUPPORTED_FILE', 'NO_TEXT', 'FILE_TOO_LARGE', 'INVALID_FILE'] as DmsOcrUnreadableReason[])('file not readable (%s) → UNREADABLE with a Mongolian reason', (reason) => {
    const out = evaluateIdCardOcr(REG, { readable: false, reason });
    expect(out).toEqual({ verdict: 'UNREADABLE', docType: null, registerMasked: null, confidence: null, warnings: [OCR_MESSAGES[reason]] });
    expect(out.warnings[0]).toMatch(/[а-яөү]/i);
  });

  it('drops an engine warning that happens to contain the register (defence in depth)', () => {
    const out = evaluateIdCardOcr(REG, readableOcr('d-1', { registerNo: REG, warnings: [`registerNo ${REG} буруу`, 'gender: зөрж байна'] }));
    expect(out.warnings).toEqual(['gender: зөрж байна']);
  });

  it('every outcome satisfies the contract schema', () => {
    const outcomes: DmsOcrOutcome[] = [readableOcr('d', { registerNo: REG }), readableOcr('d', { registerNo: null }), readableOcr('d', { registerNo: 'ЖЮ85061512' }), { readable: false, reason: 'NO_TEXT' }];
    for (const o of outcomes) {
      expect(() => DocumentOcrCheck.parse({ documentId: 'd', ...evaluateIdCardOcr(REG, o), checkedAt: '2026-10-29T01:00:00.000Z' })).not.toThrow();
    }
  });
});
