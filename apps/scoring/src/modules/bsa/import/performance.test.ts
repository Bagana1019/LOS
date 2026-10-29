// NFR-1: 2 PDF × ~1250 мөр (PDF текст давхарга → parse → verify → classify → DTI → хадгалалт) < 30 секунд. In-memory port, ЖИНХЭНЭ parser,
// SYNTHETIC өгөгдөл. Бодит банкны том хуулга болон Postgres-тэй хугацаа энэ тестээр БАТАЛГААЖААГҮЙ (TODO(samples)).
import { describe, expect, it } from 'vitest';
import { generateTransactions, type SynTxn } from '../parsers/engine/testing/synthetic-statement';
import { createHarness, OFFICER } from './testing/harness';
import { ACCOUNT_A, ACCOUNT_B, HOLDER } from './testing/scenario';
import { buildStatementFile } from './testing/statement-files';

const ROWS = 1250;
const BUDGET_MS = 30_000;

/** Helvetica Кирилл бичиж чадахгүй тул Latin тайлбар (Кирилл тайлбарыг «Transfer other» болгоно) */
const latin = (rows: SynTxn[]): SynTxn[] => rows.map((t) => (/^[\x20-\x7e]+$/.test(t.description) ? t : { ...t, description: 'Transfer other' }));

describe('performance: two ~1250-row PDF statements', () => {
  it(`parse + verify + classify + DTI finish in under ${BUDGET_MS / 1000} s`, async () => {
    const h = await createHarness();
    const analysis = await h.createAnalysis({ proposedMonthlyPayment: 300_000 });
    const a = await buildStatementFile({
      bank: 'TDB', format: 'pdf', txns: latin(generateTransactions({ seed: 101, count: ROWS, startDate: '2026-04-01', withTime: true, perDay: 14 }, 3_000_000)),
      accountNo: ACCOUNT_A, iban: null, holder: HOLDER, fileName: 'perf-a.pdf', overrides: { rowsPerPage: 50 },
    });
    const b = await buildStatementFile({
      bank: 'MBANK', format: 'pdf', txns: latin(generateTransactions({ seed: 202, count: ROWS, startDate: '2026-04-01', withTime: true, perDay: 14 }, 3_000_000)),
      accountNo: ACCOUNT_B, iban: null, holder: HOLDER, fileName: 'perf-b.pdf', overrides: { rowsPerPage: 50 },
    });
    expect(a.expected.transactions).toHaveLength(ROWS);
    expect(b.expected.transactions).toHaveLength(ROWS);

    const started = performance.now();
    const res = await h.uploadFiles(analysis.id, [a, b]);
    const elapsed = performance.now() - started;

    expect(res.accepted).toBe(2);
    const jobs = await h.jobs(analysis.id);
    expect(jobs.map((j) => j.status)).toEqual(['COMPLETED', 'COMPLETED']);
    expect(jobs.map((j) => j.rowsDone)).toEqual([ROWS, ROWS]);
    const summary = (await h.analysis.get(OFFICER, analysis.id)).summary;
    expect(summary?.transactionCount).toBeGreaterThan(2000);
    expect(summary?.dtiPercent).toBeGreaterThanOrEqual(0);
    console.log(`perf: 2 x ${ROWS} rows imported in ${Math.round(elapsed)} ms`);
    expect(elapsed).toBeLessThan(BUDGET_MS);
  }, 120_000);

  it('a recalculation over ~2500 stored rows is fast as well', async () => {
    const h = await createHarness();
    const analysis = await h.createAnalysis();
    const a = await buildStatementFile({
      bank: 'TDB', format: 'csv', txns: generateTransactions({ seed: 7, count: 2500, startDate: '2026-04-01', withTime: true, perDay: 28 }, 3_000_000),
      accountNo: ACCOUNT_A, iban: null, holder: HOLDER, fileName: 'perf-a.csv',
    });
    await h.uploadFiles(analysis.id, [a]);
    expect((await h.jobs(analysis.id))[0]).toMatchObject({ status: 'COMPLETED', rowsDone: 2500 });
    const started = performance.now();
    const res = await h.recalc.recalculate(OFFICER, analysis.id);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(BUDGET_MS / 3);
    // Хугацааны цонхоос гадуурх мөр тооцоонд ороогүй ч бүгд хадгалагдсан
    expect(res.details?.transactions.inPeriod).toBe(res.summary?.transactionCount);
    expect((res.details?.transactions.inPeriod ?? 0) + (res.details?.transactions.outOfPeriod ?? 0)).toBe(2500);
  }, 120_000);
});
