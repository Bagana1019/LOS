import { describe, expect, it } from 'vitest';
import type { BsaCombinedSummary, BsaSummary } from '@los/contracts';
import { buildLosSummary, paymentChanged } from './bsa.rules';

const pushed: BsaSummary = {
  analysisId: 'a1', loanApplicationId: 'app', borrowerId: 'b1', status: 'ANALYZED', version: 2, periodMonths: 6, periodFrom: '2026-03-10', periodTo: '2026-09-10', transactionCount: 100,
  totalMonthlyIncome: 3_000_000, verifiedMonthlyIncome: 2_000_000, dtiIncome: 1_800_000, businessIncomeMonthly: 1_000_000, businessExpenseMonthly: 200_000, netCashFlowMonthly: 800_000,
  existingDebtServiceMonthly: 100_000, incomeReliability: 70, dtiPercent: 20, dtiLevel: 'LOW', pendingSuspiciousCount: 1, reportPdfUrl: null,
};
const combined = (o: Partial<BsaCombinedSummary> = {}): BsaCombinedSummary => ({
  applicationId: 'app', analysisCount: 2, allAnalyzed: true, dtiIncome: 4_000_000, existingDebtServiceMonthly: 400_000, businessIncomeMonthly: 3_000_000, businessExpenseMonthly: 700_000,
  netCashFlowMonthly: 2_300_000, incomeReliability: 60, pendingSuspiciousCount: 3, dtiLevel: 'MEDIUM', dtiPercent: 25, members: [], ...o,
});

describe('buildLosSummary (INT-4 / BSA-BR-9)', () => {
  it('санхүүгийн утгыг нэгтгэлээс, хугацаа/хувилбарыг татсан шинжилгээнээс авна', () => {
    const s = buildLosSummary(pushed, combined(), ['w'], new Date('2026-11-03T00:00:00Z'), '/pdf');
    expect(s).toMatchObject({ analysisId: 'a1', version: 2, periodMonths: 6, dtiIncome: 4_000_000, existingDebtServiceMonthly: 400_000, dtiPercent: 25, dtiLevel: 'MEDIUM', pendingSuspiciousCount: 3, combined: true, status: 'ANALYZED', reportPdfUrl: '/pdf', warnings: ['w'] });
    expect(s.pushedAt).toBe('2026-11-03T00:00:00.000Z');
  });
  it('нэг гишүүн → combined=false; бүгд ANALYZED биш → DRAFT (DTI-г Модуль 8 ашиглахгүй)', () => {
    expect(buildLosSummary(pushed, combined({ analysisCount: 1 }), [], new Date(), null).combined).toBe(false);
    expect(buildLosSummary(pushed, combined({ allAnalyzed: false }), [], new Date(), null).status).toBe('DRAFT');
  });
  it('paymentChanged: null эсвэл ≥1₮ зөрүү', () => {
    expect(paymentChanged(null, 1)).toBe(true);
    expect(paymentChanged(undefined, 1)).toBe(true);
    expect(paymentChanged(100.4, 100)).toBe(false);
    expect(paymentChanged(100, 101)).toBe(true);
  });
});
