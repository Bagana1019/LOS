// F6-3: «Шинжилгээ үүсгэх»-ийг хурдан 2 дарахад нэг зээлдэгчид 2 DRAFT (v1, v2) үүсдэг байсан — БОДИТ PostgreSQL дээр шалгана.
// Mutex нь service-ийн транзакц доторх pg_advisory_xact_lock; in-memory repo зэрэгцээ транзакцийг дарааллуулдаг тул зөвхөн энд бодитоор баталгаажна.
// TEST_DATABASE_URL тохируулаагүй бол алгасна. АНХААР: BSA хүснэгтүүдийг TRUNCATE хийнэ ⇒ DB-ийн нэрэнд "test" агуулагдах ёстой.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaBsaRepository } from '../common/persistence/prisma-bsa.repository';
import { PrismaClient } from '../common/persistence/prisma.service';
import { TestPiiCipher } from '../common/persistence/testing/test-pii-cipher';
import type { BsaSettingsProvider, ObjectStore } from '../common/infra.ports';
import { TEST_SETTINGS } from '../dti/testing/fixtures';
import { AnalysisService } from './analysis.service';
import type { RecalculationService } from './recalculation.service';
import { CUSTOMER_REGISTER, OFFICER } from './testing/harness';

const URL_ = process.env.TEST_DATABASE_URL;
const TABLES = ['bsa_analysis_event', 'bsa_transaction', 'bsa_import_job', 'bsa_analysis', 'outbox'] as const;
const BODY = { loanApplicationId: 'app-1', customerId: 'cust-1', borrowerId: 'bor-1', customer: { registerNo: CUSTOMER_REGISTER }, periodMonths: 3 };

describe.skipIf(!URL_)('AnalysisService.create idempotency on real PostgreSQL (F6-3)', () => {
  let prisma: PrismaClient;
  let service: AnalysisService;
  const settings: BsaSettingsProvider = { get: async () => TEST_SETTINGS };

  const rows = async (): Promise<Array<{ id: string; version: number; status: string }>> =>
    prisma.bsaAnalysis.findMany({ where: { applicationId: 'app-1', customerId: 'cust-1' }, orderBy: { version: 'asc' }, select: { id: true, version: true, status: true } });
  const eventCount = (): Promise<number> => prisma.bsaAnalysisEvent.count({ where: { action: 'ANALYSIS_CREATED' } });

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(URL_!).pathname.slice(1));
    if (!/test/i.test(dbName)) throw new Error('TEST_DATABASE_URL must point to a database whose name contains "test": refusing to TRUNCATE');
    prisma = new PrismaClient({ datasourceUrl: URL_, errorFormat: 'minimal' });
    await prisma.$connect();
    const repo = new PrismaBsaRepository(prisma, new TestPiiCipher());
    // create() нь object store / recalculation-ийг ашиглахгүй
    service = new AnalysisService(repo, settings, {} as ObjectStore, {} as RecalculationService);
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"scoring"."${t}"`).join(', ')} CASCADE`);
  });

  it('two concurrent creates (Promise.all) leave exactly one DRAFT row and one event, and both callers get the same analysis', async () => {
    const [a, b] = await Promise.all([service.createOrGetDraft(OFFICER, BODY), service.createOrGetDraft(OFFICER, BODY)]);
    expect(a.analysis.id).toBe(b.analysis.id);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(await rows()).toEqual([{ id: a.analysis.id, version: 1, status: 'DRAFT' }]);
    expect(await eventCount()).toBe(1);
  });

  it('ten concurrent creates still leave exactly one row (the lock serialises the whole find-or-create)', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => service.create(OFFICER, BODY)));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await rows()).toHaveLength(1);
    expect(await eventCount()).toBe(1);
  });

  it('after the DRAFT is completed a create makes version 2; concurrent repeats of that create share it', async () => {
    const first = await service.create(OFFICER, BODY);
    await prisma.bsaAnalysis.update({ where: { id: first.id }, data: { status: 'ANALYZED' } });
    const [a, b] = await Promise.all([service.create(OFFICER, BODY), service.create(OFFICER, BODY)]);
    expect(a.id).toBe(b.id);
    expect(a.id).not.toBe(first.id);
    expect(await rows()).toEqual([
      { id: first.id, version: 1, status: 'ANALYZED' },
      { id: a.id, version: 2, status: 'DRAFT' },
    ]);
  });

  it('different customers created concurrently do not block or merge into each other', async () => {
    const [a, b] = await Promise.all([service.create(OFFICER, BODY), service.create(OFFICER, { ...BODY, customerId: 'cust-2' })]);
    expect(a.id).not.toBe(b.id);
    expect(await prisma.bsaAnalysis.count()).toBe(2);
  });
});
