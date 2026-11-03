import { describe, expect, it } from 'vitest';
import { ContractNumberTemplateBody, ReplaceApprovalLevelsBody, validateApprovalLevels } from './admin';

const L = (levelNo: number, amountFrom: number, amountTo: number | null) => ({ levelNo, amountFrom, amountTo });

describe('validateApprovalLevels (BR-13)', () => {
  it('зөв шатлал', () => {
    expect(validateApprovalLevels([L(1, 0, 5), L(2, 5, 30), L(3, 30, null)])).toBeNull();
    expect(validateApprovalLevels([L(1, 0, null)])).toBeNull();
  });
  it('эрэмбэ хамаарахгүй (levelNo-оор)', () => {
    expect(validateApprovalLevels([L(2, 5, null), L(1, 0, 5)])).toBeNull();
  });
  it.each([
    ['1-ээс эхлээгүй', [L(2, 0, null)]],
    ['0-ээс эхлээгүй', [L(1, 10, null)]],
    ['завсартай', [L(1, 0, 5), L(2, 6, null)]],
    ['давхцсан', [L(1, 0, 5), L(2, 4, null)]],
    ['дунд нь хязгааргүй', [L(1, 0, null), L(2, 5, null)]],
    ['дээд ≤ доод', [L(1, 0, 0), L(2, 0, null)]],
    ['сүүлийнх хязгаартай', [L(1, 0, 5)]],
    ['түвшний дугаар алгассан', [L(1, 0, 5), L(3, 5, null)]],
  ])('%s → алдаа', (_n, ls) => {
    expect(validateApprovalLevels(ls)).toEqual(expect.any(String));
  });
});

describe('DTO schemas', () => {
  it('ReplaceApprovalLevelsBody: SLA > 0, нэр заавал', () => {
    const base = { levelNo: 1, name: 'A', amountFrom: 0, amountTo: null, slaHours: 24, members: [] };
    expect(ReplaceApprovalLevelsBody.safeParse({ levels: [base] }).success).toBe(true);
    expect(ReplaceApprovalLevelsBody.safeParse({ levels: [{ ...base, slaHours: 0 }] }).success).toBe(false);
    expect(ReplaceApprovalLevelsBody.safeParse({ levels: [{ ...base, name: ' ' }] }).success).toBe(false);
    expect(ReplaceApprovalLevelsBody.safeParse({ levels: [] }).success).toBe(false);
  });
  it('ContractNumberTemplateBody: {SEQ} заавал, угтвар зөвхөн үсэг/тоо', () => {
    expect(ContractNumberTemplateBody.safeParse({ pattern: '{PREFIX}{SEQ:3}', prefix: 'B', seqScope: 'DAY' }).success).toBe(true);
    expect(ContractNumberTemplateBody.safeParse({ pattern: '{PREFIX}', prefix: 'B', seqScope: 'DAY' }).success).toBe(false);
    expect(ContractNumberTemplateBody.safeParse({ pattern: '{SEQ}', prefix: 'B-1', seqScope: 'DAY' }).success).toBe(false);
  });
});
