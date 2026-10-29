// BSA-FR-4.1 / 4.2 / 4.3 / 2.4 / 3.6: дахин тооцоолол, анхааруулгууд (хуулгын завсар, «Бусад»-ын хувь), stale хураангуй, тохиргооны өөрчлөлт.
import { describe, expect, it } from 'vitest';
import { createHarness, OFFICER, ctxOf } from './testing/harness';
import { ACCOUNT_A, ACCOUNT_B, EXPECTED_HAPPY, HOLDER, OPENING_A, OPENING_B, accountATxns, balanceBefore, importHappy } from './testing/scenario';
import { buildStatementFile } from './testing/statement-files';
import { customerNameVariants } from './recalculation.service';

describe('RecalculationService', () => {
  it('is idempotent: a second recalculation changes nothing and reclassifies nothing', async () => {
    const h = await createHarness();
    const { analysisId } = await importHappy(h);
    const first = await h.recalc.recalculate(OFFICER, analysisId);
    const second = await h.recalc.recalculate(OFFICER, analysisId);
    expect(second.summary).toEqual(first.summary);
    expect(second.reclassified).toBe(0);
    expect(first.summary).toMatchObject({ dtiPercent: EXPECTED_HAPPY.dtiPercent, transactionCount: 27 });
    const recalculations = (await h.analysis.listEvents(OFFICER, analysisId)).items.filter((e) => e.action === 'RECALCULATED');
    // Тестийн цаг тогтмол (ижил `at`) тул түүхийн дараалалд найдахгүй: дуудагчийн хийсэн 2 дахин тооцоолол бүртгэгдсэн байх ёстой
    expect(recalculations.filter((e) => e.actorId === OFFICER.userId)).toHaveLength(2);
  });

  it('a settings change makes the stored summary stale until it is recalculated', async () => {
    const h = await createHarness();
    const { analysisId } = await importHappy(h);
    expect((await h.recalc.report(OFFICER, analysisId)).summaryStale).toBe(false);

    h.settings.costOfGoodsRate = 0.2; // админ тохиргоо өөрчлөгдсөн
    const stale = await h.recalc.report(OFFICER, analysisId);
    expect(stale.summaryStale).toBe(true);
    expect(stale.summary?.dtiIncome).toBe(2_052_000); // 2,565,000 × 0.8
    // Хадгалагдсан хураангуй хэвээр (report нь бичихгүй)
    expect((await h.analysis.get(OFFICER, analysisId)).summary?.dtiIncome).toBe(EXPECTED_HAPPY.dtiIncome);

    await h.recalc.recalculate(OFFICER, analysisId);
    expect((await h.recalc.report(OFFICER, analysisId)).summaryStale).toBe(false);
    expect((await h.analysis.get(OFFICER, analysisId)).summary?.dtiIncome).toBe(2_052_000);
  });

  it('returns no summary and writes nothing when there is no completed import', async () => {
    const h = await createHarness();
    const analysis = await h.createAnalysis();
    const res = await h.recalc.recalculate(OFFICER, analysis.id);
    expect(res).toMatchObject({ summary: null, details: null });
    expect((await h.analysis.get(OFFICER, analysis.id)).summary).toBeNull();
    expect(await h.recalc.scoringInput(OFFICER, analysis.id)).toBeNull();
    expect((await h.recalc.report(OFFICER, analysis.id)).summary).toBeNull();
  });

  it('refuses to calculate for an org whose system categories are incomplete (CATALOG_INCOMPLETE)', async () => {
    const h = await createHarness();
    const stranger = ctxOf(['OFFICER'], { orgId: 'org-without-catalog' });
    const analysis = await h.createAnalysis({}, stranger);
    await expect(h.recalc.recalculate(stranger, analysis.id)).rejects.toMatchObject({ bsaCode: 'CATALOG_INCOMPLETE', status: 422 });
  });

  it('warns about a gap between the statements of one account', async () => {
    const h = await createHarness();
    const analysis = await h.createAnalysis({ periodMonths: 3 });
    const rows = accountATxns();
    // Нэг дансны 4-р сар ба 6-р сарын хуулга; 5-р сарын хуулга байхгүй (гүйлгээ ч байхгүй гэж үзвэл үлдэгдэл үргэлжилнэ)
    const april = rows.filter((r) => r.date <= '2026-04-30');
    const june = rows.filter((r) => r.date >= '2026-06-01');
    const may = rows.filter((r) => r.date >= '2026-05-01' && r.date <= '2026-05-31');
    const juneOpening = balanceBefore(rows, rows.indexOf(june[0]), OPENING_A);
    expect(may.length).toBeGreaterThan(0); // 5-р сарын гүйлгээ энэ хуулгад ороогүй ⇒ үлдэгдэл үсрэх тул тухайн файлын opening-ээр дахин тооцно
    const f1 = await buildStatementFile({ bank: 'TDB', txns: april, opening: OPENING_A, accountNo: ACCOUNT_A, iban: null, holder: HOLDER, fileName: 'apr.csv' });
    const f2 = await buildStatementFile({ bank: 'TDB', txns: june, opening: juneOpening, accountNo: ACCOUNT_A, iban: null, holder: HOLDER, fileName: 'jun.csv' });
    await h.uploadFiles(analysis.id, [f1, f2]);
    expect((await h.jobs(analysis.id)).map((j) => j.status)).toEqual(['COMPLETED', 'COMPLETED']);

    const report = await h.recalc.report(OFFICER, analysis.id);
    const codes = report.details?.warnings.map((w) => w.code) ?? [];
    expect(codes).toEqual(expect.arrayContaining(['STATEMENT_GAPS']));
    expect(report.details?.coverage.gaps.length).toBeGreaterThan(0);
    expect(report.details?.coverage.missingMonths).toContain('2026-05');
  });

  it('flags a too large share of "other" categories (BSA-BR-7)', async () => {
    const h = await createHarness();
    const analysis = await h.createAnalysis();
    const unknown = ['04', '05', '06'].flatMap((m) => [
      { date: `2026-${m}-03`, time: '09:00:00', direction: 'INCOME' as const, amount: 1_000_000, description: `Mystery credit ZXQ-O${m}` },
      { date: `2026-${m}-20`, time: '10:00:00', direction: 'INCOME' as const, amount: 100_000, description: `Цалин ZXQ-S${m}` },
    ]);
    const file = await buildStatementFile({ bank: 'MBANK', txns: unknown, opening: OPENING_B, accountNo: ACCOUNT_B, iban: null, holder: HOLDER, fileName: 'other.csv' });
    await h.uploadFiles(analysis.id, [file]);
    const details = (await h.recalc.report(OFFICER, analysis.id)).details;
    expect(details?.warnings.map((w) => w.code)).toContain('OTHER_SHARE_EXCEEDED');
    const income = details?.otherShare?.find((s) => s.direction === 'INCOME');
    expect(income?.exceeded).toBe(true);
    expect(income?.share).toBeCloseTo(3_000_000 / 3_300_000, 6);
  });

  it('warns when no proposed monthly payment was given and the statements are short of the required months', async () => {
    const h = await createHarness({ settings: { minStatementMonths: 6, allowedPeriodMonths: [3, 6, 12] } });
    const { analysisId } = await importHappy(h, { proposedMonthlyPayment: null, periodMonths: 6 });
    const warnings = (await h.recalc.report(OFFICER, analysisId)).details?.warnings ?? [];
    expect(warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['PROPOSED_PAYMENT_MISSING', 'STATEMENT_COVERAGE_SHORT', 'PERIOD_CLAMPED']));
    expect(warnings.find((w) => w.code === 'STATEMENT_COVERAGE_SHORT')?.message).toContain('3');
  });
});

describe('customerNameVariants', () => {
  it('collects both name orders, declared holder names and verified statement holders without duplicates', async () => {
    const h = await createHarness();
    const analysis = await h.createAnalysis({
      customer: { registerNo: 'УБ90010203', lastName: 'Bat-Erdene', firstName: 'Bold', declaredAccounts: [{ accountNo: '123456', holderName: 'Bold B.' }] },
    });
    const record = await h.memory.analyses.getById(analysis.id);
    const names = customerNameVariants(record!, []);
    expect(names).toEqual(expect.arrayContaining(['Bat-Erdene Bold', 'Bold Bat-Erdene', 'Bold B.']));
    expect(new Set(names).size).toBe(names.length);
  });
});
