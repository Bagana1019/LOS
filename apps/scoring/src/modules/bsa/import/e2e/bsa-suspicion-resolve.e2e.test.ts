// BSA-FR-5.2 HTTP e2e (in-memory, жинхэнэ BsaModule + supertest): сэжигтэй дохио шийдвэрлэх хариу нь `@los/contracts`-ын схемтэй таарч (web яг тэрийг уншина),
// ангилал үнэхээр хэд солигдсоныг (changedTransactions) ба чиглэл таарахгүй хэд хэвээр үлдсэнийг (unchangedTransactions) хэлнэ. Өгөгдөл SYNTHETIC.
import { BsaResolveSuspicionsResponse } from '@los/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import type { NewBsaTransaction } from '../../common/persistence';
import { createE2eApp, type E2eApp } from './e2e-app';
import { allTransactions, createAnalysis } from './flow';

let current: E2eApp | null = null;
afterEach(async () => {
  await current?.close();
  current = null;
});

type Row = Pick<NewBsaTransaction, 'txnDate' | 'direction' | 'amount' | 'description'> & Partial<NewBsaTransaction>;

const SALARY = (txnDate: string): Row => ({ txnDate, direction: 'INCOME', amount: 1_200_000, description: 'Цалин' });
// Орж ирээд ойролцоо дүнтэй буцсан: нэг дохио, хоёр чиглэл
const PAIR_DESCRIPTION = 'Шилжүүлэг';
const PAIR: Row[] = [
  { txnDate: '2026-05-01', direction: 'INCOME', amount: 1_000_000, description: PAIR_DESCRIPTION, counterpartyAccount: 'A1' },
  { txnDate: '2026-05-02', direction: 'EXPENSE', amount: 1_010_000, description: PAIR_DESCRIPTION, counterpartyAccount: 'A1' },
];

/** Шинжилгээ + гүйлгээ (хоёр чиглэлийн хос) + нэг CIRCULAR дохио; буцаах: шинжилгээний id ба дохионы id */
async function seedCircular(e: E2eApp): Promise<{ id: string; signalId: string }> {
  const { id } = await createAnalysis(e.api);
  const memory = e.memory!;
  const job = await memory.importJobs.create({ analysisId: id, fileId: 'f1', fileName: 'x.csv', mimeType: 'text/csv', sizeBytes: 1, sha256: 'a'.repeat(64), format: 'CSV' });
  await memory.importJobs.update(job.id, { status: 'COMPLETED', bankCode: 'TDB', periodFrom: '2026-04-01', periodTo: '2026-06-30', rowsTotal: 5, rowsDone: 5, accountNo: '5011223344' });
  const rows: Row[] = [SALARY('2026-04-05'), SALARY('2026-05-05'), SALARY('2026-06-05'), ...PAIR];
  await memory.transactions.bulkInsert(
    job.id,
    rows.map((r, i) => ({ seq: i + 1, txnTime: '10:00:00', balanceAfter: null, counterpartyAccount: null, counterpartyName: null, statementKey: 'stmt', dedupeKey: `d${i}`, ...r })),
  );
  const recalc = await e.api.post(`/bsa/analyses/${id}/recalculate`, { proposedMonthlyPayment: 400_000 });
  expect(recalc.status, JSON.stringify(recalc.body)).toBe(200);
  const pair = (await allTransactions(e.api, id)).filter((t) => t.description === PAIR_DESCRIPTION);
  expect(pair).toHaveLength(2);
  await memory.suspicions.sync(id, [{ detectKey: 'k-circular', flag: 'CIRCULAR', transactionIds: pair.map((t) => t.id), confidence: 80, autoResolved: false }]);
  const [signal] = (await e.api.get(`/bsa/analyses/${id}/suspicions`)).body.items as Array<{ id: string }>;
  return { id, signalId: signal!.id };
}

describe('POST /bsa/analyses/:id/suspicions/resolve (F6-10 follow-up)', () => {
  it('RECLASSIFY to an income category: the body matches the shared contract and reports 1 changed, 1 left on a direction mismatch', async () => {
    current = await createE2eApp();
    const { id, signalId } = await seedCircular(current);
    const res = await current.api.post(`/bsa/analyses/${id}/suspicions/resolve`, { ids: [signalId], action: 'RECLASSIFY', categoryCode: 'SALARY' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = BsaResolveSuspicionsResponse.parse(res.body);
    expect(body).toMatchObject({ resolved: 1, skipped: 0, pending: 0, changedTransactions: 1, unchangedTransactions: 1 });
    const rewritten = (await allTransactions(current.api, id)).filter((t) => t.manualOverride);
    expect(rewritten).toHaveLength(body.changedTransactions);
    expect(rewritten[0]).toMatchObject({ categoryCode: 'SALARY', direction: 'INCOME', description: PAIR_DESCRIPTION });
  });

  it('EXCLUDE reports both directions changed; repeating the same request answers 409', async () => {
    current = await createE2eApp();
    const { id, signalId } = await seedCircular(current);
    const res = await current.api.post(`/bsa/analyses/${id}/suspicions/resolve`, { ids: [signalId], action: 'EXCLUDE' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(BsaResolveSuspicionsResponse.parse(res.body)).toMatchObject({ resolved: 1, changedTransactions: 2, unchangedTransactions: 0 });
    expect((await current.api.post(`/bsa/analyses/${id}/suspicions/resolve`, { ids: [signalId], action: 'EXCLUDE' })).status).toBe(409);
  });

  it('APPROVE changes no transaction: both counts are 0', async () => {
    current = await createE2eApp();
    const { id, signalId } = await seedCircular(current);
    const res = await current.api.post(`/bsa/analyses/${id}/suspicions/resolve`, { ids: [signalId], action: 'APPROVE' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(BsaResolveSuspicionsResponse.parse(res.body)).toMatchObject({ resolved: 1, changedTransactions: 0, unchangedTransactions: 0 });
  });
});
