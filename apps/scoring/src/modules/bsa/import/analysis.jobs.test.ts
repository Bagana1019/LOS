// AnalysisService.getJobById / listAllJobs (REST: GET /bsa/jobs, GET /bsa/jobs/:id): үүргээр хязгаарлах, хуудаслалт, тоолуур. SYNTHETIC өгөгдөл.
import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { BsaException } from './import.errors';
import { ADMIN, OFFICER, ORG, ctxOf, createHarness, type Harness } from './testing/harness';
import { ACCOUNT_B, HOLDER, OPENING_B, accountBTxns, happyFiles } from './testing/scenario';
import { buildStatementFile } from './testing/statement-files';
import { alterBalanceOfRow } from './testing/tamper';

const OFFICER_2 = ctxOf(['OFFICER'], { userId: 'u-officer-2' });
const OFFICER_BR2 = ctxOf(['OFFICER'], { userId: 'u-officer-3', branchId: 'br-2' });
const MANAGER = ctxOf(['BRANCH_MANAGER'], { userId: 'u-manager' });
const MANAGER_BR2 = ctxOf(['BRANCH_MANAGER'], { userId: 'u-manager-2', branchId: 'br-2' });
const APPROVER = ctxOf(['APPROVER'], { userId: 'u-approver', branchId: null });
const OTHER_ORG = ctxOf(['ADMIN'], { orgId: 'org-2', userId: 'u-admin-x', branchId: null });

interface Seed {
  h: Harness;
  /** OFFICER (br-1): 2 ажил (TDB + MBANK) */
  mine: string;
  /** OFFICER_2 (br-1): 1 ажил */
  colleague: string;
  /** OFFICER_BR2 (br-2): 1 ажил, FAILED */
  elsewhere: string;
}

async function seed(): Promise<Seed> {
  const h = await createHarness();
  const { a, b } = await happyFiles();
  const mine = await h.createAnalysis({}, OFFICER);
  await h.uploadFiles(mine.id, [a], OFFICER);
  h.clock.advance(60_000);
  await h.uploadFiles(mine.id, [b], OFFICER);
  h.clock.advance(60_000);
  const colleague = await h.createAnalysis({ loanApplicationId: 'app-2' }, OFFICER_2);
  await h.uploadFiles(colleague.id, [b], OFFICER_2);
  h.clock.advance(60_000);
  const elsewhere = await h.createAnalysis({ loanApplicationId: 'app-3' }, OFFICER_BR2);
  const bad = await buildStatementFile({
    bank: 'MBANK', txns: accountBTxns(), opening: OPENING_B, accountNo: ACCOUNT_B, iban: null, holder: HOLDER, fileName: 'bad.csv', tamper: alterBalanceOfRow(2),
  });
  await h.uploadFiles(elsewhere.id, [bad], OFFICER_BR2);
  return { h, mine: mine.id, colleague: colleague.id, elsewhere: elsewhere.id };
}

describe('AnalysisService.getJobById', () => {
  it('returns the job for everyone allowed to read its analysis', async () => {
    const { h, mine } = await seed();
    const [job] = (await h.analysis.listJobs(OFFICER, mine)).items;
    for (const ctx of [OFFICER, MANAGER, ADMIN, APPROVER]) {
      await expect(h.analysis.getJobById(ctx, job.id), ctx.roles.join()).resolves.toMatchObject({ id: job.id, analysisId: mine });
    }
  });

  it('hides jobs of other organizations as JOB_NOT_FOUND and denies other officers / branches', async () => {
    const { h, mine } = await seed();
    const [job] = (await h.analysis.listJobs(OFFICER, mine)).items;
    await expect(h.analysis.getJobById(OTHER_ORG, job.id)).rejects.toMatchObject({ bsaCode: 'JOB_NOT_FOUND' });
    await expect(h.analysis.getJobById(OFFICER, 'no-such-job')).rejects.toBeInstanceOf(BsaException);
    await expect(h.analysis.getJobById(OFFICER_2, job.id)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(h.analysis.getJobById(MANAGER_BR2, job.id)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('AnalysisService.listAllJobs', () => {
  it('ADMIN and APPROVER see the whole organization; other organizations see nothing', async () => {
    const { h } = await seed();
    for (const ctx of [ADMIN, APPROVER]) {
      const { page, counts } = await h.analysis.listAllJobs(ctx);
      expect(page.total).toBe(4);
      expect(counts).toEqual({ PENDING: 0, PROCESSING: 0, COMPLETED: 3, FAILED: 1 });
    }
    expect((await h.analysis.listAllJobs(OTHER_ORG)).page.total).toBe(0);
  });

  it('BRANCH_MANAGER sees their branch only and cannot widen it with branchId', async () => {
    const { h } = await seed();
    expect((await h.analysis.listAllJobs(MANAGER)).page.total).toBe(3);
    expect((await h.analysis.listAllJobs(MANAGER, { branchId: 'br-2' })).page.total).toBe(3); // өөрийн салбар албадан
    expect((await h.analysis.listAllJobs(MANAGER_BR2)).page.total).toBe(1);
    expect((await h.analysis.listAllJobs(ADMIN, { branchId: 'br-2' })).page.total).toBe(1); // ADMIN салбараар нарийвчилна
  });

  it('OFFICER sees only the jobs of their own analyses, newest first, with paging and counts', async () => {
    const { h, mine } = await seed();
    const all = await h.analysis.listAllJobs(OFFICER);
    expect(all.page.total).toBe(2);
    expect(all.page.items.map((j) => j.bankCode)).toEqual(['MBANK', 'TDB']); // сүүлд оруулсан нь эхэнд
    expect(all.page.items.every((j) => j.analysisId === mine)).toBe(true);
    expect(all.counts).toEqual({ PENDING: 0, PROCESSING: 0, COMPLETED: 2, FAILED: 0 });
    const first = await h.analysis.listAllJobs(OFFICER, {}, { limit: 1, offset: 0 });
    const second = await h.analysis.listAllJobs(OFFICER, {}, { limit: 1, offset: 1 });
    expect([first.page.items[0].bankCode, second.page.items[0].bankCode]).toEqual(['MBANK', 'TDB']);
    expect(first.page).toMatchObject({ total: 2, limit: 1, offset: 0 });
    expect((await h.analysis.listAllJobs(OFFICER, {}, { limit: 1, offset: 5 })).page.items).toEqual([]);
    expect((await h.analysis.listAllJobs(OFFICER_2)).page.total).toBe(1);
    expect((await h.analysis.listAllJobs(OFFICER_BR2)).page.total).toBe(1);
  });

  it('filters by status and bank, but counts ignore the status filter', async () => {
    const { h } = await seed();
    const failed = await h.analysis.listAllJobs(ADMIN, { status: ['FAILED'] });
    expect(failed.page.items.map((j) => j.status)).toEqual(['FAILED']);
    expect(failed.counts).toMatchObject({ COMPLETED: 3, FAILED: 1 });
    const tdb = await h.analysis.listAllJobs(ADMIN, { bankCode: 'TDB' });
    expect(tdb.page.total).toBe(1);
    expect(tdb.counts).toMatchObject({ COMPLETED: 1, FAILED: 0 }); // банкны шүүлт тоолуурт үйлчилнэ
    const officerFailed = await h.analysis.listAllJobs(OFFICER, { status: ['FAILED'] });
    expect(officerFailed.page.total).toBe(0);
    expect(officerFailed.counts.COMPLETED).toBe(2);
    expect((await h.analysis.listAllJobs(OFFICER, { bankCode: 'MBANK' })).page.total).toBe(1);
  });

  it('checks access to a single analysis when analysisId is given', async () => {
    const { h, mine, colleague } = await seed();
    expect((await h.analysis.listAllJobs(OFFICER, { analysisId: mine })).page.total).toBe(2);
    expect((await h.analysis.listAllJobs(MANAGER, { analysisId: colleague })).page.total).toBe(1);
    await expect(h.analysis.listAllJobs(OFFICER, { analysisId: colleague })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(h.analysis.listAllJobs(OTHER_ORG, { analysisId: mine })).rejects.toMatchObject({ status: 404 });
    expect(ORG).toBe(OFFICER.orgId);
  });

  it('clamps the page size', async () => {
    const { h } = await seed();
    expect((await h.analysis.listAllJobs(ADMIN, {}, { limit: 100_000, offset: 0 })).page.limit).toBeLessThan(100_000);
    expect((await h.analysis.listAllJobs(ADMIN, {}, { limit: 0, offset: -5 })).page).toMatchObject({ limit: 1, offset: 0 });
  });
});
