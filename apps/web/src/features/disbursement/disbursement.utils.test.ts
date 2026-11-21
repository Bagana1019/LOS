import { describe, expect, it } from 'vitest';
import type { DisbursementView } from '@los/contracts';
import { collapseHistory, historyLabel, lastRejection, termsFlags } from './disbursement.utils';

type H = DisbursementView['history'][number];
const h = (action: string, at: string, note: string | null = null, by: string | null = 'u-1'): H => ({ at, by, action, note });

// F5-9: 16 удаа "Ноорог хадгалах" → түүхэнд 16 ижил мөр шуугиан болдог байсан; монгол label; татгалзсан шалтгаан тод харагдах.
describe('collapseHistory', () => {
  it('merges consecutive DRAFT_UPDATED rows into one row with the latest timestamp and a count', () => {
    const rows = collapseHistory([h('DRAFT_UPDATED', '2026-12-01T01:00:00Z'), h('DRAFT_UPDATED', '2026-12-01T02:00:00Z'), h('DRAFT_UPDATED', '2026-12-01T03:00:00Z')]);
    expect(rows).toEqual([{ at: '2026-12-01T03:00:00Z', by: 'u-1', action: 'DRAFT_UPDATED', note: null, count: 3 }]);
  });

  it('keeps every other action as its own row, and does not merge DRAFT_UPDATED runs separated by another action', () => {
    const rows = collapseHistory([h('DRAFT_UPDATED', 'a'), h('DRAFT_UPDATED', 'b'), h('SUBMITTED', 'c'), h('REJECTED', 'd', 'Данс буруу'), h('DRAFT_UPDATED', 'e')]);
    expect(rows.map((r) => [r.action, r.count])).toEqual([['DRAFT_UPDATED', 2], ['SUBMITTED', 1], ['REJECTED', 1], ['DRAFT_UPDATED', 1]]);
    expect(rows[2]!.note).toBe('Данс буруу');
  });

  it('does not merge repeated non-draft actions (each submit / rejection is a real event)', () => {
    expect(collapseHistory([h('SUBMITTED', 'a'), h('SUBMITTED', 'b')]).map((r) => r.count)).toEqual([1, 1]);
  });

  it('returns an empty list for an empty history and does not mutate its input', () => {
    expect(collapseHistory([])).toEqual([]);
    const input = [h('DRAFT_UPDATED', 'a'), h('DRAFT_UPDATED', 'b')];
    const snapshot = JSON.stringify(input);
    collapseHistory(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe('lastRejection', () => {
  it('returns the latest REJECTED entry while the request is back in DRAFT', () => {
    const history = [h('SUBMITTED', 'a'), h('REJECTED', 'b', 'Эхний шалтгаан'), h('SUBMITTED', 'c'), h('REJECTED', 'd', 'Хоёр дахь шалтгаан'), h('DRAFT_UPDATED', 'e')];
    expect(lastRejection('DRAFT', history)?.note).toBe('Хоёр дахь шалтгаан');
  });

  it('is null when the request is no longer a draft (resubmitted / approved) or was never rejected', () => {
    const rejected = [h('SUBMITTED', 'a'), h('REJECTED', 'b', 'Шалтгаан'), h('SUBMITTED', 'c')];
    expect(lastRejection('SUBMITTED', rejected)).toBeNull();
    expect(lastRejection('DRAFT', [h('DRAFT_UPDATED', 'a')])).toBeNull();
    expect(lastRejection('DRAFT', [])).toBeNull();
  });
});

describe('historyLabel', () => {
  it('gives every action the server writes a Mongolian label', () => {
    for (const a of ['DRAFT_UPDATED', 'SUBMITTED', 'APPROVED', 'APPROVE_RETRY', 'REJECTED', 'CORE_SETTLING', 'CORE_UNKNOWN', 'CORE_FAILED', 'SENT_TO_CORE']) {
      expect(historyLabel(a)).not.toBe(a);
      expect(historyLabel(a)).not.toMatch(/^disb\./);
    }
  });
  it('falls back to the raw code for an action the UI does not know (never an empty label)', () => {
    expect(historyLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });
});

describe('termsFlags', () => {
  it('flags an amount that differs from the approved one (the "5 ₮ instead of 5,000,000 ₮" case)', () => {
    expect(termsFlags({ disburseAmount: 5, approvedAmount: 5_000_000, accountOwnerType: 'SELF' })).toEqual({ amountDiffers: true, thirdParty: false });
  });
  it('does not flag an equal amount, nor an amount that is not entered yet (0)', () => {
    expect(termsFlags({ disburseAmount: 5_000_000, approvedAmount: 5_000_000, accountOwnerType: 'SELF' }).amountDiffers).toBe(false);
    expect(termsFlags({ disburseAmount: 0, approvedAmount: 5_000_000, accountOwnerType: null }).amountDiffers).toBe(false);
  });
  it('ignores sub-kopeck float noise', () => {
    expect(termsFlags({ disburseAmount: 100.004, approvedAmount: 100, accountOwnerType: 'SELF' }).amountDiffers).toBe(false);
  });
  it('flags a third-party account only', () => {
    expect(termsFlags({ disburseAmount: 1, approvedAmount: 1, accountOwnerType: 'THIRD_PARTY' }).thirdParty).toBe(true);
    expect(termsFlags({ disburseAmount: 1, approvedAmount: 1, accountOwnerType: 'SELF' }).thirdParty).toBe(false);
    expect(termsFlags({ disburseAmount: 1, approvedAmount: 1, accountOwnerType: null }).thirdParty).toBe(false);
  });
});
