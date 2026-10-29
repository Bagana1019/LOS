// INT-4 / INT-5 / BSA-FR-5.3: «Системрүү татах» (finalize), дахин татах, сэжигтэй гүйлгээний бодлого, scoring оролт. SYNTHETIC өгөгдөл.
import { describe, expect, it } from 'vitest';
import { toScoringPatch } from '@los/calc';
import { createHarness, OFFICER } from './testing/harness';
import { ACCOUNT_B, EXPECTED_HAPPY, HOLDER, OPENING_B, accountBTxns, happyFiles, importHappy } from './testing/scenario';
import { buildStatementFile } from './testing/statement-files';
import { alterBalanceOfRow } from './testing/tamper';

describe('FinalizeService.finalize', () => {
  it('refuses without any completed import and leaves the analysis a DRAFT', async () => {
    const h = await createHarness();
    const analysis = await h.createAnalysis();
    await expect(h.finalize.finalize(OFFICER, analysis.id)).rejects.toMatchObject({ bsaCode: 'NO_COMPLETED_IMPORT', status: 422 });

    // Зөвхөн алдаатай импорт байвал мөн татгалзана
    const bad = await buildStatementFile({
      bank: 'MBANK', txns: accountBTxns(), opening: OPENING_B, accountNo: ACCOUNT_B, iban: null, holder: HOLDER, fileName: 'bad.csv', tamper: alterBalanceOfRow(2),
    });
    await h.uploadFiles(analysis.id, [bad]);
    expect((await h.jobs(analysis.id))[0].status).toBe('FAILED');
    await expect(h.finalize.finalize(OFFICER, analysis.id)).rejects.toMatchObject({ bsaCode: 'NO_COMPLETED_IMPORT' });

    const stored = await h.analysis.get(OFFICER, analysis.id);
    expect(stored).toMatchObject({ status: 'DRAFT', analyzedAt: null, pushedToLosAt: null });
    expect((await h.analysis.listEvents(OFFICER, analysis.id)).items.some((e) => e.action === 'FINALIZED')).toBe(false);
  });

  it('refuses while a job is still waiting or processing (JOBS_IN_PROGRESS)', async () => {
    const h = await createHarness({ startWorker: false });
    const analysis = await h.createAnalysis();
    const { a } = await happyFiles();
    await h.uploadFiles(analysis.id, [a]);
    await expect(h.finalize.finalize(OFFICER, analysis.id)).rejects.toMatchObject({ bsaCode: 'JOBS_IN_PROGRESS', status: 409 });
    await h.processor.start();
    const done = await h.finalize.finalize(OFFICER, analysis.id);
    expect(done.summary.status).toBe('ANALYZED');
  });

  it('marks the analysis ANALYZED and returns the exact INT-4 summary', async () => {
    const h = await createHarness();
    const { analysisId } = await importHappy(h);
    const at = new Date('2026-07-16T10:00:00.000Z');
    h.clock.current = at;

    const result = await h.finalize.finalize(OFFICER, analysisId);
    expect(result).toMatchObject({ firstTime: true, pushedToLosAt: at, warnings: [] });
    expect(result.summary).toMatchObject({
      analysisId,
      loanApplicationId: 'app-1',
      borrowerId: 'bor-1',
      status: 'ANALYZED',
      version: 1,
      transactionCount: EXPECTED_HAPPY.transactionCount,
      verifiedMonthlyIncome: EXPECTED_HAPPY.verifiedMonthlyIncome,
      dtiIncome: EXPECTED_HAPPY.dtiIncome,
      dtiPercent: EXPECTED_HAPPY.dtiPercent,
      dtiLevel: 'MEDIUM',
      pendingSuspiciousCount: 0,
    });

    const stored = await h.analysis.get(OFFICER, analysisId);
    expect(stored).toMatchObject({ status: 'ANALYZED', analyzedAt: at, pushedToLosAt: at });
    expect(stored.summary?.status).toBe('ANALYZED');
    const finalized = (await h.analysis.listEvents(OFFICER, analysisId)).items.filter((e) => e.action === 'FINALIZED');
    expect(finalized).toHaveLength(1);
    expect(finalized[0].detail).toMatchObject({ firstTime: true, dtiPercent: 39, dtiLevel: 'MEDIUM', pendingSuspicious: 0 });
  });

  it('can be pushed again: pushedToLosAt moves, analyzedAt stays, and uploads/deletes are refused after the first push', async () => {
    const h = await createHarness();
    const { analysisId } = await importHappy(h);
    const first = new Date('2026-07-16T10:00:00.000Z');
    const second = new Date('2026-07-20T08:30:00.000Z');
    h.clock.current = first;
    await h.finalize.finalize(OFFICER, analysisId);
    h.clock.current = second;
    const again = await h.finalize.finalize(OFFICER, analysisId);

    expect(again).toMatchObject({ firstTime: false, pushedToLosAt: second });
    const stored = await h.analysis.get(OFFICER, analysisId);
    expect(stored.analyzedAt).toEqual(first);
    expect(stored.pushedToLosAt).toEqual(second);

    const { b } = await happyFiles();
    await expect(h.uploadFiles(analysisId, [b])).rejects.toMatchObject({ bsaCode: 'ANALYSIS_NOT_DRAFT', status: 409 });
    await expect(h.analysis.delete(OFFICER, analysisId)).rejects.toMatchObject({ bsaCode: 'ANALYSIS_NOT_DRAFT' });
  });

  it('WARN policy pushes with a warning; BLOCK policy refuses and keeps the DRAFT', async () => {
    const warn = await createHarness();
    const w = await importHappy(warn);
    warn.suspicion.pending = 2;
    const pushed = await warn.finalize.finalize(OFFICER, w.analysisId);
    expect(pushed.summary.pendingSuspiciousCount).toBe(2);
    expect(pushed.warnings.map((x) => x.code)).toContain('PENDING_SUSPICIOUS');

    const block = await createHarness({ settings: { pushPolicyWhenPendingSuspicious: 'BLOCK' } });
    const b = await importHappy(block);
    block.suspicion.pending = 3;
    await expect(block.finalize.finalize(OFFICER, b.analysisId)).rejects.toMatchObject({ bsaCode: 'PENDING_SUSPICIOUS_BLOCK', status: 422 });
    expect(await block.analysis.get(OFFICER, b.analysisId)).toMatchObject({ status: 'DRAFT', pushedToLosAt: null });
    // Сэжигтэйг шийдвэрлэсний дараа татна
    block.suspicion.pending = 0;
    expect((await block.finalize.finalize(OFFICER, b.analysisId)).summary.status).toBe('ANALYZED');
  });

  it('is rolled back as a whole when there is nothing to calculate (NO_TRANSACTIONS) and stays a DRAFT', async () => {
    const h = await createHarness();
    const { analysisId } = await importHappy(h);
    // Импорт COMPLETED, гэвч гүйлгээ нь устсан (өгөгдлийн алдагдал) ⇒ хураангуй гаргаж чадахгүй
    for (const job of await h.jobs(analysisId)) await h.memory.transactions.deleteByJob(job.id);
    await expect(h.finalize.finalize(OFFICER, analysisId)).rejects.toMatchObject({ bsaCode: 'NO_TRANSACTIONS', status: 422 });
    const stored = await h.analysis.get(OFFICER, analysisId);
    expect(stored).toMatchObject({ status: 'DRAFT', analyzedAt: null, pushedToLosAt: null });
    expect((await h.analysis.listEvents(OFFICER, analysisId)).items.some((e) => e.action === 'FINALIZED')).toBe(false);
  });
});

describe('FinalizeService scoring input (INT-5)', () => {
  it('is available only after the push and maps to the scoring patch', async () => {
    const h = await createHarness();
    const { analysisId } = await importHappy(h);
    await expect(h.finalize.toScoringInput(OFFICER, analysisId)).rejects.toMatchObject({ bsaCode: 'NOT_ANALYZED', status: 409 });

    await h.finalize.finalize(OFFICER, analysisId);
    const input = await h.finalize.toScoringInput(OFFICER, analysisId);
    expect(input).toMatchObject({
      analysisId,
      loanApplicationId: 'app-1',
      borrowerId: 'bor-1',
      status: 'ANALYZED',
      periodMonths: 3,
      transactionCount: 27,
      businessIncomeMonthly: 765_000,
      businessExpenseMonthly: 150_000,
      businessNcfMonthly: 615_000,
      householdExpenseMonthly: 180_000,
      existingDebtServiceMonthly: 400_000,
      verifiedMonthlyIncome: 2_565_000,
      dtiPercent: 39,
      incomeReliability: 100,
      pendingSuspiciousCount: 0,
    });
    const preview = await h.finalize.scoringPreview(OFFICER, analysisId);
    expect(preview.patch).toEqual(toScoringPatch(preview.input));
    expect(preview.patch.scoreRequest).toEqual({ businessNcfMonthly: 615_000, existingDebtServiceMonthly: 400_000, householdExpenseMonthly: 180_000 });
    expect(preview.patch.sosco).toEqual({ dtiPercent: 39, incomeReliability: 100, pendingSuspiciousCount: 0 });
  });
});
