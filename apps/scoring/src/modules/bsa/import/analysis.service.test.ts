// INT-1 / INT-6 / BSA-FR-4.1: шинжилгээ үүсгэх, параметр өөрчлөх (дахин тооцоо), устгах, жагсаалт. SYNTHETIC өгөгдөл.
import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { createHarness, ADMIN, BRANCH, CUSTOMER_REGISTER, OFFICER, OTHER_BRANCH, ctxOf } from './testing/harness';
import { ACCOUNT_A, EXPECTED_HAPPY, happyFiles, importHappy } from './testing/scenario';

describe('AnalysisService.create', () => {
  it('creates a DRAFT with the default period, masked customer data and the declared accounts as own accounts', async () => {
    const h = await createHarness();
    const view = await h.createAnalysis({
      customer: {
        registerNo: CUSTOMER_REGISTER, lastName: 'Bat-Erdene', firstName: 'Bold', phone: '99112233',
        declaredAccounts: [{ bankCode: 'TDB', accountNo: ` ${ACCOUNT_A} `, holderName: 'Bat-Erdene Bold' }, { accountNo: '1234-5678' }],
      },
      periodMonths: null,
    });
    expect(view).toMatchObject({ status: 'DRAFT', version: 1, branchId: BRANCH, periodMonths: 3, periodFrom: null, summary: null, ownAccountCount: 2, createdBy: OFFICER.userId });
    expect(view.customer?.registerNoMasked).toBe('******0203');
    expect(view.customer?.phoneMasked).toBe('****2233');
    expect(view.customer?.declaredAccounts[0]).toMatchObject({ bankCode: 'TDB', accountMasked: '******3344', source: 'MANUAL' });
    // Ил регистр/дансны дугаар харагдацад байхгүй
    expect(JSON.stringify(view)).not.toContain(CUSTOMER_REGISTER);
    expect(JSON.stringify(view)).not.toContain(ACCOUNT_A);
    const events = (await h.analysis.listEvents(OFFICER, view.id)).items;
    expect(events.map((e) => e.action)).toEqual(['ANALYSIS_CREATED']);
    expect(JSON.stringify(events)).not.toContain('99112233');
  });

  it('uses the settings default months when none is given (first allowed value >= minStatementMonths)', async () => {
    const h = await createHarness({ settings: { minStatementMonths: 6 } });
    expect((await h.createAnalysis({ periodMonths: null })).periodMonths).toBe(6);
  });

  it('versions: once the first analysis is completed, a second one for the same application and customer is version 2', async () => {
    const h = await createHarness();
    const first = await h.createAnalysis();
    await h.repo.analyses.update(first.id, { status: 'ANALYZED' });
    const second = await h.createAnalysis();
    expect([first.version, second.version]).toEqual([1, 2]);
    const latest = await h.analysis.latestForApplication(OFFICER, 'app-1');
    expect(latest.map((a) => a.version)).toEqual([2]);
  });

  it('validates the period against the settings and the input shape', async () => {
    const h = await createHarness();
    await expect(h.createAnalysis({ periodMonths: 5 })).rejects.toMatchObject({ bsaCode: 'PERIOD_NOT_ALLOWED', status: 400 });
    await expect(h.createAnalysis({ periodMonths: null, periodFrom: '2026-06-30', periodTo: '2026-04-01' })).rejects.toMatchObject({ bsaCode: 'INVALID_REQUEST' });
    await expect(h.createAnalysis({ periodMonths: 3, periodFrom: '2026-04-01', periodTo: '2026-06-30' })).rejects.toMatchObject({ bsaCode: 'INVALID_REQUEST' });
    await expect(h.createAnalysis({ periodMonths: null, periodFrom: '2026-02-30', periodTo: '2026-04-30' })).rejects.toMatchObject({ bsaCode: 'INVALID_PERIOD' });
    const range = await h.createAnalysis({ periodMonths: null, periodFrom: '2026-04-01', periodTo: '2026-06-30' });
    expect(range).toMatchObject({ periodMonths: null, periodFrom: '2026-04-01', periodTo: '2026-06-30' });
  });

  it('rejects invalid input with paths and codes only (never the supplied values)', async () => {
    const h = await createHarness();
    const err = (await h.createAnalysis({ customer: { registerNo: 'xy', lastName: 'Secret-Surname' } }).catch((e: unknown) => e)) as { getResponse(): unknown };
    const body = JSON.stringify(err.getResponse());
    expect(body).toContain('registerNo');
    expect(body).not.toContain('Secret-Surname');
    expect(body).not.toContain('xy"');
  });

  it('branch rules: ADMIN picks the branch, others use their own, nobody without a branch can create', async () => {
    const h = await createHarness();
    expect((await h.createAnalysis({ branchId: OTHER_BRANCH }, ADMIN)).branchId).toBe(OTHER_BRANCH);
    // ADMIN өгөөгүй бол өөрийн салбар (байхгүй ⇒ null)
    expect((await h.createAnalysis({ loanApplicationId: 'app-2' }, ADMIN)).branchId).toBeNull();
    // Бусад нь өгсөн branchId-г үл тоомсорлоно
    expect((await h.createAnalysis({ loanApplicationId: 'app-3', branchId: OTHER_BRANCH }, OFFICER)).branchId).toBe(BRANCH);
    expect((await h.createAnalysis({ loanApplicationId: 'app-4' }, ctxOf(['BRANCH_MANAGER'], { userId: 'u-bm' }))).branchId).toBe(BRANCH);
    await expect(h.createAnalysis({}, ctxOf(['OFFICER'], { branchId: null }))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(h.createAnalysis({}, ctxOf(['APPROVER']))).rejects.toBeInstanceOf(ForbiddenException);
  });
});

// F6-3 / BSA-FR-1.2 «давхар бүртгэхгүй» / INT-7: хүсэлт+зээлдэгч тутамд нэг идэвхтэй ноорог. Хурдан давхар дарахад 2 DRAFT үүсч v1 өнчирдөг байсан.
describe('AnalysisService.create is idempotent while the latest version is a DRAFT (F6-3)', () => {
  const draftCount = async (h: Awaited<ReturnType<typeof createHarness>>, filter: { applicationId?: string; customerId?: string } = {}): Promise<number> =>
    (await h.repo.analyses.list({ orgId: OFFICER.orgId, ...filter })).total;

  it('a second create returns the existing DRAFT and creates nothing (no new row, no second ANALYSIS_CREATED event)', async () => {
    const h = await createHarness();
    const first = await h.createAnalysis();
    const second = await h.createAnalysis();
    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ status: 'DRAFT', version: 1 });
    expect(await draftCount(h)).toBe(1);
    const events = (await h.analysis.listEvents(OFFICER, first.id)).items;
    expect(events.map((e) => e.action)).toEqual(['ANALYSIS_CREATED']);
  });

  it('createOrGetDraft reports created=true for the first call and created=false for the repeat', async () => {
    const h = await createHarness();
    const body = { loanApplicationId: 'app-1', customerId: 'cust-1', customer: { registerNo: CUSTOMER_REGISTER }, periodMonths: 3 };
    const first = await h.analysis.createOrGetDraft(OFFICER, body);
    const again = await h.analysis.createOrGetDraft(OFFICER, body);
    expect([first.created, again.created]).toEqual([true, false]);
    expect(again.analysis.id).toBe(first.analysis.id);
  });

  it('concurrent creates (double click) share ONE DRAFT and write ONE event', async () => {
    const h = await createHarness();
    const results = await Promise.all([h.createAnalysis(), h.createAnalysis(), h.createAnalysis()]);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await draftCount(h)).toBe(1);
    expect((await h.analysis.listEvents(OFFICER, results[0].id)).items).toHaveLength(1);
  });

  it('after the DRAFT is completed the next create makes a NEW version (INT-7 history is kept)', async () => {
    const h = await createHarness();
    const v1 = await h.createAnalysis();
    await h.repo.analyses.update(v1.id, { status: 'ANALYZED' });
    const v2 = await h.createAnalysis();
    expect(v2.id).not.toBe(v1.id);
    expect(v2).toMatchObject({ status: 'DRAFT', version: 2 });
    expect(await draftCount(h)).toBe(2);
    // ...and that new DRAFT is itself idempotent
    expect((await h.createAnalysis()).id).toBe(v2.id);
    expect(await draftCount(h)).toBe(2);
  });

  it('a stale DRAFT behind a completed newer version does not block a new version (only the LATEST version counts)', async () => {
    const h = await createHarness();
    const stale = await h.repo.analyses.create({ orgId: OFFICER.orgId, branchId: BRANCH, applicationId: 'app-1', customerId: 'cust-1', createdBy: OFFICER.userId });
    const done = await h.repo.analyses.create({ orgId: OFFICER.orgId, branchId: BRANCH, applicationId: 'app-1', customerId: 'cust-1', createdBy: OFFICER.userId });
    await h.repo.analyses.update(done.id, { status: 'ANALYZED' });
    const created = await h.createAnalysis();
    expect([stale.version, done.version, created.version]).toEqual([1, 2, 3]);
  });

  it('a different customer or a different application is a separate analysis', async () => {
    const h = await createHarness();
    const base = await h.createAnalysis();
    const otherCustomer = await h.createAnalysis({ customerId: 'cust-2' });
    const otherApplication = await h.createAnalysis({ loanApplicationId: 'app-2' });
    expect(new Set([base.id, otherCustomer.id, otherApplication.id]).size).toBe(3);
    expect([base.version, otherCustomer.version, otherApplication.version]).toEqual([1, 1, 1]);
  });

  it('never hands out a DRAFT the caller cannot read: another OFFICER gets their own new version', async () => {
    const h = await createHarness();
    const mine = await h.createAnalysis();
    const colleague = ctxOf(['OFFICER'], { userId: 'u-colleague' });
    const theirs = await h.createAnalysis({}, colleague);
    expect(theirs.id).not.toBe(mine.id);
    expect(theirs).toMatchObject({ version: 2, createdBy: 'u-colleague' });
  });

  it('a BRANCH_MANAGER of the same branch reuses an OFFICER DRAFT they are allowed to read', async () => {
    const h = await createHarness();
    const mine = await h.createAnalysis();
    const manager = ctxOf(['BRANCH_MANAGER'], { userId: 'u-manager' });
    expect((await h.createAnalysis({}, manager)).id).toBe(mine.id);
  });

  it('invalid input still fails and creates nothing', async () => {
    const h = await createHarness();
    await expect(h.createAnalysis({ periodMonths: 5 })).rejects.toMatchObject({ bsaCode: 'PERIOD_NOT_ALLOWED' });
    expect(await draftCount(h)).toBe(0);
  });
});

describe('AnalysisService.updateParams', () => {
  it('recalculates the DTI exactly when the proposed payment changes (INT-6)', async () => {
    const h = await createHarness();
    const { analysisId } = await importHappy(h);
    const res = await h.analysis.updateParams(OFFICER, analysisId, { proposedMonthlyPayment: 700_000 });
    // (700,000 + 400,000) / 2,308,500 = 47.65% → 47.6 (47.6499...)
    expect(res.recalculated).toBe(true);
    expect(res.summary).toMatchObject({ dtiPercent: 47.6, dtiLevel: 'MEDIUM', dtiIncome: EXPECTED_HAPPY.dtiIncome });
    expect(res.analysis.proposedMonthlyPayment).toBe(700_000);
    expect(res.repushRequired).toBe(false);
    expect((await h.analysis.get(OFFICER, analysisId)).summary?.dtiPercent).toBe(47.6);
    // Ангилал өөрчлөгдөөгүй: дахин ангилаагүй
    expect((await h.analysis.listEvents(OFFICER, analysisId)).items.map((e) => e.action)).toContain('PARAMS_UPDATED');
  });

  it('applies a cost-of-goods override and `null` restores the settings default', async () => {
    const h = await createHarness();
    const { analysisId } = await importHappy(h);
    const changed = await h.analysis.updateParams(OFFICER, analysisId, { costOfGoodsRate: 0.2 });
    // 2,565,000 × 0.8 = 2,052,000; 900,000 / 2,052,000 = 43.86% → 43.9
    expect(changed.summary).toMatchObject({ dtiIncome: 2_052_000, dtiPercent: 43.9 });
    const restored = await h.analysis.updateParams(OFFICER, analysisId, { costOfGoodsRate: null });
    expect(restored.summary).toMatchObject({ dtiIncome: EXPECTED_HAPPY.dtiIncome, dtiPercent: EXPECTED_HAPPY.dtiPercent });
    expect(restored.analysis.costOfGoodsRate).toBeNull();
    // Дүнгүй төлбөр (null): зөвхөн одоогийн өрийн үйлчилгээ 400,000 / 2,308,500 = 17.3%
    const noPayment = await h.analysis.updateParams(OFFICER, analysisId, { proposedMonthlyPayment: null });
    expect(noPayment.summary?.dtiPercent).toBe(17.3);
    expect((await h.recalc.report(OFFICER, analysisId)).details?.warnings.map((w) => w.code)).toContain('PROPOSED_PAYMENT_MISSING');
  });

  it('a longer period than the statements cover is clamped with a warning; a shorter one uses the window', async () => {
    const h = await createHarness({ settings: { allowedPeriodMonths: [1, 2, 3, 6, 12], minStatementMonths: 3 } });
    const { analysisId } = await importHappy(h);

    const longer = await h.analysis.updateParams(OFFICER, analysisId, { periodMonths: 6 });
    expect(longer.analysis.periodMonths).toBe(6); // хүссэн нь хадгалагдана
    expect(longer.summary).toMatchObject({ periodMonths: 3, periodFrom: '2026-04-01', periodTo: '2026-06-30' });
    const warnings = (await h.recalc.report(OFFICER, analysisId)).details?.warnings.map((w) => w.code) ?? [];
    expect(warnings).toEqual(expect.arrayContaining(['PERIOD_CLAMPED', 'STATEMENT_COVERAGE_SHORT']));

    const shorter = await h.analysis.updateParams(OFFICER, analysisId, { periodMonths: 1 });
    expect(shorter.summary).toMatchObject({ periodMonths: 1, periodFrom: '2026-06-01', periodTo: '2026-06-30' });
    // Зөвхөн 6-р сарын мөрүүд: A 5 + 1 хураамж, B 2 + 1 хураамж
    expect(shorter.summary?.transactionCount).toBe(9);
    expect(shorter.summary?.verifiedMonthlyIncome).toBe(EXPECTED_HAPPY.verifiedMonthlyIncome);
  });

  it('an explicit range is intersected with the coverage and an outside range falls back to the coverage with a warning', async () => {
    const h = await createHarness();
    const { analysisId } = await importHappy(h);
    const inside = await h.analysis.updateParams(OFFICER, analysisId, { periodMonths: null, periodFrom: '2026-05-01', periodTo: '2026-06-30' });
    expect(inside.summary).toMatchObject({ periodMonths: 2, periodFrom: '2026-05-01', periodTo: '2026-06-30' });
    expect(inside.analysis).toMatchObject({ periodMonths: null, periodFrom: '2026-05-01', periodTo: '2026-06-30' });

    const outside = await h.analysis.updateParams(OFFICER, analysisId, { periodMonths: null, periodFrom: '2020-01-01', periodTo: '2020-03-31' });
    expect(outside.summary).toMatchObject({ periodFrom: '2026-04-01', periodTo: '2026-06-30' });
    expect((await h.recalc.report(OFFICER, analysisId)).details?.warnings.map((w) => w.code)).toContain('PERIOD_OUTSIDE_COVERAGE');
  });

  it('refuses a disallowed month count and a reversed range', async () => {
    const h = await createHarness();
    const { analysisId } = await importHappy(h);
    await expect(h.analysis.updateParams(OFFICER, analysisId, { periodMonths: 5 })).rejects.toMatchObject({ bsaCode: 'PERIOD_NOT_ALLOWED' });
    await expect(h.analysis.updateParams(OFFICER, analysisId, { periodFrom: '2026-06-30', periodTo: '2026-04-01' })).rejects.toMatchObject({ bsaCode: 'INVALID_REQUEST' });
  });

  it('without imports it only stores the parameters (no summary)', async () => {
    const h = await createHarness();
    const analysis = await h.createAnalysis();
    const res = await h.analysis.updateParams(OFFICER, analysis.id, { proposedMonthlyPayment: 123_000 });
    expect(res).toMatchObject({ recalculated: false, summary: null, repushRequired: false });
    expect(res.analysis.proposedMonthlyPayment).toBe(123_000);
  });

  it('after the push it asks for a re-push', async () => {
    const h = await createHarness();
    const { analysisId } = await importHappy(h);
    await h.finalize.finalize(OFFICER, analysisId);
    const res = await h.analysis.updateParams(OFFICER, analysisId, { proposedMonthlyPayment: 600_000 });
    expect(res.repushRequired).toBe(true);
    expect(res.summary?.status).toBe('ANALYZED');
  });
});

describe('AnalysisService.delete', () => {
  it('removes a DRAFT with its rows and its files', async () => {
    const h = await createHarness();
    const { analysisId } = await importHappy(h);
    expect(h.store.keys()).toHaveLength(2);
    expect(await h.analysis.delete(OFFICER, analysisId)).toEqual({ deletedObjects: 2, failedObjects: 0 });
    expect(h.store.keys()).toHaveLength(0);
    await expect(h.analysis.get(OFFICER, analysisId)).rejects.toMatchObject({ status: 404 });
    expect(await h.memory.transactions.loadAll(analysisId)).toHaveLength(0);
  });

  it('refuses while a file is still being processed and after the push', async () => {
    const h = await createHarness({ startWorker: false });
    const analysis = await h.createAnalysis();
    const { a } = await happyFiles();
    await h.uploadFiles(analysis.id, [a]);
    await expect(h.analysis.delete(OFFICER, analysis.id)).rejects.toMatchObject({ bsaCode: 'JOBS_IN_PROGRESS', status: 409 });
    await h.processor.start();
    await h.finalize.finalize(OFFICER, analysis.id);
    await expect(h.analysis.delete(OFFICER, analysis.id)).rejects.toMatchObject({ bsaCode: 'ANALYSIS_NOT_DRAFT' });
  });

  it('counts files that could not be removed (orphans) but still deletes the analysis', async () => {
    const h = await createHarness({
      wrapStore: (inner) => ({
        put: (k, b, c) => inner.put(k, b, c),
        get: (k) => inner.get(k),
        exists: (k) => inner.exists(k),
        delete: async () => {
          throw new Error('minio down');
        },
      }),
    });
    const { analysisId } = await importHappy(h);
    expect(await h.analysis.delete(OFFICER, analysisId)).toEqual({ deletedObjects: 0, failedObjects: 2 });
    await expect(h.analysis.get(OFFICER, analysisId)).rejects.toMatchObject({ status: 404 });
  });
});

describe('AnalysisService read helpers', () => {
  it('lists jobs with their counts and hides account numbers', async () => {
    const h = await createHarness();
    const { analysisId } = await importHappy(h);
    const jobs = await h.analysis.listJobs(OFFICER, analysisId);
    expect(jobs.total).toBe(2);
    expect(JSON.stringify(jobs)).not.toContain(ACCOUNT_A);
    const completed = await h.analysis.listJobs(OFFICER, analysisId, 'COMPLETED');
    expect(completed.items).toHaveLength(2);
    expect(await h.analysis.jobCounts(OFFICER, analysisId)).toMatchObject({ COMPLETED: 2, FAILED: 0, PENDING: 0, PROCESSING: 0 });
    const job = await h.analysis.getJob(OFFICER, analysisId, jobs.items[0].id);
    expect(job.id).toBe(jobs.items[0].id);
    await expect(h.analysis.getJob(OFFICER, analysisId, '00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({ bsaCode: 'JOB_NOT_FOUND' });
  });

  it('lists transactions with filters and without the internal hash keys', async () => {
    const h = await createHarness();
    const { analysisId } = await importHappy(h);
    const all = await h.analysis.listTransactions(OFFICER, analysisId, {}, { limit: 100, offset: 0 });
    expect(all.total).toBe(27);
    expect(JSON.stringify(all.items)).not.toMatch(/dedupeKey|statementKey/);
    const own = await h.analysis.listTransactions(OFFICER, analysisId, { ownTransfer: true });
    expect(own.total).toBe(2);
    const salary = await h.analysis.listTransactions(OFFICER, analysisId, { categoryCodes: ['SALARY'] });
    expect(salary.items.map((t) => t.amount)).toEqual([1_200_000, 1_200_000, 1_200_000]);
    expect(await h.analysis.transactionCounts(OFFICER, analysisId)).toMatchObject({ total: 27 });
  });

  it('lists analyses inside the caller scope with filters', async () => {
    const h = await createHarness();
    await h.createAnalysis();
    await h.createAnalysis({ loanApplicationId: 'app-2' }, ADMIN);
    expect((await h.analysis.list(ADMIN)).total).toBe(2);
    expect((await h.analysis.list(OFFICER)).total).toBe(1); // зөвхөн өөрийн үүсгэсэн
    expect((await h.analysis.list(ADMIN, { applicationId: 'app-2' })).total).toBe(1);
    expect((await h.analysis.list(ADMIN, { status: 'ANALYZED' })).total).toBe(0);
    expect((await h.analysis.list(ctxOf(['OFFICER'], { branchId: null }))).items).toEqual([]);
  });
});
