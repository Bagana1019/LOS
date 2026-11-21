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

// F6-10 follow-up: the response counts what the server REALLY updated (setManualCategory's own count), so the web never re-derives it.
describe('SuspicionReviewService.resolve: transaction impact', () => {
  // Орж ирээд ойролцоо дүнтэй буцсан = CIRCULAR: нэг орлого + нэг зарлага (нэг дохио, хоёр чиглэл)
  const PAIR: Row[] = [
    { txnDate: '2026-05-01', direction: 'INCOME', amount: 1_000_000, description: 'Шилжүүлэг', counterpartyAccount: 'A1' },
    { txnDate: '2026-05-02', direction: 'EXPENSE', amount: 1_010_000, description: 'Шилжүүлэг', counterpartyAccount: 'A1' },
  ];
  const INCOME_CATEGORY = 'SALARY';
  const EXPENSE_CATEGORY = 'LOAN_PAYMENT';

  async function circularPair(extra: Row[] = []) {
    const h = await createHarness({ realSuspicion: true });
    const id = await seed(h, [...BASE, ...PAIR, ...extra]);
    const signal = (await h.review.list(OFFICER, id, {})).items.find((i) => i.flag === 'CIRCULAR');
    expect(signal, 'fixture must contain a CIRCULAR signal').toBeDefined();
    const txn = async (direction: 'INCOME' | 'EXPENSE') => (await h.repo.transactions.loadAll(id)).find((t) => signal!.transactionIds.includes(t.id) && t.direction === direction)!;
    return { h, id, signal: signal!, income: await txn('INCOME'), expense: await txn('EXPENSE'), reload: txn };
  }
  const row = async (h: Harness, id: string, txnId: string) => (await h.repo.transactions.loadAll(id)).find((t) => t.id === txnId)!;

  it('RECLASSIFY to an income category on an income+expense pair: 1 changed, 1 left because its direction does not match', async () => {
    const { h, id, signal, income, expense } = await circularPair();
    const res = await h.review.resolve(OFFICER, id, { ids: [signal.id], action: 'RECLASSIFY', categoryCode: INCOME_CATEGORY });
    expect(res).toMatchObject({ resolved: 1, skipped: 0, changedTransactions: 1, unchangedTransactions: 1 });
    expect(await row(h, id, income.id)).toMatchObject({ categoryCode: INCOME_CATEGORY, manualOverride: true });
    expect(await row(h, id, expense.id)).toMatchObject({ categoryCode: expense.categoryCode, manualOverride: false });
  });

  it('RECLASSIFY to an expense category on the same pair: the income leg is the one left unchanged', async () => {
    const { h, id, signal, income, expense } = await circularPair();
    const res = await h.review.resolve(OFFICER, id, { ids: [signal.id], action: 'RECLASSIFY', categoryCode: EXPENSE_CATEGORY });
    expect(res).toMatchObject({ resolved: 1, changedTransactions: 1, unchangedTransactions: 1 });
    expect(await row(h, id, expense.id)).toMatchObject({ categoryCode: EXPENSE_CATEGORY, manualOverride: true });
    expect(await row(h, id, income.id)).toMatchObject({ categoryCode: income.categoryCode, manualOverride: false });
  });

  it('RECLASSIFY where every touched transaction matches the direction: all changed, none left', async () => {
    const h = await createHarness({ realSuspicion: true });
    const id = await seed(h, [...BASE, GAMBLING, { ...GAMBLING, txnDate: '2026-05-11', amount: 90_000, description: 'Casino' }]);
    const ids = (await h.review.list(OFFICER, id, {})).items.map((i) => i.id);
    expect(ids).toHaveLength(2);
    const res = await h.review.resolve(OFFICER, id, { ids, action: 'RECLASSIFY', categoryCode: EXPENSE_CATEGORY });
    expect(res).toMatchObject({ resolved: 2, changedTransactions: 2, unchangedTransactions: 0 });
  });

  it('RECLASSIFY where nothing matches the direction is still rejected and changes nothing', async () => {
    const h = await createHarness({ realSuspicion: true });
    const id = await seed(h, [...BASE, GAMBLING]);
    const [s] = (await h.review.list(OFFICER, id, {})).items;
    await expect(h.review.resolve(OFFICER, id, { ids: [s!.id], action: 'RECLASSIFY', categoryCode: INCOME_CATEGORY })).rejects.toMatchObject({ bsaCode: 'CATEGORY_INVALID' });
    expect((await h.repo.transactions.loadAll(id)).filter((t) => t.manualOverride)).toHaveLength(0);
    expect((await h.review.list(OFFICER, id, {})).counts.pending).toBe(1);
  });

  it('EXCLUDE changes both directions: 2 changed, none left', async () => {
    const { h, id, signal, income, expense } = await circularPair();
    const res = await h.review.resolve(OFFICER, id, { ids: [signal.id], action: 'EXCLUDE' });
    expect(res).toMatchObject({ resolved: 1, changedTransactions: 2, unchangedTransactions: 0 });
    expect((await row(h, id, income.id)).categoryCode).toBe('SUSPICIOUS_INCOME');
    expect((await row(h, id, expense.id)).categoryCode).toBe('SUSPICIOUS_EXPENSE');
  });

  it('APPROVE changes no transaction, so both counts are 0', async () => {
    const { h, id, signal } = await circularPair();
    const res = await h.review.resolve(OFFICER, id, { ids: [signal.id], action: 'APPROVE' });
    expect(res).toMatchObject({ resolved: 1, changedTransactions: 0, unchangedTransactions: 0 });
    expect((await h.repo.transactions.loadAll(id)).filter((t) => t.manualOverride)).toHaveLength(0);
  });

  it('the reported change equals the rows really written (ground truth, not a prediction)', async () => {
    const { h, id, signal } = await circularPair();
    const res = await h.review.resolve(OFFICER, id, { ids: [signal.id], action: 'EXCLUDE' });
    expect((await h.repo.transactions.loadAll(id)).filter((t) => t.manualOverride)).toHaveLength(res.changedTransactions);
  });

  it('OWN_ACCOUNT: the auto-resolved own-transfer signal is skipped and its transactions are neither changed nor counted', async () => {
    // Өөрийн данс хоорондын шилжүүлэг = өөр хуулгын ижил өдөр, ижил дүнтэй эсрэг хос (BSA-BR-5)
    const own: Row[] = [
      { txnDate: '2026-05-28', direction: 'INCOME', amount: 500_000, description: 'Шилжүүлэг' },
      { txnDate: '2026-05-28', direction: 'EXPENSE', amount: 500_000, description: 'Шилжүүлэг', statementKey: 'stmt-2' },
    ];
    const h = await createHarness({ realSuspicion: true });
    const id = await seed(h, [...BASE, ...own, GAMBLING]);
    const items = (await h.review.list(OFFICER, id, {})).items;
    const ownSignal = items.find((i) => i.flag === 'OWN_ACCOUNT');
    const gambling = items.find((i) => i.flag === 'GAMBLING');
    expect(ownSignal, 'fixture must contain an OWN_ACCOUNT signal').toMatchObject({ status: 'RESOLVED' });
    expect(gambling).toMatchObject({ status: 'PENDING' });

    const res = await h.review.resolve(OFFICER, id, { ids: [ownSignal!.id, gambling!.id], action: 'EXCLUDE' });
    expect(res).toMatchObject({ resolved: 1, skipped: 1, changedTransactions: 1, unchangedTransactions: 0 });
    for (const txnId of ownSignal!.transactionIds) expect(await row(h, id, txnId)).toMatchObject({ isOwnTransfer: true, manualOverride: false });
  });

  it('OWN_ACCOUNT: an own-account transfer inside a pending signal is left alone and not counted as changed or unchanged', async () => {
    const { h, id, signal, expense } = await circularPair();
    await h.repo.transactions.updateClassifications(id, [{ id: expense.id, categoryCode: 'NON_EXPENSE', categoryGroup: 'F', confidence: 100, channel: 'TRANSFER', isOwnTransfer: true }]);
    const res = await h.review.resolve(OFFICER, id, { ids: [signal.id], action: 'EXCLUDE' });
    expect(res).toMatchObject({ resolved: 1, changedTransactions: 1, unchangedTransactions: 0 });
    expect(await row(h, id, expense.id)).toMatchObject({ categoryCode: 'NON_EXPENSE', isOwnTransfer: true, manualOverride: false });
  });

  it('a transaction shared by two selected signals is changed (and counted) once', async () => {
    const h = await createHarness();
    const id = await seed(h, [...BASE, ...PAIR, { txnDate: '2026-05-03', direction: 'EXPENSE', amount: 20_000, description: 'Бэлэн авсан' }]);
    const [inc, exp1, exp2] = (await h.repo.transactions.loadAll(id)).filter((t) => t.txnDate >= '2026-05-01' && t.txnDate <= '2026-05-03').sort((a, b) => a.txnDate.localeCompare(b.txnDate));
    await h.memory.suspicions.sync(id, [
      { detectKey: 'k-circular', flag: 'CIRCULAR', transactionIds: [inc!.id, exp1!.id], confidence: 80, autoResolved: false },
      { detectKey: 'k-quick', flag: 'QUICK_CASH', transactionIds: [inc!.id, exp2!.id], confidence: 70, autoResolved: false },
    ]);
    const ids = (await h.review.list(OFFICER, id, {})).items.map((i) => i.id);
    expect(ids).toHaveLength(2);
    const res = await h.review.resolve(OFFICER, id, { ids, action: 'EXCLUDE' });
    expect(res).toMatchObject({ resolved: 2, changedTransactions: 3, unchangedTransactions: 0 });
  });
});
