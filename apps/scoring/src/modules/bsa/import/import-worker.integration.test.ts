// Import worker — БОДИТ Redis (BullMQ) дээр: UploadService -> BullmqImportQueue -> ImportProcessor -> pipeline. REDIS_URL_TEST тохируулаагүй бол алгасна.
// Repository/object store нь in-memory (DB-ийн хэсгийг import-pipeline.integration.test.ts шалгана). Тест бүр өөрийн BullMQ prefix-тэй,
// дуусахад зөвхөн тэр prefix-ийн түлхүүрүүдийг устгана. Хугацаа: бүх хүлээлт vi.waitFor (тогтмол sleep биш).
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BullmqImportQueue } from '../common/import-queue';
import type { ObjectStore } from '../common/infra.ports';
import { createHarness, OFFICER, type Harness } from './testing/harness';
import { ACCOUNT_B, EXPECTED_HAPPY, HOLDER, OPENING_B, accountBTxns, happyFiles } from './testing/scenario';
import { buildStatementFile } from './testing/statement-files';
import { alterBalanceOfRow } from './testing/tamper';
import { UploadService } from './upload.service';

const REDIS_URL = process.env.REDIS_URL_TEST;
const logger = { warn: () => undefined, error: () => undefined };
const WAIT = { timeout: 15_000, interval: 50 };

describe.skipIf(!REDIS_URL)('import worker on real Redis/BullMQ (REDIS_URL_TEST)', () => {
  let admin: Redis;
  let seq = 0;
  const opened: BullmqImportQueue[] = [];
  const prefixes: string[] = [];

  beforeAll(() => {
    admin = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(opened.splice(0).map((q) => q.close()));
    for (const p of prefixes.splice(0)) {
      const keys: string[] = [];
      let cursor = '0';
      do {
        const [next, batch] = await admin.scan(cursor, 'MATCH', `${p}:*`, 'COUNT', 500);
        cursor = next;
        keys.push(...batch);
      } while (cursor !== '0');
      if (keys.length > 0) await admin.del(...keys);
    }
  });
  afterAll(async () => {
    await admin.quit();
  });

  interface Rig {
    h: Harness;
    bull: BullmqImportQueue;
    upload: UploadService;
    getCalls: { n: number; failFirst: number };
  }

  /** Harness (in-memory repo) + жинхэнэ BullMQ queue дээр суусан UploadService ба worker */
  async function rig(attempts = 3, failFirstReads = 0): Promise<Rig> {
    seq += 1;
    const prefix = `bsa-wk-${process.pid}-${seq}`;
    prefixes.push(prefix);
    const getCalls = { n: 0, failFirst: failFirstReads };
    const h = await createHarness({
      startWorker: false,
      wrapStore: (inner): ObjectStore => ({
        put: (k, b, c) => inner.put(k, b, c),
        get: async (k) => {
          getCalls.n += 1;
          if (getCalls.n <= getCalls.failFirst) throw new Error('socket hang up (synthetic transient failure)');
          return inner.get(k);
        },
        exists: (k) => inner.exists(k),
        delete: (k) => inner.delete(k),
      }),
    });
    const bull = new BullmqImportQueue({ redisUrl: REDIS_URL!, prefix, attempts, backoffDelayMs: 20, concurrency: 1, logger });
    opened.push(bull);
    await bull.start(h.processor.handle);
    const upload = new UploadService(h.repo, { get: async () => h.settings }, h.objects, bull, h.clock);
    return { h, bull, upload, getCalls };
  }

  const toInputs = (files: Array<{ content: Buffer; fileName: string; mimeType: string }>) =>
    files.map((f) => ({ content: f.content, fileName: f.fileName, mimeType: f.mimeType, bankCode: null }));

  it('processes two uploaded statements end to end through BullMQ and yields the exact DTI', async () => {
    const { h, upload } = await rig();
    const analysis = await h.createAnalysis();
    const { a, b } = await happyFiles();
    const res = await upload.upload(OFFICER, analysis.id, toInputs([a, b]));
    expect(res.accepted).toBe(2);

    await vi.waitFor(async () => expect((await h.jobs(analysis.id)).map((j) => j.status)).toEqual(['COMPLETED', 'COMPLETED']), WAIT);
    expect((await h.analysis.get(OFFICER, analysis.id)).summary).toMatchObject({
      transactionCount: EXPECTED_HAPPY.transactionCount,
      dtiIncome: EXPECTED_HAPPY.dtiIncome,
      dtiPercent: EXPECTED_HAPPY.dtiPercent,
      dtiLevel: EXPECTED_HAPPY.dtiLevel,
    });
    expect(h.publisher.eventsOfType('StatementImported').map((e) => e.rows).sort((x, y) => x - y)).toEqual([9, 18]);
  });

  it('a transient infrastructure failure is retried by BullMQ and the job still completes with no failure event', async () => {
    const { h, upload, getCalls } = await rig(3, 1);
    const analysis = await h.createAnalysis();
    const { b } = await happyFiles();
    await upload.upload(OFFICER, analysis.id, toInputs([b]));

    await vi.waitFor(async () => expect((await h.jobs(analysis.id))[0].status).toBe('COMPLETED'), WAIT);
    expect(getCalls.n).toBeGreaterThanOrEqual(2);
    expect(h.publisher.eventsOfType('StatementImported').map((e) => e.status)).toEqual(['COMPLETED']);
  });

  it('a verification failure is final: BullMQ does not retry (UnrecoverableError) and retryJob re-adds the failed job', async () => {
    const { h, bull, upload, getCalls } = await rig(3);
    const analysis = await h.createAnalysis();
    const bad = await buildStatementFile({
      bank: 'MBANK', txns: accountBTxns(), opening: OPENING_B, accountNo: ACCOUNT_B, iban: null, holder: HOLDER, fileName: 'bad.csv', tamper: alterBalanceOfRow(3),
    });
    const res = await upload.upload(OFFICER, analysis.id, toInputs([bad]));
    const outcome = res.outcomes[0];
    if (outcome.status !== 'ACCEPTED') throw new Error('expected ACCEPTED');

    await vi.waitFor(async () => expect(await bull.jobState(outcome.jobId)).toBe('failed'), WAIT);
    const [job] = await h.jobs(analysis.id);
    expect(job.status).toBe('FAILED');
    expect(job.errors.map((e) => e.code)).toContain('BALANCE_CHAIN_BREAK');
    expect(getCalls.n).toBe(1); // эцсийн алдаа ⇒ дахин уншаагүй
    expect(h.publisher.eventsOfType('StatementImported').map((e) => e.status)).toEqual(['FAILED']);

    // «Дахин оруулах»: BullMQ-ийн failed ажлыг устгаж шинээр нэмнэ ⇒ дахин боловсруулагдаж, дахин (өөр) FAILED event гарна
    await upload.retryJob(OFFICER, analysis.id, outcome.jobId);
    await vi.waitFor(() => expect(getCalls.n).toBe(2), WAIT);
    await vi.waitFor(async () => expect(await bull.jobState(outcome.jobId)).toBe('failed'), WAIT);
    await vi.waitFor(() => expect(h.publisher.eventsOfType('StatementImported')).toHaveLength(2), WAIT);
  });
});
