// BSA импортын pipeline: upload → worker → parse → verify → classify → DTI. In-memory port + ЖИНХЭНЭ parser/classifier/calc,
// SYNTHETIC файл. Parser-ууд бодит хуулгаар баталгаажаагүй (TODO(samples)) тул эдгээр тест нь pipeline-ийн логикийг шалгана,
// банкны бодит форматыг БИШ.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { BankCode } from '@los/contracts';
import { ObjectStoreError } from '../common/object-store';
import type { ObjectStore } from '../common/infra.ports';
import type { ImportIssue } from '../common/persistence';
import type { StatementParser } from '../parsers/statement.types';
import { createHarness, ADMIN, OFFICER, ctxOf, type Harness } from './testing/harness';
import { ACCOUNT_A, ACCOUNT_B, EXPECTED_HAPPY, HOLDER, OPENING_A, OPENING_B, accountATxns, accountBTxns, balanceBefore, happyFiles } from './testing/scenario';
import { buildStatementFile } from './testing/statement-files';
import { alterBalanceOfRow, setDeclaredCount } from './testing/tamper';

const FIXTURES = join(__dirname, '..', '..', '..', '..', 'test-fixtures', 'bsa', 'text-extraction');
const codes = (issues: readonly ImportIssue[]): string[] => issues.map((i) => i.code);

async function jobsByBank(h: Harness, analysisId: string): Promise<Record<string, Awaited<ReturnType<Harness['jobs']>>[number]>> {
  const jobs = await h.jobs(analysisId);
  return Object.fromEntries(jobs.map((j) => [j.bankCode ?? 'NONE', j]));
}

describe('ImportPipelineService: happy path', () => {
  it('imports two accounts of one customer, excludes the own transfer pair and computes the exact DTI', async () => {
    const h = await createHarness();
    const analysis = await h.createAnalysis();
    const { a, b } = await happyFiles();

    const upload = await h.uploadFiles(analysis.id, [a, b]);
    expect(upload).toMatchObject({ accepted: 2, duplicates: 0, rejected: 0 });

    const jobs = await jobsByBank(h, analysis.id);
    expect(jobs.TDB).toMatchObject({ status: 'COMPLETED', rowsTotal: 18, rowsDone: 18, periodFrom: '2026-04-01', periodTo: '2026-06-30' });
    expect(jobs.MBANK).toMatchObject({ status: 'COMPLETED', rowsTotal: 9, rowsDone: 9 });
    expect(jobs.TDB.errors).toEqual([]);
    // Parser баталгаажаагүй гэдгийг хэрэглэгчид анхааруулна
    expect(codes(jobs.TDB.warnings)).toContain('UNVERIFIED_PARSER');

    const stored = await h.analysis.get(OFFICER, analysis.id);
    expect(stored.summary).toMatchObject({
      status: 'DRAFT',
      periodMonths: EXPECTED_HAPPY.periodMonths,
      periodFrom: EXPECTED_HAPPY.periodFrom,
      periodTo: EXPECTED_HAPPY.periodTo,
      transactionCount: EXPECTED_HAPPY.transactionCount,
      totalMonthlyIncome: EXPECTED_HAPPY.totalMonthlyIncome,
      verifiedMonthlyIncome: EXPECTED_HAPPY.verifiedMonthlyIncome,
      dtiIncome: EXPECTED_HAPPY.dtiIncome,
      businessIncomeMonthly: EXPECTED_HAPPY.businessIncomeMonthly,
      businessExpenseMonthly: EXPECTED_HAPPY.businessExpenseMonthly,
      netCashFlowMonthly: EXPECTED_HAPPY.netCashFlowMonthly,
      existingDebtServiceMonthly: EXPECTED_HAPPY.existingDebtServiceMonthly,
      incomeReliability: 100,
      dtiPercent: EXPECTED_HAPPY.dtiPercent,
      dtiLevel: EXPECTED_HAPPY.dtiLevel,
      pendingSuspiciousCount: 0,
    });
    expect(stored.ownAccountCount).toBe(2);

    // Шилжүүлгийн хос (5/28 14:10, 500,000) хоёр талдаа «өөрийн шилжүүлэг» гэж тэмдэглэгдэнэ
    const rows = await h.memory.transactions.loadAll(analysis.id);
    expect(rows).toHaveLength(27);
    const own = rows.filter((r) => r.isOwnTransfer);
    expect(own.map((r) => [r.direction, r.amount, r.txnDate]).sort()).toEqual([
      ['EXPENSE', 500_000, '2026-05-28'],
      ['INCOME', 500_000, '2026-05-28'],
    ]);
    expect(rows.find((r) => r.description.includes('ZXQ-S04'))?.categoryCode).toBe('SALARY');
    expect(rows.find((r) => r.description.includes('ZXQ-R05'))?.categoryCode).toBe('PASSIVE_INCOME');
    expect(rows.find((r) => r.description.includes('ZXQ-L06'))?.categoryCode).toBe('LOAN_PAYMENT');
    // Дансны дугаар ил хадгалагдахгүй: statementKey нь hash
    expect(rows.every((r) => !r.statementKey.includes(ACCOUNT_A) && !r.statementKey.includes(ACCOUNT_B))).toBe(true);

    const report = await h.recalc.report(OFFICER, analysis.id);
    expect(report.summaryStale).toBe(false);
    expect(report.details?.dti.dtiRatio).toBeCloseTo(900_000 / 2_308_500, 10);
    expect(report.details?.dti.householdExpenseMonthly).toBe(EXPECTED_HAPPY.householdExpenseMonthly);
    expect(report.details?.transactions).toMatchObject({ inPeriod: 27, ownTransfers: 2, outOfPeriod: 0 });
    expect(report.details?.warnings).toEqual([]);

    // Domain event: ажил бүрт нэг StatementImported (outbox commit хийгдсэн)
    const imported = h.publisher.eventsOfType('StatementImported');
    expect(imported.map((e) => [e.status, e.rows]).sort()).toEqual([['COMPLETED', 18], ['COMPLETED', 9]]);
    expect(imported.every((e) => e.analysisId === analysis.id && e.applicationId === 'app-1')).toBe(true);
    expect(h.publisher.pending).toHaveLength(0);

    const events = await h.analysis.listEvents(OFFICER, analysis.id);
    const actions = events.items.map((e) => e.action);
    expect(actions.filter((x) => x === 'IMPORT_COMPLETED')).toHaveLength(2);
    expect(actions).toEqual(expect.arrayContaining(['ANALYSIS_CREATED', 'FILE_UPLOADED', 'RECALCULATED']));
  });

  it('is deterministic: the same files in the opposite order give the same summary', async () => {
    const first = await createHarness();
    const second = await createHarness();
    const x = await first.createAnalysis();
    const y = await second.createAnalysis();
    const { a, b } = await happyFiles();
    await first.uploadFiles(x.id, [a, b]);
    await second.uploadFiles(y.id, [b, a]);
    const s1 = (await first.analysis.get(OFFICER, x.id)).summary;
    const s2 = (await second.analysis.get(OFFICER, y.id)).summary;
    expect({ ...s1, analysisId: '' }).toEqual({ ...s2, analysisId: '' });
  });

  it('works with a PDF text layer (Latin synthetic layout)', async () => {
    const h = await createHarness();
    const analysis = await h.createAnalysis();
    const pdf = await happyFiles({ format: 'pdf' });
    const res = await h.uploadFiles(analysis.id, [pdf.a, pdf.b]);
    expect(res.accepted).toBe(2);
    const jobs = await h.jobs(analysis.id);
    // PDF-ийн үр дүн (Latin шошго) нь CSV-тэй ижил гүйлгээ уншина
    expect(jobs.map((j) => j.status)).toEqual(['COMPLETED', 'COMPLETED']);
    expect(jobs.reduce((n, j) => n + j.rowsDone, 0)).toBe(27);
  });

  it('async queue: upload returns PENDING jobs, the worker completes them later', async () => {
    const h = await createHarness({ queueMode: 'async' });
    const analysis = await h.createAnalysis();
    const { a } = await happyFiles();
    const res = await h.uploadFiles(analysis.id, [a]);
    expect(res.accepted).toBe(1);
    await h.queue.idle();
    const [job] = await h.jobs(analysis.id);
    expect(job.status).toBe('COMPLETED');
    expect(h.queue.getJob(job.id)?.state).toBe('completed');
  });

  it('a worker that starts after the upload still processes waiting jobs', async () => {
    const h = await createHarness({ startWorker: false });
    const analysis = await h.createAnalysis();
    const { a } = await happyFiles();
    await h.uploadFiles(analysis.id, [a]);
    expect((await h.jobs(analysis.id))[0].status).toBe('PENDING');
    await h.processor.start();
    expect((await h.jobs(analysis.id))[0].status).toBe('COMPLETED');
  });
});

describe('ImportPipelineService: overlapping statements (BSA-FR-2.4)', () => {
  it('stores each transaction once and reports the duplicates as a warning', async () => {
    const h = await createHarness();
    const analysis = await h.createAnalysis();
    const rows = accountATxns();
    // Нэг дансны 2 хуулга: [0..12) ба [6..18) — 6 мөр давхцана. Үлдэгдэл хоёр файлд ижил (глобал гинж).
    const a1 = await buildStatementFile({
      bank: 'TDB', txns: rows.slice(0, 12), opening: OPENING_A, accountNo: ACCOUNT_A, iban: null, holder: HOLDER, fileName: 'a1.csv',
    });
    const a2 = await buildStatementFile({
      bank: 'TDB', txns: rows.slice(6), opening: balanceBefore(rows, 6, OPENING_A), accountNo: ACCOUNT_A, iban: null, holder: HOLDER, fileName: 'a2.csv',
    });
    const { b } = await happyFiles();

    const res = await h.uploadFiles(analysis.id, [a1, a2, b]);
    expect(res.accepted).toBe(3);

    const jobs = (await h.jobs(analysis.id)).filter((j) => j.bankCode === 'TDB').sort((x, y) => x.fileName.localeCompare(y.fileName));
    expect(jobs.map((j) => j.status)).toEqual(['COMPLETED', 'COMPLETED']);
    // rowsDone = боловсруулсан мөр (явц); шинээр хадгалагдсан тоо нь warning ба StatementImported.rows-д
    expect(jobs.map((j) => [j.rowsTotal, j.rowsDone])).toEqual([[12, 12], [12, 12]]);
    expect(codes(jobs[1].warnings)).toContain('ROWS_SKIPPED_DUPLICATE');
    expect(jobs[1].warnings.find((w) => w.code === 'ROWS_SKIPPED_DUPLICATE')?.message).toContain('6');
    expect(h.publisher.eventsOfType('StatementImported').map((e) => e.rows).sort((x, y) => x - y)).toEqual([6, 9, 12]);
    expect(codes(jobs[0].warnings)).not.toContain('ROWS_SKIPPED_DUPLICATE');

    const counts = await h.analysis.transactionCounts(OFFICER, analysis.id);
    expect(counts.total).toBe(27);
    const summary = (await h.analysis.get(OFFICER, analysis.id)).summary;
    expect(summary).toMatchObject({
      transactionCount: 27,
      verifiedMonthlyIncome: EXPECTED_HAPPY.verifiedMonthlyIncome,
      dtiIncome: EXPECTED_HAPPY.dtiIncome,
      dtiPercent: EXPECTED_HAPPY.dtiPercent,
    });
    // Давхцлыг хэрэглэгчид тайланд харуулна
    const report = await h.recalc.report(OFFICER, analysis.id);
    expect(report.details?.warnings.map((w) => w.code)).toContain('STATEMENT_OVERLAP');
  });
});

describe('ImportPipelineService: verification failures (BSA-FR-2.2)', () => {
  it('rejects a statement whose balance chain was tampered with and stores NO rows', async () => {
    const h = await createHarness();
    const analysis = await h.createAnalysis();
    const bad = await buildStatementFile({
      bank: 'MBANK', txns: accountBTxns(), opening: OPENING_B, accountNo: ACCOUNT_B, iban: null, holder: HOLDER, fileName: 'bad.csv', tamper: alterBalanceOfRow(4),
    });
    await h.uploadFiles(analysis.id, [bad]);

    const [job] = await h.jobs(analysis.id);
    expect(job.status).toBe('FAILED');
    expect(codes(job.errors)).toContain('BALANCE_CHAIN_BREAK');
    expect(job.verifierOk).toBe(false);
    expect(job.rowsDone).toBe(0);
    expect(await h.memory.transactions.loadAll(analysis.id)).toHaveLength(0);
    expect((await h.analysis.get(OFFICER, analysis.id)).summary).toBeNull();

    const imported = h.publisher.eventsOfType('StatementImported');
    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({ status: 'FAILED', rows: 0 });
    // Дахин оролдлого хийхгүй: ажил эцсийн төлөвтэй, event нэг л удаа
    expect(h.publisher.pending).toHaveLength(0);
    expect(h.queue.getJob(job.id)?.state).toBe('failed');
  });

  it('flags a declared-row-count mismatch', async () => {
    const h = await createHarness();
    const analysis = await h.createAnalysis();
    const bad = await buildStatementFile({
      bank: 'MBANK', txns: accountBTxns(), opening: OPENING_B, accountNo: ACCOUNT_B, iban: null, holder: HOLDER, fileName: 'count.csv',
      overrides: { header: { showCount: true } }, tamper: setDeclaredCount(99),
    });
    await h.uploadFiles(analysis.id, [bad]);
    const [job] = await h.jobs(analysis.id);
    expect(job.status).toBe('FAILED');
    const mismatch = job.errors.find((e) => e.code === 'ROW_COUNT_MISMATCH');
    expect(mismatch).toBeDefined();
    // Мессеж зөвхөн тоо агуулна (PII биш)
    expect(mismatch?.message).toContain('99');
    expect(mismatch?.message).toContain('9');
    expect(await h.memory.transactions.loadAll(analysis.id)).toHaveLength(0);
  });

  it('the same declared count passes when it matches', async () => {
    const h = await createHarness();
    const analysis = await h.createAnalysis();
    const ok = await buildStatementFile({
      bank: 'MBANK', txns: accountBTxns(), opening: OPENING_B, accountNo: ACCOUNT_B, iban: null, holder: HOLDER, fileName: 'count-ok.csv',
      overrides: { header: { showCount: true } },
    });
    await h.uploadFiles(analysis.id, [ok]);
    expect((await h.jobs(analysis.id))[0]).toMatchObject({ status: 'COMPLETED', rowsDone: 9 });
  });

  it('fails an encrypted PDF with PDF_ENCRYPTED and a friendly message', async () => {
    const h = await createHarness();
    const analysis = await h.createAnalysis();
    const content = readFileSync(join(FIXTURES, 'encrypted-user-password.pdf'));
    const res = await h.upload.upload(OFFICER, analysis.id, [{ content, fileName: 'locked.pdf', mimeType: 'application/pdf' }]);
    expect(res.accepted).toBe(1);
    const [job] = await h.jobs(analysis.id);
    expect(job.status).toBe('FAILED');
    expect(codes(job.errors)).toEqual(['PDF_ENCRYPTED']);
    expect(job.errors[0].message.length).toBeGreaterThan(0);
    expect(job.format).toBe('PDF');
  });

  it('fails a statement of an unknown bank with BANK_NOT_DETECTED', async () => {
    const h = await createHarness();
    const analysis = await h.createAnalysis();
    const content = Buffer.from('Date,Item,Value\n2026-04-01,Something,100\n2026-04-02,Other,200\n', 'utf8');
    await h.upload.upload(OFFICER, analysis.id, [{ content, fileName: 'mystery.csv', mimeType: 'text/csv' }]);
    const [job] = await h.jobs(analysis.id);
    expect(job.status).toBe('FAILED');
    expect(codes(job.errors)).toEqual(['BANK_NOT_DETECTED']);
    expect(job.bankCode).toBeNull();
  });

  it('reports BANK_AMBIGUOUS when two banks match equally', async () => {
    const stub = (bank: BankCode): StatementParser => ({
      bank, id: `stub-${bank}`, verified: true, detect: () => 0.9,
      parse: () => { throw new Error('must not be called'); },
    });
    const h = await createHarness({ parsers: [stub('KHAN'), stub('TDB')] });
    const analysis = await h.createAnalysis();
    const content = Buffer.from('anything,here\n1,2\n', 'utf8');
    await h.upload.upload(OFFICER, analysis.id, [{ content, fileName: 'amb.csv', mimeType: 'text/csv' }]);
    const [job] = await h.jobs(analysis.id);
    expect(job.status).toBe('FAILED');
    expect(codes(job.errors)).toEqual(['BANK_AMBIGUOUS']);
  });

  it('handles a reversed debit/credit file: swaps the columns, warns, and gives the same DTI', async () => {
    const h = await createHarness();
    const analysis = await h.createAnalysis();
    const normal = await happyFiles();
    const reversed = await buildStatementFile({
      bank: 'MBANK', txns: accountBTxns(), opening: OPENING_B, accountNo: ACCOUNT_B, iban: null, holder: HOLDER, fileName: 'rev.csv',
      overrides: { debitIsIncome: true },
    });
    await h.uploadFiles(analysis.id, [normal.a, reversed]);
    const jobs = await jobsByBank(h, analysis.id);
    expect(jobs.MBANK.status).toBe('COMPLETED');
    expect(codes(jobs.MBANK.warnings)).toContain('DIRECTION_SWAPPED');
    const summary = (await h.analysis.get(OFFICER, analysis.id)).summary;
    expect(summary).toMatchObject({
      transactionCount: EXPECTED_HAPPY.transactionCount,
      verifiedMonthlyIncome: EXPECTED_HAPPY.verifiedMonthlyIncome,
      dtiPercent: EXPECTED_HAPPY.dtiPercent,
    });
  });

  it('fails a file with more rows than the configured maximum (TOO_MANY_ROWS)', async () => {
    const h = await createHarness({ options: { maxRowsPerFile: 5 } });
    const analysis = await h.createAnalysis();
    const { a } = await happyFiles();
    await h.uploadFiles(analysis.id, [a]);
    const [job] = await h.jobs(analysis.id);
    expect(job.status).toBe('FAILED');
    expect(codes(job.errors)).toEqual(['TOO_MANY_ROWS']);
    expect(await h.memory.transactions.loadAll(analysis.id)).toHaveLength(0);
  });

  it('fails with IMPORT_TIMEOUT when the job deadline has already passed', async () => {
    const h = await createHarness({ options: { jobTimeoutMs: -1 } });
    const analysis = await h.createAnalysis();
    const { a } = await happyFiles();
    await h.uploadFiles(analysis.id, [a]);
    const [job] = await h.jobs(analysis.id);
    expect(job.status).toBe('FAILED');
    expect(codes(job.errors)).toEqual(['IMPORT_TIMEOUT']);
  });

  it('fails with FILE_MISSING (no retry loop) when the stored object vanished', async () => {
    const h = await createHarness({ startWorker: false });
    const analysis = await h.createAnalysis();
    const { a } = await happyFiles();
    await h.uploadFiles(analysis.id, [a]);
    for (const key of h.store.keys()) await h.store.delete(key);
    await h.processor.start();
    const [job] = await h.jobs(analysis.id);
    expect(job.status).toBe('FAILED');
    expect(codes(job.errors)).toEqual(['FILE_MISSING']);
    expect(job.attempts).toBe(1);
  });
});

describe('ImportPipelineService: retries (attempt-aware)', () => {
  /** Эхний `failures` удаагийн get() алдаатай; алдааны мессежид PII байгаа ч хадгалагдах ёсгүй */
  const flakyStore = (state: { failures: number; reads: number }) => (inner: ObjectStore): ObjectStore => ({
    put: (k, b, c) => inner.put(k, b, c),
    delete: (k) => inner.delete(k),
    exists: (k) => inner.exists(k),
    get: async (k) => {
      state.reads += 1;
      if (state.failures > 0) {
        state.failures -= 1;
        throw new Error(`socket hang up while reading zxq-secret-a.csv of ${HOLDER} ${ACCOUNT_A}`);
      }
      return inner.get(k);
    },
  });

  it('a transient failure is retried and the job completes without a FAILED trace', async () => {
    const state = { failures: 1, reads: 0 };
    const h = await createHarness({ wrapStore: (s) => flakyStore(state)(s) });
    const analysis = await h.createAnalysis();
    const { a } = await happyFiles();
    await h.uploadFiles(analysis.id, [a]);

    const [job] = await h.jobs(analysis.id);
    expect(job).toMatchObject({ status: 'COMPLETED', attempts: 2, rowsDone: 18 });
    expect(job.errors).toEqual([]);
    expect(h.queue.getJob(job.id)).toMatchObject({ state: 'completed', attemptsMade: 2 });
    expect(h.publisher.eventsOfType('StatementImported').map((e) => e.status)).toEqual(['COMPLETED']);
    const actions = (await h.analysis.listEvents(OFFICER, analysis.id)).items.map((e) => e.action);
    expect(actions).not.toContain('IMPORT_FAILED');
    expect(await h.memory.transactions.loadAll(analysis.id)).toHaveLength(18);
  });

  it('the final attempt turns an unexpected error into INTERNAL_ERROR (no PII), then a manual retry succeeds', async () => {
    const state = { failures: 99, reads: 0 };
    const h = await createHarness({ attempts: 3, wrapStore: (s) => flakyStore(state)(s) });
    const analysis = await h.createAnalysis();
    const { a } = await happyFiles();
    await h.uploadFiles(analysis.id, [a]);

    const [job] = await h.jobs(analysis.id);
    expect(job.status).toBe('FAILED');
    expect(job.attempts).toBe(3);
    expect(codes(job.errors)).toEqual(['INTERNAL_ERROR']);
    expect(JSON.stringify(job.errors)).not.toMatch(/socket|zxq|Bold|5011223344/i);
    expect(h.queue.getJob(job.id)?.state).toBe('failed');
    expect(h.publisher.eventsOfType('StatementImported').map((e) => [e.status, e.rows])).toEqual([['FAILED', 0]]);
    expect(await h.memory.transactions.loadAll(analysis.id)).toHaveLength(0);

    // Хэрэглэгч «Дахин оролдох»-ыг дарна: ажил PENDING болж, дараалалд дахин орно
    state.failures = 0;
    const view = await h.upload.retryJob(OFFICER, analysis.id, job.id);
    expect(view.status).toBe('COMPLETED');
    const [again] = await h.jobs(analysis.id);
    expect(again).toMatchObject({ status: 'COMPLETED', rowsDone: 18, errors: [] });
    const actions = (await h.analysis.listEvents(OFFICER, analysis.id)).items.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['IMPORT_FAILED', 'JOB_RETRY_REQUESTED', 'IMPORT_COMPLETED']));
  });

  it('processing a finished job again is a no-op (no duplicate rows or events)', async () => {
    const h = await createHarness();
    const analysis = await h.createAnalysis();
    const { a } = await happyFiles();
    await h.uploadFiles(analysis.id, [a]);
    const [job] = await h.jobs(analysis.id);
    const again = await h.pipeline.processJob(job.id, { attempt: 1, attempts: 3, isLastAttempt: false });
    expect(again).toMatchObject({ kind: 'SKIPPED', reason: 'ALREADY_COMPLETED' });
    expect(await h.memory.transactions.loadAll(analysis.id)).toHaveLength(18);
    expect(h.publisher.eventsOfType('StatementImported')).toHaveLength(1);
    // Олдохгүй ажил: алдаа шидэхгүй, алгасана
    expect(await h.pipeline.processJob('00000000-0000-0000-0000-000000000000', { attempt: 1, attempts: 1, isLastAttempt: true })).toMatchObject({
      kind: 'SKIPPED', reason: 'NOT_FOUND',
    });
  });

  it('the import commit is atomic: a failure after the rows were inserted leaves no rows, no event, no summary', async () => {
    const h = await createHarness({ attempts: 1 });
    const analysis = await h.createAnalysis();
    const { a } = await happyFiles();
    const spy = vi.spyOn(h.recalc, 'run').mockRejectedValueOnce(new Error('boom after insert'));
    await h.uploadFiles(analysis.id, [a]);

    const [job] = await h.jobs(analysis.id);
    expect(spy).toHaveBeenCalled();
    expect(job.status).toBe('FAILED');
    expect(codes(job.errors)).toEqual(['INTERNAL_ERROR']);
    expect(await h.memory.transactions.loadAll(analysis.id)).toHaveLength(0);
    expect((await h.analysis.get(OFFICER, analysis.id)).summary).toBeNull();
    expect((await h.analysis.get(OFFICER, analysis.id)).ownAccountCount).toBe(0);
    expect(h.publisher.eventsOfType('StatementImported').map((e) => e.status)).toEqual(['FAILED']);
    const actions = (await h.analysis.listEvents(OFFICER, analysis.id)).items.map((e) => e.action);
    expect(actions).not.toContain('IMPORT_COMPLETED');
  });

  it('a non-last attempt rethrows an ObjectStore outage instead of failing the job', async () => {
    const h = await createHarness({ startWorker: false });
    const analysis = await h.createAnalysis();
    const { a } = await happyFiles();
    await h.uploadFiles(analysis.id, [a]);
    const [job] = await h.jobs(analysis.id);
    vi.spyOn(h.objects, 'get').mockRejectedValueOnce(new ObjectStoreError('BACKEND', 'minio down'));
    await expect(h.pipeline.processJob(job.id, { attempt: 1, attempts: 3, isLastAttempt: false })).rejects.toThrow('minio down');
    expect((await h.jobs(analysis.id))[0].status).toBe('PROCESSING');
    // Дараагийн оролдлого амжилттай
    const outcome = await h.pipeline.processJob(job.id, { attempt: 2, attempts: 3, isLastAttempt: false });
    expect(outcome).toMatchObject({ kind: 'COMPLETED', inserted: 18 });
  });
});

describe('ImportPipelineService: customer identity checks', () => {
  it('fails a statement whose holder is a different person (NAME_MISMATCH)', async () => {
    const h = await createHarness();
    const analysis = await h.createAnalysis();
    const other = await buildStatementFile({
      bank: 'MBANK', txns: accountBTxns(), opening: OPENING_B, accountNo: ACCOUNT_B, iban: null, holder: 'Zorigt Dorj', fileName: 'other.csv',
    });
    await h.uploadFiles(analysis.id, [other]);
    const [job] = await h.jobs(analysis.id);
    expect(job.status).toBe('FAILED');
    expect(codes(job.errors)).toContain('NAME_MISMATCH');
    expect(JSON.stringify(job.errors)).not.toContain('Zorigt');
  });

  it('a different org without a seeded category catalog cannot upload (CATALOG_INCOMPLETE)', async () => {
    const h = await createHarness();
    const stranger = ctxOf(['OFFICER'], { orgId: 'org-without-catalog' });
    const analysis = await h.createAnalysis({}, stranger);
    const { a } = await happyFiles();
    await expect(h.uploadFiles(analysis.id, [a], stranger)).rejects.toMatchObject({ bsaCode: 'CATALOG_INCOMPLETE' });
  });

  it('ADMIN can list jobs of any analysis in the org', async () => {
    const h = await createHarness();
    const analysis = await h.createAnalysis();
    const { a } = await happyFiles();
    await h.uploadFiles(analysis.id, [a]);
    expect((await h.analysis.listJobs(ADMIN, analysis.id)).items).toHaveLength(1);
  });
});
