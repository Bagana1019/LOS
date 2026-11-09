import { describe, expect, it } from 'vitest';
import { hasMessage } from '../../lib/i18n';
import { isLoanTab, LOAN_TABS, loanPaymentsHref } from './loans.utils';

describe('зээлийн жагсаалт', () => {
  it('таб бүр монгол нэртэй, зөвхөн олгогдсон төлөв', () => {
    expect(LOAN_TABS).toEqual(['ACTIVE', 'MIGRATED', 'CLOSED']);
    for (const s of LOAN_TABS) expect(hasMessage(`status.${s}`), s).toBe(true);
    for (const k of ['loan.list.title', 'loan.list.subtitle', 'loan.list.empty', 'loan.list.error', 'loan.col.contractNo', 'loan.col.decidedAt', 'loan.action.payments', 'loan.action.card']) expect(hasMessage(k), k).toBe(true);
  });
  it('isLoanTab ба холбоос', () => {
    expect(isLoanTab('ACTIVE')).toBe(true);
    expect(isLoanTab('DRAFT')).toBe(false);
    expect(isLoanTab(null)).toBe(false);
    expect(loanPaymentsHref('a/b')).toBe('/los/loan/a%2Fb/payments');
  });
});
