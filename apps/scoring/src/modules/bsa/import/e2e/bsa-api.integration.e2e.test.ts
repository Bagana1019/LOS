// BSA REST — E2E БОДИТ PostgreSQL + Redis (BullMQ) дээр: PrismaBsaRepository + BullmqImportQueue + PrismaEventPublisher (outbox) + жинхэнэ AES-GCM
// PiiCipher; зөвхөн файлын хадгалалт (object store) in-memory. Хоёр хувьсагч хоёулаа тохируулаагүй бол алгасна:
//   TEST_DATABASE_URL  - нэрэнд "test" агуулсан DB (BSA хүснэгт + scoring.outbox TRUNCATE хийгдэнэ!); 00-schemas.sql + prisma/migrations/*/migration.sql хэрэглэсэн
//   REDIS_URL_TEST     - зөвхөн энэ тестийн BullMQ prefix-ийн түлхүүрүүдийг устгана
//   PII_ENCRYPTION_KEY - (заавал биш) байхгүй бол синтетик түлхүүр ашиглана
// Ажиллуулах: `TEST_DATABASE_URL=… REDIS_URL_TEST=… npx vitest run --no-file-parallelism src/modules/bsa/import/e2e/bsa-api.integration.e2e.test.ts`
// (--no-file-parallelism: бусад integration тест нэг DB-г TRUNCATE хийдэг). Бүх өгөгдөл SYNTHETIC; парсерууд бодит хуулгаар баталгаажаагүй.
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_BSA_CATEGORIES, DEFAULT_BSA_RULES } from '../../classify';
import { BullmqImportQueue } from '../../common/import-queue';
import { AesGcmPiiCipher, createPiiCipher } from '../../common/pii-cipher';
import { PrismaClient } from '../../common/persistence/prisma.service';
import { ORG } from '../testing/harness';
import { ACCOUNT_A, ACCOUNT_B, HOLDER, OPENING_B, accountBTxns, happyFiles, toLatin } from '../testing/scenario';
import { buildStatementFile } from '../testing/statement-files';
import { alterBalanceOfRow } from '../testing/tamper';
import { createE2eApp, type E2eApp } from './e2e-app';
import { allTransactions, createAnalysis, expectError, expectReadScopes, runFullFlow, waitForJobs } from './flow';

const DB_URL = process.env.TEST_DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL_TEST;
/** Синтетик, нууц биш түлхүүр (32 байт, base64) — PII_ENCRYPTION_KEY тохируулаагүй орчинд */
const SYNTHETIC_KEY = Buffer.from('synthetic-e2e-key-0123456789abcd', 'utf8').toString('base64');
const TABLES = ['bsa_analysis_event', 'bsa_transaction', 'bsa_import_job', 'bsa_analysis', 'bsa_category', 'bsa_rule', 'outbox'] as const;
const logger = { warn: () => undefined, error: () => undefined };

/**
 * DB-д ил хадгалагдах ёсгүй УРТ утгууд. Шифртэй баганад санамсаргүй таарахгүйн тулд ≥ 10 тэмдэгттэй сонгосон (богино 'ZXQ', 'Bold' нь
 * base64 шифр текстэд санамсаргүй таарах магадлалтай тул оруулаагүй).
 */
const PLAINTEXT_SECRETS = [
  ACCOUNT_A, ACCOUNT_B, 'УБ90010203', 'Bat-Erdene', 'zxq-secret-a.pdf', 'zxq-secret-b.pdf',
  'Salary ZXQ-S04', 'Sales ZXQ-B05', 'Rent ZXQ-R06', 'Loan payment ZXQ-L04', 'Transfer ZXQ-T1', 'Unitel ZXQ-U04', 'Goods ZXQ-E04', 'Food ZXQ-F04',
];
/** Түлхүүртэй hash баганууд (ил текст биш, санамсаргүй тэмдэгт агуулна) — raw сканнаас хасна */
const HASH_COLUMNS = ['register_no_hash', 'sha256', 'statement_key', 'dedupe_key'];

describe.skipIf(!DB_URL || !REDIS_URL)('BSA REST API e2e on real PostgreSQL + Redis (TEST_DATABASE_URL, REDIS_URL_TEST)', () => {
  let prisma: PrismaClient;
  let admin: Redis;
  let seq = 0;
  let savedDatabaseUrl: string | undefined;
  const apps: E2eApp[] = [];
  const queues: BullmqImportQueue[] = [];
  const prefixes: string[] = [];

  async function boot(): Promise<E2eApp> {
    seq += 1;
    const prefix = `bsa-e2e-${process.pid}-${seq}`;
    prefixes.push(prefix);
    const queue = new BullmqImportQueue({ redisUrl: REDIS_URL!, prefix, attempts: 3, backoffDelayMs: 20, concurrency: 1, logger });
    queues.push(queue);
    const cipher = process.env.PII_ENCRYPTION_KEY ? createPiiCipher(process.env) : new AesGcmPiiCipher({ key: SYNTHETIC_KEY });
    const app = await createE2eApp({ mode: 'real', queue, cipher });
    apps.push(app);
    return app;
  }

  const rawRows = async (table: (typeof TABLES)[number]): Promise<string[]> => {
    const hashes = `ARRAY[${HASH_COLUMNS.map((c) => `'${c}'`).join(',')}]`;
    const rows = await prisma.$queryRawUnsafe<Array<{ t: string }>>(`SELECT (to_jsonb(x) - ${hashes})::text AS t FROM "scoring"."${table}" x`);
    return rows.map((r) => r.t);
  };
  const count = async (table: (typeof TABLES)[number]): Promise<number> =>
    Number((await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM "scoring"."${table}"`))[0].n);

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(DB_URL!).pathname.slice(1));
    if (!/test/i.test(dbName)) throw new Error('TEST_DATABASE_URL must point to a database whose name contains "test": refusing to TRUNCATE');
    savedDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = DB_URL; // PrismaService (BsaModule) энэ DB-тэй холбогдоно
    prisma = new PrismaClient({ datasourceUrl: DB_URL, errorFormat: 'minimal' });
    await prisma.$connect();
    admin = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    await admin?.quit();
    if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDatabaseUrl;
  });
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"scoring"."${t}"`).join(', ')} CASCADE`);
    await prisma.bsaCategory.createMany({
      data: DEFAULT_BSA_CATEGORIES.map((c) => ({
        orgId: ORG, code: c.code, direction: c.direction, groupCode: c.groupCode, name: c.name, weight: c.weight, dtiRole: c.dtiRole, isActive: c.isActive,
      })),
    });
    await prisma.bsaRule.createMany({ data: DEFAULT_BSA_RULES.map((r) => ({ orgId: ORG, ...r })) });
  });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close())); // app.close() ⇒ worker/queue хаагдана
    await Promise.all(queues.splice(0).map((q) => q.close().catch(() => undefined)));
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

  it('runs the same full flow through Postgres + BullMQ and stores no plaintext PII in any table', async () => {
    const e = await boot();
    const { analysisId } = await runFullFlow(e);
    await expectReadScopes(e, analysisId);

    // Мөрийн тоо: 1 шинжилгээ, 2 ажил, 27 гүйлгээ; ангилал/дүрмийн сан seed хийсэн хэвээр
    expect(await count('bsa_analysis')).toBe(1);
    expect(await count('bsa_import_job')).toBe(2);
    expect(await count('bsa_transaction')).toBe(27);
    // Domain event outbox-д (ажил бүрт нэг StatementImported), PII-гүй
    const outbox = await prisma.$queryRawUnsafe<Array<{ type: string; payload: { status: string; rows: number } }>>(
      'SELECT type, payload FROM "scoring"."outbox" ORDER BY created_at, id',
    );
    expect(outbox.map((o) => [o.type, o.payload.status, o.payload.rows]).sort()).toEqual([
      ['StatementImported', 'COMPLETED', 18],
      ['StatementImported', 'COMPLETED', 9],
    ]);

    // PII шифрлэгдсэн: ил текст олдохгүй (түлхүүртэй hash баганаас бусад бүх багана), шифр баганууд `v1:` дугтуйтай
    for (const table of ['bsa_analysis', 'bsa_import_job', 'bsa_transaction', 'bsa_analysis_event', 'outbox'] as const) {
      const text = (await rawRows(table)).join('\n');
      expect(text.length, table).toBeGreaterThan(2);
      if (table === 'bsa_analysis' || table === 'bsa_import_job' || table === 'bsa_transaction') expect(text, `${table} must hold ciphertext`).toContain('"v1:');
      for (const secret of PLAINTEXT_SECRETS) expect(text, `${table} stores plaintext "${secret}"`).not.toContain(secret);
    }
    const encrypted = await prisma.$queryRawUnsafe<Array<Record<string, string | null>>>(
      `SELECT t.description_encrypted AS d, j.file_name_encrypted AS f, j.account_no_encrypted AS a, a.customer_snapshot_encrypted AS c, a.own_accounts_encrypted AS o
       FROM "scoring"."bsa_transaction" t
       JOIN "scoring"."bsa_import_job" j ON j.id = t.import_job_id
       JOIN "scoring"."bsa_analysis" a ON a.id = t.analysis_id`,
    );
    expect(encrypted).toHaveLength(27);
    for (const row of encrypted) for (const value of Object.values(row)) expect(value, 'encrypted column').toMatch(/^v1:[A-Za-z0-9_-]+$/);
    // Дансны дугаар hash-аар (statement_key) хадгалагдсан, ил биш
    const keys = await prisma.$queryRawUnsafe<Array<{ statement_key: string }>>('SELECT DISTINCT statement_key FROM "scoring"."bsa_transaction"');
    expect(keys).toHaveLength(2);
    expect(keys.every((k) => !k.statement_key.includes(ACCOUNT_A) && !k.statement_key.includes(ACCOUNT_B))).toBe(true);
  }, 120_000);

  it('handles duplicates, a tampered statement, a bank-override retry and deletion against the real database', async () => {
    const e = await boot();
    const { id } = await createAnalysis(e.api);
    const { a } = await happyFiles({ format: 'pdf' });
    const tampered = await buildStatementFile({
      bank: 'MBANK', txns: toLatin(accountBTxns()), opening: OPENING_B, format: 'pdf', accountNo: ACCOUNT_B, iban: null, holder: HOLDER,
      fileName: 'zxq-secret-bad.pdf', tamper: alterBalanceOfRow(3),
    });
    const noBank = await buildStatementFile({
      bank: 'MBANK', txns: toLatin(accountBTxns()).slice(0, 8), opening: OPENING_B, format: 'pdf', accountNo: '7799001199', iban: null, holder: HOLDER,
      fileName: 'zxq-secret-nobank.pdf', overrides: { header: { titleLines: ['SYNTHETIC TEST DATA - NOT A REAL STATEMENT', 'Account statement'] } },
    });

    expect((await e.api.upload(id, [a, tampered, noBank])).status).toBe(202);
    const jobs = await waitForJobs(e.api, id, 3);
    const byName = Object.fromEntries(jobs.map((j) => [j.fileName, j]));
    expect(byName['zxq-secret-a.pdf']).toMatchObject({ status: 'COMPLETED', rowsDone: 18 });
    expect(byName['zxq-secret-bad.pdf'].status).toBe('FAILED');
    expect(byName['zxq-secret-bad.pdf'].errors.map((x) => x.code)).toContain('BALANCE_CHAIN_BREAK');
    expect(byName['zxq-secret-nobank.pdf'].errors.map((x) => x.code)).toEqual(['BANK_NOT_DETECTED']);

    // Давхар файл: DB-ийн unique (analysis_id, sha256) → DUPLICATE
    const dup = await e.api.upload(id, [a]);
    expect(dup.status).toBe(200);
    expect(dup.body.outcomes[0]).toMatchObject({ status: 'DUPLICATE', existingJobId: byName['zxq-secret-a.pdf'].id });
    expect(await count('bsa_import_job')).toBe(3);

    // Банкны override-тай дахин оруулах (BullMQ-д failed ажлыг дахин нэмнэ)
    const retry = await e.api.post(`/bsa/jobs/${byName['zxq-secret-nobank.pdf'].id}/retry`, { bankCode: 'MBANK' });
    expect(retry.status).toBe(202);
    const after = await waitForJobs(e.api, id, 3);
    expect(after.find((j) => j.id === byName['zxq-secret-nobank.pdf'].id)).toMatchObject({ status: 'COMPLETED', bankCode: 'MBANK', errors: [] });
    expect(after.find((j) => j.id === byName['zxq-secret-bad.pdf'].id)?.status).toBe('FAILED');
    // Алдаатай хуулгын мөр хадгалагдаагүй: зөвхөн A (18) + override хийсэн (8) мөр
    expect(await allTransactions(e.api, id)).toHaveLength(26);
    expect(await count('bsa_transaction')).toBe(26);

    // Аль хэдийн дууссан ажлыг дахин оруулах боломжгүй
    expectError(await e.api.post(`/bsa/jobs/${byName['zxq-secret-a.pdf'].id}/retry`), 409, 'JOB_NOT_RETRYABLE');
    expectError(await e.api.post(`/bsa/analyses/${id}/finalize`).set({ 'X-Org-Id': 'org-2' }), 404, 'NOT_FOUND');

    // DRAFT шинжилгээг устгахад хүүхэд мөрүүд cascade-аар, файлууд object store-оос устна
    expect(e.store.keys().length).toBe(3);
    const deleted = await e.api.del(`/bsa/analyses/${id}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ deletedObjects: 3, failedObjects: 0 });
    expect([await count('bsa_analysis'), await count('bsa_import_job'), await count('bsa_transaction'), await count('bsa_analysis_event')]).toEqual([0, 0, 0, 0]);
    expect(e.store.keys()).toHaveLength(0);
    expectError(await e.api.get(`/bsa/analyses/${id}`), 404, 'NOT_FOUND');
  }, 120_000);
});
