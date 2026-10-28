// Import pipeline — БОДИТ PostgreSQL дээр (PrismaBsaRepository + PrismaEventPublisher/outbox). TEST_DATABASE_URL тохируулаагүй бол алгасна.
// Урьдчилсан нөхцөл: `scoring` schema migrate хийгдсэн (vitest globalSetup — apps/scoring/prisma/README.md).
// АНХААР: BSA хүснэгт болон scoring.outbox-ийг TRUNCATE хийнэ ⇒ DB-ийн нэрэнд "test" агуулагдах ёстой. Файл (object store) ба queue нь in-memory.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClassifierService, DEFAULT_BSA_CATEGORIES, DEFAULT_BSA_RULES } from '../classify';
import { PrismaEventPublisher } from '../common/event-publisher';
import { InlineImportQueue } from '../common/import-queue';
import type { BsaSettingsProvider } from '../common/infra.ports';
import { InMemoryObjectStore } from '../common/object-store';
import { PrismaBsaRepository } from '../common/persistence/prisma-bsa.repository';
import { PrismaClient } from '../common/persistence/prisma.service';
import { TestPiiCipher } from '../common/persistence/testing/test-pii-cipher';
import { DtiAnalysisService } from '../dti';
import { TEST_SETTINGS } from '../dti/testing/fixtures';
import { BANK_PARSERS } from '../parsers';
import { StatementParserRegistry } from '../parsers/parser.registry';
import { StatementTextService } from '../parsers/text-extraction';
import { NullQrVerifier } from '../parsers/verifier/qr-verifier';
import { StatementVerificationService } from '../parsers/verifier/statement-verification.service';
import { AnalysisService } from './analysis.service';
import { FinalizeService } from './finalize.service';
import { IMPORT_DEFAULTS } from './import.defaults';
import { ImportPipelineService } from './import-pipeline.service';
import { ImportProcessor } from './import.processor';
import { RecalculationService } from './recalculation.service';
import { RetentionService } from './retention.service';
import { UploadService } from './upload.service';
import { CUSTOMER_REGISTER, MutableClock, OFFICER, ORG } from './testing/harness';
import {
  ACCOUNT_A, ACCOUNT_B, EXPECTED_HAPPY, HOLDER, OPENING_A, OPENING_B, PII_MARKERS, accountATxns, accountBTxns, balanceBefore, happyFiles, withoutRandomIds,
} from './testing/scenario';
import { generateTransactions, type SynTxn } from '../parsers/engine/testing/synthetic-statement';
import { buildStatementFile, type SynFile } from './testing/statement-files';
import { alterBalanceOfRow } from './testing/tamper';

const URL_ = process.env.TEST_DATABASE_URL;
const TABLES = ['bsa_analysis_event', 'bsa_transaction', 'bsa_import_job', 'bsa_analysis', 'bsa_category', 'bsa_rule', 'outbox'] as const;
const START = new Date('2026-07-15T09:00:00.000Z');

interface OutboxRow {
  type: string;
  payload: { status: string; rows: number };
}

describe.skipIf(!URL_)('import pipeline on real PostgreSQL (TEST_DATABASE_URL)', () => {
  let prisma: PrismaClient;
  const clock = new MutableClock(START);
  const cipher = new TestPiiCipher();
  const settings = { ...TEST_SETTINGS, minStatementMonths: 3 };
  const settingsProvider: BsaSettingsProvider = { get: async () => settings };

  /** Production-тэй ижил угсралт: Prisma repository + outbox publisher; зөвхөн файлын хадгалалт ба queue нь in-memory */
  function build(attempts = 3) {
    const repo = new PrismaBsaRepository(prisma, cipher, { now: () => clock.now() });
    const store = new InMemoryObjectStore();
    const queue = new InlineImportQueue({ mode: 'sync', attempts, logger: { warn: () => undefined, error: () => undefined } });
    const publisher = new PrismaEventPublisher();
    const suspicion = { countPending: async (): Promise<number> => 0 };
    const registry = new StatementParserRegistry(BANK_PARSERS.map((P) => new P()));
    const classifier = new ClassifierService();
    const recalc = new RecalculationService(repo, settingsProvider, classifier, new DtiAnalysisService(), suspicion, clock);
    const pipeline = new ImportPipelineService(
      repo, settingsProvider, store, cipher, publisher, new StatementTextService(undefined, {}), registry,
      new StatementVerificationService(registry, new NullQrVerifier()), recalc, IMPORT_DEFAULTS, clock,
    );
    return {
      store, queue, recalc,
      analysis: new AnalysisService(repo, settingsProvider, store, recalc),
      upload: new UploadService(repo, settingsProvider, store, queue, clock),
      processor: new ImportProcessor(pipeline, queue),
      finalize: new FinalizeService(repo, settingsProvider, recalc, suspicion, clock),
      retention: new RetentionService(repo, settingsProvider, store, IMPORT_DEFAULTS, clock),
    };
  }
  type Stack = ReturnType<typeof build>;

  async function started(attempts = 3): Promise<Stack> {
    const s = build(attempts);
    await s.processor.start();
    return s;
  }

  const count = async (table: (typeof TABLES)[number]): Promise<number> =>
    Number((await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM "scoring"."${table}"`))[0].n);
  const outbox = (): Promise<OutboxRow[]> => prisma.$queryRawUnsafe<OutboxRow[]>('SELECT type, payload FROM "scoring"."outbox" ORDER BY created_at, id');

  const create = (s: Stack, over: Record<string, unknown> = {}) =>
    s.analysis.create(OFFICER, {
      loanApplicationId: 'app-1',
      customerId: 'cust-1',
      borrowerId: 'bor-1',
      customer: { registerNo: CUSTOMER_REGISTER, lastName: 'Bat-Erdene', firstName: 'Bold' },
      periodMonths: 3,
      proposedMonthlyPayment: 500_000,
      ...over,
    });
  const send = (s: Stack, analysisId: string, list: SynFile[]) =>
    s.upload.upload(OFFICER, analysisId, list.map((f) => ({ content: f.content, fileName: f.fileName, mimeType: f.mimeType, bankCode: null })));

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(URL_!).pathname.slice(1));
    if (!/test/i.test(dbName)) throw new Error('TEST_DATABASE_URL must point to a database whose name contains "test": refusing to TRUNCATE');
    prisma = new PrismaClient({ datasourceUrl: URL_, errorFormat: 'minimal' });
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });
  beforeEach(async () => {
    clock.current = START;
    await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"scoring"."${t}"`).join(', ')} CASCADE`);
    await prisma.bsaCategory.createMany({
      data: DEFAULT_BSA_CATEGORIES.map((c) => ({
        orgId: ORG, code: c.code, direction: c.direction, groupCode: c.groupCode, name: c.name, weight: c.weight, dtiRole: c.dtiRole, isActive: c.isActive,
      })),
    });
    await prisma.bsaRule.createMany({ data: DEFAULT_BSA_RULES.map((r) => ({ orgId: ORG, ...r })) });
  });

  it('imports two accounts, excludes the own transfer pair, stores the exact DTI; PII is encrypted and events reach the outbox', async () => {
    const s = await started();
    const analysis = await create(s);
    const { a, b } = await happyFiles();
    const res = await send(s, analysis.id, [a, b]);
    expect(res.accepted).toBe(2);

    const jobs = (await s.analysis.listJobs(OFFICER, analysis.id)).items;
    expect(jobs.map((j) => j.status)).toEqual(['COMPLETED', 'COMPLETED']);
    const view = await s.analysis.get(OFFICER, analysis.id);
    expect(view.summary).toMatchObject({
      transactionCount: EXPECTED_HAPPY.transactionCount,
      totalMonthlyIncome: EXPECTED_HAPPY.totalMonthlyIncome,
      verifiedMonthlyIncome: EXPECTED_HAPPY.verifiedMonthlyIncome,
      dtiIncome: EXPECTED_HAPPY.dtiIncome,
      businessIncomeMonthly: EXPECTED_HAPPY.businessIncomeMonthly,
      businessExpenseMonthly: EXPECTED_HAPPY.businessExpenseMonthly,
      netCashFlowMonthly: EXPECTED_HAPPY.netCashFlowMonthly,
      existingDebtServiceMonthly: EXPECTED_HAPPY.existingDebtServiceMonthly,
      dtiPercent: EXPECTED_HAPPY.dtiPercent,
      dtiLevel: EXPECTED_HAPPY.dtiLevel,
    });
    expect(view.ownAccountCount).toBe(2);
    const counts = await s.analysis.transactionCounts(OFFICER, analysis.id);
    expect(counts).toMatchObject({ total: 27, ownTransfers: 2 });
    expect(await count('bsa_transaction')).toBe(27);

    // PII шифрлэгдсэн: ямар ч хүснэгтэд дансны дугаар, нэр, гүйлгээний утга, регистр ил хадгалагдаагүй
    const dump = (
      await prisma.$queryRawUnsafe<Array<{ j: string }>>(
        TABLES.filter((t) => t !== 'bsa_category' && t !== 'bsa_rule').map((t) => `SELECT row_to_json(x)::text AS j FROM "scoring"."${t}" x`).join(' UNION ALL '),
      )
    ).map((r) => r.j).join('\n');
    expect(dump.length).toBeGreaterThan(0);
    // Мөнгөн дүн (numeric) '5011' мэт богино цифртэй давхцаж болох тул дангаараа утга учиртай (>= 7 тэмдэгт) тэмдгүүдийг шалгана
    const scanned = withoutRandomIds(dump);
    for (const secret of [ACCOUNT_A, ACCOUNT_B, 'Bat-Erdene', CUSTOMER_REGISTER, ...PII_MARKERS.filter((m) => !/^\d{1,6}$/.test(m))]) expect(scanned, secret).not.toContain(secret);
    expect(scanned).toContain('IMPORT_COMPLETED'); // шалгалт хоосон текст дээр ажиллаагүйг батлана

    const events = await outbox();
    expect(events.map((e) => [e.type, e.payload.status, e.payload.rows]).sort()).toEqual([
      ['StatementImported', 'COMPLETED', 18],
      ['StatementImported', 'COMPLETED', 9],
    ]);

    const done = await s.finalize.finalize(OFFICER, analysis.id);
    expect(done.summary.status).toBe('ANALYZED');
    expect((await s.finalize.toScoringInput(OFFICER, analysis.id)).businessNcfMonthly).toBe(EXPECTED_HAPPY.netCashFlowMonthly);
  });

  it('dedupes overlapping statements through the unique dedupe index', async () => {
    const s = await started();
    const analysis = await create(s);
    const rows = accountATxns();
    const a1 = await buildStatementFile({ bank: 'TDB', txns: rows.slice(0, 12), opening: OPENING_A, accountNo: ACCOUNT_A, iban: null, holder: HOLDER, fileName: 'a1.csv' });
    const a2 = await buildStatementFile({
      bank: 'TDB', txns: rows.slice(6), opening: balanceBefore(rows, 6, OPENING_A), accountNo: ACCOUNT_A, iban: null, holder: HOLDER, fileName: 'a2.csv',
    });
    const { b } = await happyFiles();
    await send(s, analysis.id, [a1, a2, b]);

    expect(await count('bsa_transaction')).toBe(27);
    expect((await s.analysis.get(OFFICER, analysis.id)).summary).toMatchObject({
      transactionCount: EXPECTED_HAPPY.transactionCount,
      dtiPercent: EXPECTED_HAPPY.dtiPercent,
    });
    expect((await outbox()).map((e) => e.payload.rows).sort((x, y) => x - y)).toEqual([6, 9, 12]);
  });

  it('a tampered statement leaves no rows and only a FAILED event', async () => {
    const s = await started();
    const analysis = await create(s);
    const bad = await buildStatementFile({
      bank: 'MBANK', txns: accountBTxns(), opening: OPENING_B, accountNo: ACCOUNT_B, iban: null, holder: HOLDER, fileName: 'bad.csv', tamper: alterBalanceOfRow(3),
    });
    await send(s, analysis.id, [bad]);

    const [job] = (await s.analysis.listJobs(OFFICER, analysis.id)).items;
    expect(job.status).toBe('FAILED');
    expect(job.errors.map((e) => e.code)).toContain('BALANCE_CHAIN_BREAK');
    expect(await count('bsa_transaction')).toBe(0);
    expect((await outbox()).map((e) => e.payload.status)).toEqual(['FAILED']);
  });

  it('the commit is atomic: a failure after the row insert rolls back rows, summary and the COMPLETED event', async () => {
    const s = await started(1);
    const analysis = await create(s);
    vi.spyOn(s.recalc, 'run').mockRejectedValueOnce(new Error('boom after insert'));
    const { a } = await happyFiles();
    await send(s, analysis.id, [a]);

    const [job] = (await s.analysis.listJobs(OFFICER, analysis.id)).items;
    expect(job.status).toBe('FAILED');
    expect(job.errors.map((e) => e.code)).toEqual(['INTERNAL_ERROR']);
    expect(await count('bsa_transaction')).toBe(0);
    expect((await s.analysis.get(OFFICER, analysis.id)).summary).toBeNull();
    expect((await outbox()).map((e) => e.payload.status)).toEqual(['FAILED']);
    vi.restoreAllMocks();
  });

  it('two concurrent uploads of the same file produce one job (the database decides the race)', async () => {
    const s = await started();
    const analysis = await create(s);
    const { a } = await happyFiles();
    const [r1, r2] = await Promise.all([send(s, analysis.id, [a]), send(s, analysis.id, [a])]);
    expect([r1.outcomes[0].status, r2.outcomes[0].status].sort()).toEqual(['ACCEPTED', 'DUPLICATE']);
    expect(await count('bsa_import_job')).toBe(1);
    expect(await count('bsa_transaction')).toBe(18);
  });

  it('retention purges the analysis with all its rows (cascade) and then its files', async () => {
    const s = await started();
    const analysis = await create(s);
    const { a, b } = await happyFiles();
    await send(s, analysis.id, [a, b]);
    expect(s.store.keys()).toHaveLength(2);

    clock.advance(5 * 365 * 24 * 3600 * 1000);
    const report = await s.retention.purgeExpired();
    expect(report).toMatchObject({ purged: 1, objectsDeleted: 2, objectFailures: 0 });
    for (const table of ['bsa_analysis', 'bsa_import_job', 'bsa_transaction', 'bsa_analysis_event'] as const) expect(await count(table), table).toBe(0);
    expect(s.store.keys()).toHaveLength(0);
  });

  it('NFR-1 on PostgreSQL: two ~1250-row PDF statements import in under 30 s (synthetic data, local database)', async () => {
    const rows = 1250;
    const latin = (list: SynTxn[]): SynTxn[] => list.map((t) => (/^[\x20-\x7e]+$/.test(t.description) ? t : { ...t, description: 'Transfer other' }));
    const s = await started();
    const analysis = await create(s, { proposedMonthlyPayment: 300_000 });
    const a = await buildStatementFile({
      bank: 'TDB', format: 'pdf', txns: latin(generateTransactions({ seed: 101, count: rows, startDate: '2026-04-01', withTime: true, perDay: 14 }, 3_000_000)),
      accountNo: ACCOUNT_A, iban: null, holder: HOLDER, fileName: 'perf-a.pdf', overrides: { rowsPerPage: 50 },
    });
    const b = await buildStatementFile({
      bank: 'MBANK', format: 'pdf', txns: latin(generateTransactions({ seed: 202, count: rows, startDate: '2026-04-01', withTime: true, perDay: 14 }, 3_000_000)),
      accountNo: ACCOUNT_B, iban: null, holder: HOLDER, fileName: 'perf-b.pdf', overrides: { rowsPerPage: 50 },
    });
    const t0 = performance.now();
    await send(s, analysis.id, [a, b]);
    const elapsed = performance.now() - t0;
    const jobs = (await s.analysis.listJobs(OFFICER, analysis.id)).items;
    expect(jobs.map((j) => [j.status, j.rowsDone])).toEqual([['COMPLETED', rows], ['COMPLETED', rows]]);
    expect(await count('bsa_transaction')).toBeGreaterThan(2000);
    console.log(`perf (PostgreSQL): 2 x ${rows} rows imported in ${Math.round(elapsed)} ms`);
    expect(elapsed).toBeLessThan(30_000);
  }, 120_000);
});
