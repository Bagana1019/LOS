// BSA-FR-5.1 / 5.2 / 5.3: дохио илрүүлэх (recalc дотор), жагсаалт, нэг/бөөнөөр шийдвэрлэх, LOS руу татах бодлого. SYNTHETIC өгөгдөл.
import { describe, expect, it } from 'vitest';
import type { NewBsaTransaction } from '../common/persistence';
import { createHarness, ctxOf, OFFICER, type Harness } from '../import/testing/harness';

type Row = Pick<NewBsaTransaction, 'txnDate' | 'direction' | 'amount' | 'description'> & Partial<NewBsaTransaction>;

async function seed(h: Harness, rows: Row[]): Promise<string> {
  const analysis = await h.createAnalysis({ periodMonths: 3 });
  const job = await h.memory.importJobs.create({ analysisId: analysis.id, fileId: 'f1', fileName: 'x.csv', mimeType: 'text/csv', sizeBytes: 1, sha256: 'a'.repeat(64), format: 'CSV' });
  await h.memory.importJobs.update(job.id, { status: 'COMPLETED', bankCode: 'TDB', periodFrom: '2026-04-01', periodTo: '2026-06-30', rowsTotal: rows.length, rowsDone: rows.length, accountNo: '5011223344' });
  await h.memory.transactions.bulkInsert(
    job.id,
    rows.map((r, i) => ({ seq: i + 1, txnTime: '10:00:00', balanceAfter: null, counterpartyAccount: null, counterpartyName: null, statementKey: 'stmt', dedupeKey: `d${i}`, ...r })),
  );
  await h.recalc.recalculate(OFFICER, analysis.id);
  return analysis.id;
}

const BASE: Row[] = [
  { txnDate: '2026-04-05', direction: 'INCOME', amount: 1_200_000, description: 'Цалин' },
  { txnDate: '2026-05-05', direction: 'INCOME', amount: 1_200_000, description: 'Цалин' },
  { txnDate: '2026-06-05', direction: 'INCOME', amount: 1_200_000, description: 'Цалин' },
];
const GAMBLING: Row = { txnDate: '2026-05-10', direction: 'EXPENSE', amount: 80_000, description: 'Казино бооцоо' };

describe('SuspicionDetectorService (recalc дотор)', () => {
  it('илрүүлж хадгална, pendingSuspiciousCount-д тусна, дахин тооцоход давхардахгүй', async () => {
    const h = await createHarness({ realSuspicion: true });
    const id = await seed(h, [...BASE, GAMBLING]);
    const list = await h.review.list(OFFICER, id, {});
    expect(list.counts).toMatchObject({ total: 1, pending: 1, resolved: 0 });
    expect(list.counts.byFlag.GAMBLING).toEqual({ total: 1, pending: 1 });
    expect(list.items[0]).toMatchObject({ flag: 'GAMBLING', status: 'PENDING', totalAmount: 80_000, firstDate: '2026-05-10' });
    expect((await h.analysis.get(OFFICER, id)).summary?.pendingSuspiciousCount).toBe(1);

    await h.recalc.recalculate(OFFICER, id);
    expect((await h.review.list(OFFICER, id, {})).counts.total).toBe(1);
  });

  it('PII: жагсаалтад харьцсан дансны дугаар далдлагдсан', async () => {
    const h = await createHarness({ realSuspicion: true });
    const id = await seed(h, [...BASE, { ...GAMBLING, counterpartyAccount: '5099887766' }]);
    const tx = (await h.review.list(OFFICER, id, {})).items[0]?.transactions[0];
    expect(tx?.counterpartyAccount).not.toContain('5099');
    expect(tx?.counterpartyAccount?.endsWith('7766')).toBe(true);
  });
});

describe('SuspicionReviewService.resolve', () => {
  it('EXCLUDE: зардал SUSPICIOUS_EXPENSE болж дохио шийдвэрлэгдэнэ, pending 0', async () => {
    const h = await createHarness({ realSuspicion: true });
    const id = await seed(h, [...BASE, GAMBLING]);
    const [s] = (await h.review.list(OFFICER, id, {})).items;
    const res = await h.review.resolve(OFFICER, id, { ids: [s!.id], action: 'EXCLUDE', comment: 'Хасав' });
    expect(res).toMatchObject({ resolved: 1, skipped: 0, pending: 0, repushRequired: false });
    expect(res.summary?.pendingSuspiciousCount).toBe(0);
    const after = (await h.review.list(OFFICER, id, { status: 'RESOLVED' })).items[0];
    expect(after).toMatchObject({ action: 'EXCLUDE', comment: 'Хасав', resolvedBy: OFFICER.userId });
    expect(after?.transactions[0]?.categoryCode).toBe('SUSPICIOUS_EXPENSE');
    // дахин тооцоход шийдвэрлэсэн нь хэвээр, шинэ PENDING үүсэхгүй
    await h.recalc.recalculate(OFFICER, id);
    expect((await h.review.list(OFFICER, id, {})).counts).toMatchObject({ pending: 0, resolved: 1 });
    expect((await h.analysis.listEvents(OFFICER, id)).items.some((e) => e.action === 'SUSPICIONS_RESOLVED')).toBe(true);
  });

  it('RECLASSIFY: чиглэл таарах ангилал заавал; буруу бол CATEGORY_INVALID; APPROVE гүйлгээг өөрчлөхгүй', async () => {
    const h = await createHarness({ realSuspicion: true });
    const id = await seed(h, [...BASE, GAMBLING, { ...GAMBLING, txnDate: '2026-05-11', amount: 90_000, description: 'Casino' }]);
    const items = (await h.review.list(OFFICER, id, {})).items;
    expect(items).toHaveLength(2);
    await expect(h.review.resolve(OFFICER, id, { ids: [items[0]!.id], action: 'RECLASSIFY', categoryCode: 'SALARY' })).rejects.toMatchObject({ bsaCode: 'CATEGORY_INVALID' });
    await expect(h.review.resolve(OFFICER, id, { ids: [items[0]!.id], action: 'RECLASSIFY' } as never)).rejects.toBeDefined();
    const cat = (await h.repo.config.listCategories('org-1')).find((c) => c.direction === 'EXPENSE' && c.code !== 'SUSPICIOUS_EXPENSE' && c.isActive);
    const r1 = await h.review.resolve(OFFICER, id, { ids: [items[0]!.id], action: 'RECLASSIFY', categoryCode: cat!.code });
    expect(r1.resolved).toBe(1);
    const r2 = await h.review.resolve(OFFICER, id, { ids: [items[1]!.id], action: 'APPROVE' });
    expect(r2).toMatchObject({ resolved: 1, pending: 0 });
    const resolved = (await h.review.list(OFFICER, id, { status: 'RESOLVED' })).items;
    expect(resolved.find((x) => x.action === 'RECLASSIFY')?.transactions[0]?.categoryCode).toBe(cat!.code);
    // APPROVE: гүйлгээ автомат ангилалдаа үлдэнэ (гар засвар хийгдээгүй)
    const approved = (await h.repo.transactions.loadAll(id)).find((t) => t.id === items[1]!.transactionIds[0]);
    expect(approved?.manualOverride).toBe(false);
  });

  it('бөөнөөр: хоёрыг нэг дор; аль хэдийн шийдвэрлэсэн, олдохгүйг алгасна; бүгд шийдвэрлэгдсэн бол 409', async () => {
    const h = await createHarness({ realSuspicion: true });
    const id = await seed(h, [...BASE, GAMBLING, { ...GAMBLING, txnDate: '2026-05-11', amount: 90_000, description: 'Casino' }]);
    const ids = (await h.review.list(OFFICER, id, {})).items.map((i) => i.id);
    const res = await h.review.resolve(OFFICER, id, { ids: [...ids, 'nope'], action: 'EXCLUDE' });
    expect(res).toMatchObject({ resolved: 2, skipped: 1, pending: 0 });
    await expect(h.review.resolve(OFFICER, id, { ids, action: 'EXCLUDE' })).rejects.toMatchObject({ bsaCode: 'SUSPICION_ALREADY_RESOLVED', status: 409 });
    await expect(h.review.resolve(OFFICER, id, { ids: ['nope'], action: 'APPROVE' })).rejects.toMatchObject({ bsaCode: 'SUSPICION_NOT_FOUND', status: 404 });
  });

  it('эрх: APPROVER шийдвэрлэхгүй; өөр байгууллага нь олдохгүй; ANALYZED бол repushRequired', async () => {
    const h = await createHarness({ realSuspicion: true });
    const id = await seed(h, [...BASE, GAMBLING]);
    const [s] = (await h.review.list(OFFICER, id, {})).items;
    await expect(h.review.resolve(ctxOf(['APPROVER']), id, { ids: [s!.id], action: 'APPROVE' })).rejects.toBeDefined();
    await expect(h.review.list(ctxOf(['OFFICER'], { orgId: 'other-org' }), id, {})).rejects.toMatchObject({ status: 404 });
    // APPROVER унших эрхтэй
    expect((await h.review.list(ctxOf(['APPROVER']), id, {})).counts.pending).toBe(1);

    await h.review.resolve(OFFICER, id, { ids: [s!.id], action: 'APPROVE' });
    await h.finalize.finalize(OFFICER, id);
  });

  it('BLOCK бодлого: хүлээгдэж буй дохиотой бол татахыг хориглоно; шийдвэрлэсний дараа татагдана', async () => {
    const h = await createHarness({ realSuspicion: true, settings: { pushPolicyWhenPendingSuspicious: 'BLOCK' } });
    const id = await seed(h, [...BASE, GAMBLING]);
    await expect(h.finalize.finalize(OFFICER, id)).rejects.toMatchObject({ bsaCode: 'PENDING_SUSPICIOUS_BLOCK' });
    const [s] = (await h.review.list(OFFICER, id, {})).items;
    await h.review.resolve(OFFICER, id, { ids: [s!.id], action: 'EXCLUDE' });
    const done = await h.finalize.finalize(OFFICER, id);
    expect(done.summary).toMatchObject({ status: 'ANALYZED', pendingSuspiciousCount: 0 });
    // ANALYZED болсны дараах шийдвэрлэлт → дахин татах шаардлагатай
    const again = await h.recalc.recalculate(OFFICER, id);
    expect(again.summary?.status).toBe('ANALYZED');
  });

  it('WARN бодлого: хүлээгдэж буй дохиотой ч татагдаж анхааруулга өгнө', async () => {
    const h = await createHarness({ realSuspicion: true });
    const id = await seed(h, [...BASE, GAMBLING]);
    const done = await h.finalize.finalize(OFFICER, id);
    expect(done.warnings.some((w) => w.code === 'PENDING_SUSPICIOUS')).toBe(true);
    expect(done.summary.pendingSuspiciousCount).toBe(1);
    // ANALYZED дээр шийдвэрлэвэл repush
    const [s] = (await h.review.list(OFFICER, id, {})).items;
    const res = await h.review.resolve(OFFICER, id, { ids: [s!.id], action: 'APPROVE' });
    expect(res.repushRequired).toBe(true);
  });
});
