// PrismaBsaRepository: гэрээний тест (TEST_DATABASE_URL өгөгдсөн үед) + PostgreSQL-д онцгой шалгалт.
// Урьдчилсан нөхцөл: `scoring` schema migrate хийгдсэн (vitest globalSetup — test/global-setup.ts — TEST_DATABASE_URL-д baseline + BSA migration + seed хэрэглэнэ; prisma/README.md).
// АНХААР: reset() нь BSA хүснэгт болон scoring.outbox-ийг TRUNCATE хийнэ → DB-ийн нэрэнд "test" агуулагдах ёстой.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaBsaRepository } from './prisma-bsa.repository';
import { Prisma, PrismaClient } from './prisma.service';
import { describeRepositoryContract, type RepositoryHarness } from './repository.contract';
import { TestPiiCipher } from './testing/test-pii-cipher';

const URL_ = process.env.TEST_DATABASE_URL;

function assertSafeTestDatabase(url: string): void {
  const dbName = decodeURIComponent(new URL(url).pathname.slice(1));
  if (!/test/i.test(dbName)) throw new Error(`TEST_DATABASE_URL must point to a database whose name contains "test" (got a database that does not): refusing to TRUNCATE`);
}

const TABLES = ['bsa_analysis_event', 'bsa_transaction', 'bsa_import_job', 'bsa_analysis', 'bsa_category', 'bsa_rule', 'outbox'] as const;
const cipher = new TestPiiCipher();

async function prismaHarness(prisma: PrismaClient, clock: { now: Date }): Promise<RepositoryHarness> {
  const repo = new PrismaBsaRepository(prisma, cipher, { now: () => clock.now });
  return {
    repo,
    async reset() {
      await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"scoring"."${t}"`).join(', ')} CASCADE`);
    },
    async seedConfig(orgId, cfg) {
      if (cfg.categories?.length) {
        await prisma.bsaCategory.createMany({ data: cfg.categories.map((c) => ({ orgId, code: c.code, direction: c.direction, groupCode: c.groupCode, name: c.name, weight: c.weight, dtiRole: c.dtiRole, isActive: c.isActive })) });
      }
      if (cfg.rules?.length) await prisma.bsaRule.createMany({ data: cfg.rules.map((r) => ({ orgId, ...r })) });
    },
    setNow(d) {
      clock.now = d;
    },
    async rawDump() {
      const parts: string[] = [];
      for (const t of TABLES) {
        const rows = await prisma.$queryRawUnsafe<Array<{ j: string }>>(`SELECT row_to_json(x)::text AS j FROM "scoring"."${t}" x`);
        parts.push(...rows.map((r) => r.j));
      }
      return parts.join('\n');
    },
    async close() {},
  };
}

describe.skipIf(!URL_)('PrismaBsaRepository (PostgreSQL)', () => {
  const prisma = new PrismaClient({ datasourceUrl: URL_ ?? 'postgresql://unused', errorFormat: 'minimal' });
  const clock = { now: new Date(0) };
  let harness: RepositoryHarness;

  beforeAll(async () => {
    assertSafeTestDatabase(URL_!);
    await prisma.$connect();
    harness = await prismaHarness(prisma, clock);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  describeRepositoryContract('PrismaBsaRepository', async () => harness);

  describe('PostgreSQL specifics', () => {
    beforeEach(() => harness.reset());

    it('encrypts PII with the injected PiiCipher and stores only opaque keys/hashes in clear', async () => {
      const a = await harness.repo.analyses.create({
        orgId: 'o', applicationId: 'a', customerId: 'c', customer: { registerNo: 'ЦП99887766', lastName: 'Тестов', firstName: 'Синтетик', phone: null, gender: null, note: null, declaredAccounts: [] },
      });
      const rows = await prisma.$queryRaw<Array<{ customer_snapshot_encrypted: string; register_no_hash: string }>>`
        SELECT customer_snapshot_encrypted, register_no_hash FROM "scoring"."bsa_analysis" WHERE id = ${a.id}`;
      expect(rows[0].customer_snapshot_encrypted.startsWith('t1:')).toBe(true);
      expect(rows[0].register_no_hash).toBe(cipher.hash('ЦП99887766'));
    });

    it('enforces the unique indexes at the database level (version, file, dedupe key, category)', async () => {
      const base = { orgId: 'o', applicationId: 'a', customerId: 'c', version: 1, createdAt: clock.now, updatedAt: clock.now };
      const a = await prisma.bsaAnalysis.create({ data: base });
      await expect(prisma.bsaAnalysis.create({ data: base })).rejects.toMatchObject({ code: 'P2002' });
      const job = { analysisId: a.id, orgId: 'o', fileId: 'f', fileNameEncrypted: 'x', mimeType: 'm', sizeBytes: 1, sha256: 'abc', format: 'PDF' };
      const j = await prisma.bsaImportJob.create({ data: job });
      await expect(prisma.bsaImportJob.create({ data: job })).rejects.toMatchObject({ code: 'P2002' });
      const tx = { analysisId: a.id, importJobId: j.id, orgId: 'o', seq: 1, txnDate: new Date('2026-01-01T00:00:00Z'), direction: 'INCOME', amount: 1, descriptionEncrypted: 'x', statementKey: 's', dedupeKey: 'd' };
      await prisma.bsaTransaction.create({ data: tx });
      await expect(prisma.bsaTransaction.create({ data: tx })).rejects.toMatchObject({ code: 'P2002' });
      const cat = { orgId: 'o', code: 'X', direction: 'INCOME', groupCode: 'A', name: 'n', weight: 1, dtiRole: 'INCOME' };
      await prisma.bsaCategory.create({ data: cat });
      await expect(prisma.bsaCategory.create({ data: cat })).rejects.toMatchObject({ code: 'P2002' });
      // FK cascade: шинжилгээг SQL-ээр устгахад хүүхдүүд хамт устна
      await prisma.$executeRaw`DELETE FROM "scoring"."bsa_analysis" WHERE id = ${a.id}`;
      expect(await prisma.bsaTransaction.count()).toBe(0);
      expect(await prisma.bsaImportJob.count()).toBe(0);
    });

    it('propagates a branch move to transactions and events at the table level', async () => {
      const a = await harness.repo.analyses.create({ orgId: 'o', branchId: 'b1', applicationId: 'a', customerId: 'c' });
      const j = await harness.repo.importJobs.create({ analysisId: a.id, fileId: 'f', fileName: 'n', mimeType: 'm', sizeBytes: 1, sha256: 'e'.repeat(64), format: 'PDF' });
      await harness.repo.transactions.bulkInsert(j.id, [{ seq: 1, txnDate: '2026-01-01', txnTime: null, direction: 'INCOME', amount: 1, balanceAfter: null, description: 'x', counterpartyAccount: null, counterpartyName: null, statementKey: 's', dedupeKey: 'd' }]);
      await harness.repo.events.append({ analysisId: a.id, action: 'A' });
      await harness.repo.analyses.update(a.id, { branchId: 'b2' });
      for (const t of ['bsa_analysis', 'bsa_import_job', 'bsa_transaction', 'bsa_analysis_event']) {
        const rows = await prisma.$queryRawUnsafe<Array<{ branch_id: string | null }>>(`SELECT branch_id FROM "scoring"."${t}"`);
        expect(rows.map((r) => r.branch_id), t).toEqual(['b2']);
      }
    });

    it('writes the outbox atomically with business rows via the tx handed to the callback (CLAUDE.md §3.2.4)', async () => {
      // scoring.outbox (Модуль 0 baseline) — raw SQL-ээр транзакц дотор бичнэ; DomainEventPublisher.enqueue(tx, …) мөн ингэж tx дотор бичих ёстой
      const enqueue = (tx: unknown) =>
        (tx as Prisma.TransactionClient).$executeRaw`INSERT INTO "scoring"."outbox" (id, type, payload) VALUES (gen_random_uuid(), 'StatementImported', '{"n":1}'::jsonb)`;
      const counts = async () => ({
        outbox: Number((await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM "scoring"."outbox"`)[0].n),
        analyses: await prisma.bsaAnalysis.count(),
      });
      await expect(
        harness.repo.runInTransaction(async (repo, tx) => {
          await repo.analyses.create({ orgId: 'o', applicationId: 'a', customerId: 'c' });
          await enqueue(tx);
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(await counts()).toEqual({ outbox: 0, analyses: 0 });

      await harness.repo.runInTransaction(async (repo, tx) => {
        await repo.analyses.create({ orgId: 'o', applicationId: 'a', customerId: 'c' });
        await enqueue(tx);
      });
      expect(await counts()).toEqual({ outbox: 1, analyses: 1 });
    });
  });
});
