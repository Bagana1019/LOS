// Ангилал → нэгтгэл → бодит computeBsaDti (@los/calc) → LOS-ын гэрээ. БҮХ ӨГӨГДӨЛ СИНТЕТИК; боломжит дүнг гараар тооцоолж баталгаажуулсан.
// Энэ файл л computeBsaDti-г дууддаг (calc-dti нэгжийн хэрэгжүүлэлтэд хамаарна).
import { describe, expect, it } from 'vitest';
import { incomeReliability, toScoringPatch } from '@los/calc';
import { BsaScoringInput, BsaSummary } from '@los/contracts';
import { classifyTransactions } from '../classify/classifier';
import type { ClassifiableTxn, ClassifiedTxn } from '../classify/classify.types';
import { DEFAULT_BSA_CATEGORIES, DEFAULT_BSA_RULES } from '../classify/default-catalog';
import { expenseTxn, incomeTxn } from '../classify/testing/factories';
import { DtiAnalysisService } from './dti-analysis.service';
import { toDtiParams } from './dti-params';
import { buildBsaSummary, buildScoringInput } from './summary.builder';
import { TEST_SETTINGS } from './testing/fixtures';

const MONTHS = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];

/** 6 сарын (03-10 … 09-10) синтетик хуулга: цалин, бизнес, зээл, өөрийн шилжүүлэг, хугацаанаас гадуурх гүйлгээ */
function scenario(): ClassifiableTxn[] {
  const txns: ClassifiableTxn[] = [];
  MONTHS.forEach((m, i) => {
    txns.push(incomeTxn(`sal${i}`, `Цалин ${m}`, { txnDate: `${m}-15`, amount: 1_000_000 }));
    txns.push(incomeTxn(`biz${i}`, `Борлуулалтын орлого ${m}`, { txnDate: `${m}-16`, amount: 2_000_000 }));
    txns.push(expenseTxn(`mat${i}`, `Бараа материал ${m}`, { txnDate: `${m}-17`, amount: 500_000 }));
    txns.push(expenseTxn(`loan${i}`, `Зээлийн эргэн төлөлт ${m}`, { txnDate: `${m}-20`, amount: 200_000 }));
    txns.push(expenseTxn(`elec${i}`, `Цахилгаан ${m}`, { txnDate: `${m}-21`, amount: 100_000 }));
  });
  txns.push(incomeTxn('loanin', 'Зээл олголт', { txnDate: '2026-06-02', amount: 10_000_000 }));
  // Өөр хуулгын хос — өөрийн данс хоорондын шилжүүлэг: хоёр тал ХАСАГДАНА
  txns.push(incomeTxn('ownIn', 'Орлого', { txnDate: '2026-05-05', amount: 50_000_000, statementKey: 'stmt-2', bank: 'TDB', txnTime: '10:00' }));
  txns.push(expenseTxn('ownOut', 'Зарлага', { txnDate: '2026-05-05', amount: 50_000_000, statementKey: 'stmt-1', bank: 'KHAN', txnTime: '10:00' }));
  // Хугацаанаас гадуур: тооцоонд ороогүй
  txns.push(incomeTxn('late', 'Цалин 2026-09', { txnDate: '2026-09-15', amount: 9_000_000 }));
  txns.push(incomeTxn('early', 'Цалин 2026-02', { txnDate: '2026-02-15', amount: 9_000_000 }));
  return txns;
}

const params = toDtiParams(TEST_SETTINGS, { periodFrom: '2026-03-10', periodTo: '2026-09-10', proposedMonthlyPayment: 300_000 });

function analyze() {
  const txns = scenario();
  const results = classifyTransactions(txns, { categories: DEFAULT_BSA_CATEGORIES, rules: DEFAULT_BSA_RULES, ownAccounts: [], customerNames: [] });
  const classified: ClassifiedTxn[] = txns.map((txn, i) => ({ txn, result: results[i] }));
  return { classified, analysis: new DtiAnalysisService().analyze({ classified, categories: DEFAULT_BSA_CATEGORIES, params, otherShareThreshold: 0.3 }) };
}

describe('classification → aggregation → computeBsaDti', () => {
  const { classified, analysis } = analyze();
  const { dti } = analysis;

  it('classifies the scenario as intended (sanity)', () => {
    const cat = (key: string) => classified.find((c) => c.txn.key === key)?.result;
    expect(cat('sal0')?.categoryCode).toBe('SALARY');
    expect(cat('biz0')?.categoryCode).toBe('BUSINESS_INCOME');
    expect(cat('loanin')?.categoryCode).toBe('LOAN_PROCEEDS');
    expect(cat('ownIn')).toMatchObject({ categoryCode: 'OWN_TRANSFER_IN', isOwnTransfer: true });
    expect(cat('ownOut')).toMatchObject({ categoryCode: 'NON_EXPENSE', isOwnTransfer: true });
  });

  it('period: 6 months, out-of-period transactions are not counted, own transfers are counted as transactions but excluded from money', () => {
    expect(dti.periodMonths).toBe(6);
    expect(analysis.outOfPeriodCount).toBe(2);
    expect(analysis.ownTransferCount).toBe(2);
    expect(analysis.transactionCount).toBe(scenario().length - 2);
  });

  it('matches the hand-calculated figures (own transfers of 50 M and the 9 M out-of-period salaries must not leak in)', () => {
    // Орлого (сарын дундаж): цалин 1 M, бизнес 2 M, зээл олголт 10 M/6 → нийт 4,666,666.67
    expect(dti.totalMonthlyIncome).toBe(4_666_666.67);
    // Жинлэсэн = 1 M×1 + 2 M×0.85 = 2.7 M ; DTI орлого = 2.7 M × (1 − 0.1) = 2.43 M
    expect(dti.verifiedMonthlyIncome).toBe(2_700_000);
    expect(dti.dtiIncome).toBe(2_430_000);
    expect(dti.businessIncomeMonthly).toBe(1_700_000);
    expect(dti.businessExpenseMonthly).toBe(500_000);
    expect(dti.netCashFlowMonthly).toBe(1_200_000);
    expect(dti.existingDebtServiceMonthly).toBe(200_000);
    expect(dti.householdExpenseMonthly).toBe(100_000);
    // DTI = (300,000 + 200,000) / 2,430,000 = 20.58 % → 20.6, LOW (≤ 35 %), хязгаарт багтана
    expect(dti.dtiPercent).toBe(20.6);
    expect(dti.dtiLevel).toBe('LOW');
    expect(dti.meetsLimit).toBe(true);
  });

  it('every active category is reported (the UI shows empty ones too), including zero-weight income', () => {
    const codes = dti.categories.map((c) => c.code);
    expect(new Set(codes)).toEqual(new Set(DEFAULT_BSA_CATEGORIES.map((c) => c.code)));
    expect(dti.categories.find((c) => c.code === 'LOAN_PROCEEDS')).toMatchObject({ totalAmount: 10_000_000, weightedMonthly: 0 });
    expect(dti.categories.find((c) => c.code === 'OWN_TRANSFER_IN')).toMatchObject({ totalAmount: 0, txnCount: 0 });
  });

  it('income reliability is consistent with calc applied to the same aggregation', () => {
    const direct = incomeReliability(analysis.categoryMonthly, params, dti.monthKeys);
    expect(dti.incomeReliability).toBe(direct);
    expect(dti.incomeReliability).toBeGreaterThan(0);
    expect(dti.incomeReliability).toBeLessThan(100); // 2026-09 сард баталгаажсан орлого байхгүй
  });

  it('"Бусад" report: no unclassified amounts in this scenario, so not exceeded', () => {
    expect(analysis.otherShare).toEqual([
      expect.objectContaining({ direction: 'INCOME', otherAmount: 0, exceeded: false }),
      expect.objectContaining({ direction: 'EXPENSE', otherAmount: 0, exceeded: false }),
    ]);
  });

  it('the result feeds the LOS contracts and the scoring patch (INT-4 / INT-5)', () => {
    const meta = { analysisId: 'a-1', loanApplicationId: '4118', borrowerId: '1', status: 'ANALYZED' as const, version: 1, periodFrom: params.periodFrom, periodTo: params.periodTo };
    const input = { analysis: meta, dtiResult: dti, transactionCount: analysis.transactionCount, pendingSuspiciousCount: 3, reportPdfUrl: null };
    const summary = buildBsaSummary(input);
    expect(BsaSummary.safeParse(summary).success).toBe(true);
    expect(summary).toMatchObject({ dtiIncome: 2_430_000, netCashFlowMonthly: 1_200_000, existingDebtServiceMonthly: 200_000, dtiPercent: 20.6, dtiLevel: 'LOW', pendingSuspiciousCount: 3 });
    const scoring = buildScoringInput(input);
    expect(BsaScoringInput.safeParse(scoring).success).toBe(true);
    const patch = toScoringPatch(scoring);
    expect(patch.scoreRequest).toEqual({ businessNcfMonthly: 1_200_000, existingDebtServiceMonthly: 200_000, householdExpenseMonthly: 100_000 });
    expect(patch.sosco).toMatchObject({ dtiPercent: 20.6, pendingSuspiciousCount: 3 });
  });

  it('reclassifying a salary to a zero-weight category lowers the DTI income (the bulk reclassify → recompute loop)', () => {
    const txns = scenario();
    const results = classifyTransactions(txns, { categories: DEFAULT_BSA_CATEGORIES, rules: DEFAULT_BSA_RULES, ownAccounts: [], customerNames: [] });
    const edited = txns.map((txn, i): ClassifiedTxn => ({
      txn: txn.key.startsWith('sal') ? { ...txn, manualCategoryCode: 'IRREGULAR_INCOME' } : txn,
      result: txn.key.startsWith('sal') ? { ...results[i], categoryCode: 'IRREGULAR_INCOME', confidence: 100 } : results[i],
    }));
    const r = new DtiAnalysisService().analyze({ classified: edited, categories: DEFAULT_BSA_CATEGORIES, params });
    expect(r.dti.verifiedMonthlyIncome).toBe(1_700_000); // цалингийн 1 M гарсан
    expect(r.dti.dtiIncome).toBe(1_530_000);
  });
});

describe('edge cases through the real calculator', () => {
  const service = new DtiAnalysisService();
  const run = (txns: ClassifiableTxn[], over = {}) => {
    const results = classifyTransactions(txns, { categories: DEFAULT_BSA_CATEGORIES, rules: DEFAULT_BSA_RULES, ownAccounts: [], customerNames: [] });
    return service.analyze({ classified: txns.map((txn, i) => ({ txn, result: results[i] })), categories: DEFAULT_BSA_CATEGORIES, params: { ...params, ...over } });
  };

  it('an empty statement yields zero income and a capped HIGH DTI when a payment is proposed', () => {
    const r = run([]);
    expect(r.dti).toMatchObject({ dtiIncome: 0, incomeReliability: 0, dtiPercent: 999.9, dtiLevel: 'HIGH', meetsLimit: false });
    expect(r.transactionCount).toBe(0);
  });

  it('with no proposed payment and no income the DTI is 0 and LOW', () => {
    expect(run([], { proposedMonthlyPayment: 0 }).dti).toMatchObject({ dtiPercent: 0, dtiLevel: 'LOW', meetsLimit: true });
  });

  it('the 50% rule: cash income counts half', () => {
    const r = run([incomeTxn('c', 'Бэлэн мөнгө байршуулсан', { txnDate: '2026-03-20', amount: 6_000_000 })], { costOfGoodsRate: 0 });
    expect(r.dti.verifiedMonthlyIncome).toBe(500_000); // 6 M / 6 сар × 0.5
  });
});
