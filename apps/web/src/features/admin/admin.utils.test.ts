import { describe, expect, it } from 'vitest';
import { parseJsonInput, previewContractNo, validateBranchCodes } from './admin.utils';

describe('previewContractNo (BR-11)', () => {
  it('docs/01 жишээ B10026021501', () => {
    expect(previewContractNo('{PREFIX}{BRANCH}{YYMMDD}{SEQ:2}', 'B', '100', new Date(2026, 1, 15), 1)).toBe('B10026021501');
  });
  it('SEQ өргөн, олон PREFIX', () => {
    expect(previewContractNo('{PREFIX}-{SEQ:4}/{PREFIX}', 'LN', '', new Date(2026, 0, 1), 7)).toBe('LN-0007/LN');
    expect(previewContractNo('{SEQ}', '', '', new Date(), 12)).toBe('12');
  });
});
describe('parseJsonInput', () => {
  it('зөв / буруу JSON', () => {
    expect(parseJsonInput('0.55')).toEqual({ ok: true, value: 0.55 });
    expect(parseJsonInput('[3,6,12]')).toEqual({ ok: true, value: [3, 6, 12] });
    expect(parseJsonInput('{oops')).toEqual({ ok: false });
  });
});
describe('validateBranchCodes', () => {
  it('зөв, хоосон, давхардсан, буруу тэмдэгт', () => {
    expect(validateBranchCodes({ a: '100', b: '200' })).toBeNull();
    expect(validateBranchCodes({ a: '100', b: '' })).toBeNull();
    expect(validateBranchCodes({ a: 'ab', b: 'AB' })).not.toBeNull();
    expect(validateBranchCodes({ a: 'a-b' })).not.toBeNull();
  });
});
