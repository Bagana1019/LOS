import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardSummary, ReportKey } from '@los/contracts';
import { Prisma } from '.prisma/client-origination';
import { PrismaService } from '../../prisma.service';
import type { RequestContext } from '@los/contracts';
import { CORE_DEPOSIT_PORT } from '../../integrations/core-deposit/core-deposit.provider';
import type { CoreDepositPort } from '../../integrations/core-deposit/core-deposit.port';
import { actors, createApplication, hasTestDb } from '../../test-utils/factories';
import { DASHBOARD_CONCURRENCY, DASHBOARD_MAX_QUEUE, DASHBOARD_QUERY_CONCURRENCY, DashboardService } from './dashboard.service';
import { isStatementTimeout, queryWithTimeout } from './report-db';
import { ReportService } from './report.service';
import { bootReport, resetAndSeed, type ReportEnv } from './report.test-helpers';

// Ачааллын хамгаалалт (findings): dashboard хүсэлт бүр 6 query зэрэг ажиллуулж нийтлэг Prisma pool-ыг ядууруулдаг (P2024 → 500) байсан;
// экспортын хязгаарын хамгаалалт мөрүүдийг бүгдийг нь уншсаны ДАРАА ажилладаг байсан.
type Q = Record<string, string | number>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const adminCtx: RequestContext = { userId: 'admin-1', roles: ['ADMIN'], branchId: null, orgId: actors.admin()['x-org-id'], customerId: null, correlationId: 'load-1' };
const settle = <T>(p: Promise<T>) => p.then((value) => ({ ok: true as const, value }), (error: { getStatus?: () => number; getResponse?: () => { code?: string } }) => ({ ok: false as const, error }));

describe.skipIf(!hasTestDb)('report: dashboard ачааллын хамгаалалт (кэшгүй)', () => {
  let env: ReportEnv;
  let dash: DashboardService;
  const admin = actors.admin();
  beforeAll(async () => { env = await bootReport(); dash = env.t.app.get(DashboardService); });
  afterAll(async () => { await env.t.close(); });
  beforeEach(async () => { await resetAndSeed(env); });
  afterEach(() => { vi.restoreAllMocks(); });

  const get = (headers: Record<string, string>, query: Q = {}) => env.http().get('/api/reports/dashboard/summary').query(query).set(headers);
  /** compute-ийг удаашруулж (хүсэлтүүд зэрэгцэж таарах боломж олгож) дуудлагыг тоолно. */
  function slowCompute(ms = 120) {
    const original = (dash as unknown as { compute: (...a: unknown[]) => Promise<unknown> }).compute.bind(dash);
    return vi.spyOn(dash as unknown as { compute: (...a: unknown[]) => Promise<unknown> }, 'compute').mockImplementation(async (...a) => { await sleep(ms); return original(...a); });
  }

  it('single-flight: ижил түлхүүрийн 30 зэрэгцээ хүсэлт НЭГ тооцоолол хийж, бүгд ижил хариу авна', async () => {
    const compute = slowCompute();
    const res = await Promise.all(Array.from({ length: 30 }, () => get(admin)));
    expect(res.every((r) => r.status === 200)).toBe(true);
    expect(compute).toHaveBeenCalledTimes(1);
    const first = JSON.stringify(res[0].body);
    expect(res.every((r) => JSON.stringify(r.body) === first)).toBe(true);
    DashboardSummary.parse(res[0].body);
    // дууссаны дараа in-flight цэвэр: шинэ хүсэлт дахин тооцоолно (TTL=0 → кэшгүй)
    expect((await get(admin)).status).toBe(200);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('өөр түлхүүр (хүрээ, салбар, валют, asOf) тусдаа тооцоологдоно; ЗЭЗ-ийн хариу ADMIN-ийнхтай холилдохгүй', async () => {
    const compute = slowCompute();
    const [a, b, c, d, e] = await Promise.all([
      get(admin), get(admin, { branchId: 'branch-2' }), get(actors.officer('officer-1')), get(admin, { currency: 'USD' }), get(admin, { asOf: '2026-09-30' }),
    ]);
    expect([a, b, c, d, e].map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(compute).toHaveBeenCalledTimes(5);
    expect(a.body.scope).toEqual({ branchId: null, officerId: null });
    expect(b.body.scope).toEqual({ branchId: 'branch-2', officerId: null });
    expect(c.body.scope).toEqual({ branchId: null, officerId: 'officer-1' });
    expect(d.body.currency).toBe('USD');
    expect(e.body.asOf).toBe('2026-09-30');
    expect(c.body.portfolio.activeLoanCount).toBeLessThan(a.body.portfolio.activeLoanCount);
  });

  it('тооцоолол алдаатай бол кэшлэгдэхгүй, in-flight цэвэрлэгдэж дараагийн хүсэлт амжилттай болно', async () => {
    const original = (dash as unknown as { compute: (...a: unknown[]) => Promise<unknown> }).compute.bind(dash);
    const compute = vi.spyOn(dash as unknown as { compute: (...a: unknown[]) => Promise<unknown> }, 'compute')
      .mockImplementationOnce(async () => { await sleep(30); throw new Error('түр алдаа'); })
      .mockImplementation(original);
    const failed = await Promise.all([get(admin), get(admin)]); // хоёул нэг тооцоолол → хоёул 500
    expect(failed.map((r) => r.status)).toEqual([500, 500]);
    expect(compute).toHaveBeenCalledTimes(1);
    expect((await get(admin)).status).toBe(200);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it(`DB-д зэрэг ажиллах query ≤ ${DASHBOARD_CONCURRENCY}×${DASHBOARD_QUERY_CONCURRENCY}: 30 өөр түлхүүртэй dashboard нийтлэг pool-ыг дүүргэхгүй, бүгд 200`, async () => {
    const prisma = env.t.app.get(PrismaService);
    const original = prisma.$transaction.bind(prisma) as (...a: unknown[]) => Promise<unknown>;
    let inFlight = 0; let peak = 0; let calls = 0;
    vi.spyOn(prisma, '$transaction').mockImplementation(((...args: unknown[]) => {
      inFlight++; calls++; peak = Math.max(peak, inFlight);
      return original(...args).finally(() => { inFlight--; });
    }) as never);
    const days = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`);
    const res = await Promise.all(days.map((asOf) => get(admin, { asOf })));
    expect(res.map((r) => r.status)).toEqual(days.map(() => 200));
    expect(calls).toBe(30 * 6); // 30 тооцоолол × 6 query (бүгд statement_timeout-той гүйлгээнд)
    expect(peak).toBeLessThanOrEqual(DASHBOARD_CONCURRENCY * DASHBOARD_QUERY_CONCURRENCY);
    expect(peak).toBeGreaterThan(1); // зэрэгцээ ажиллагаа бүрэн унтраагдаагүй
  }, 90_000);

  it(`дараалал дүүрвэл (${DASHBOARD_CONCURRENCY} ажиллаж + ${DASHBOARD_MAX_QUEUE} хүлээж) илүү хүсэлт 429 REPORT_BUSY; бусад нь амжилттай`, async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vi.spyOn(dash as unknown as { compute: (...a: unknown[]) => Promise<unknown> }, 'compute').mockImplementation(async () => { await gate; return { ok: true }; });
    const total = DASHBOARD_CONCURRENCY + DASHBOARD_MAX_QUEUE + 3;
    const all = Array.from({ length: total }, (_, i) => settle(dash.summary(adminCtx, { currency: 'MNT', asOf: `2026-${String(1 + (i % 9)).padStart(2, '0')}-${String(1 + Math.floor(i / 9)).padStart(2, '0')}` })));
    await sleep(30);
    release();
    const results = await Promise.all(all);
    const busy = results.filter((r) => !r.ok);
    expect(busy).toHaveLength(3);
    for (const r of busy) {
      if (r.ok) continue;
      expect(r.error.getStatus?.()).toBe(429);
      expect(r.error.getResponse?.().code).toBe('REPORT_BUSY');
    }
    expect(results.filter((r) => r.ok)).toHaveLength(DASHBOARD_CONCURRENCY + DASHBOARD_MAX_QUEUE);
  });

  it('эрхийн шалгалт кэш/single-flight-ээс ӨМНӨ: CUSTOMER 403, нэвтрээгүй 401 (ADMIN-ий тооцоолол дундаа явж байхад ч)', async () => {
    slowCompute(200);
    const pending = get(admin).then((r) => r); // .then нь supertest хүсэлтийг шууд эхлүүлнэ
    await sleep(20);
    expect((await get({ 'x-user-id': 'c', 'x-roles': 'CUSTOMER', 'x-org-id': admin['x-org-id'] })).status).toBe(403);
    expect((await get(actors.anonymous())).status).toBe(401);
    expect((await pending).status).toBe(200);
  });
});

describe.skipIf(!hasTestDb)('report: dashboard кэш (TTL 60с)', () => {
  let env: ReportEnv;
  const admin = actors.admin();
  beforeAll(async () => { env = await bootReport({ dashboardCacheMs: 60_000 }); });
  afterAll(async () => { await env.t.close(); });
  beforeEach(async () => { await resetAndSeed(env); });
  afterEach(() => { vi.restoreAllMocks(); });

  const get = (headers: Record<string, string>, query: Q = {}) => env.http().get('/api/reports/dashboard/summary').query(query).set(headers);
  const activeOf = (b: DashboardSummary) => b.applications.byStatus.find((s) => s.status === 'ACTIVE')!.count;

  it('TTL дотор ижил түлхүүр кэшээс (өгөгдөл өөрчлөгдсөн ч ижил, generatedAt ижил); өөр түлхүүр шинэ', async () => {
    const first = (await get(admin)).body as DashboardSummary;
    await createApplication(env.t.prisma, { appNo: 'CACHE-1', status: 'ACTIVE', amount: 500_000, contractNo: 'CACHE1', branchId: 'branch-1', officerId: 'officer-1' });
    env.t.clock.advanceMs(5 * 60_000);
    const again = (await get(admin)).body as DashboardSummary;
    expect(again).toEqual(first);
    expect(again.generatedAt).toBe(first.generatedAt);
    const fresh = (await get(admin, { branchId: 'branch-1' })).body as DashboardSummary; // өөр түлхүүр → шинэ тооцоолол
    expect(fresh.scope.branchId).toBe('branch-1');
    expect(activeOf(fresh)).toBe(await env.t.prisma.loanApplication.count({ where: { status: 'ACTIVE', branchId: 'branch-1', currency: 'MNT' } })); // CACHE-1 орсон
  });

  it('TTL дууссаны дараа шинэчлэгдэнэ', async () => {
    const first = (await get(admin)).body as DashboardSummary;
    await createApplication(env.t.prisma, { appNo: 'CACHE-2', status: 'ACTIVE', amount: 500_000, contractNo: 'CACHE2', branchId: 'branch-1', officerId: 'officer-1' });
    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 61_000);
    const later = (await get(admin)).body as DashboardSummary;
    expect(activeOf(later)).toBe(activeOf(first) + 1);
  });

  it('кэш нь эрхийн хүрээг давахгүй: ADMIN-ий кэш ЗЭЗ/салбарын захиралд, CUSTOMER-т өгөгдөхгүй', async () => {
    const adminBody = (await get(admin)).body as DashboardSummary;
    const officer = (await get(actors.officer('officer-1'))).body as DashboardSummary;
    const otherOfficer = (await get(actors.officer('officer-2'))).body as DashboardSummary;
    const bm = (await get(actors.branchManager('bm-1', 'branch-2'))).body as DashboardSummary;
    expect(officer.scope).toEqual({ branchId: null, officerId: 'officer-1' });
    expect(otherOfficer.scope).toEqual({ branchId: null, officerId: 'officer-2' });
    expect(bm.scope).toEqual({ branchId: 'branch-2', officerId: null });
    expect(activeOf(officer)).toBeLessThan(activeOf(adminBody));
    expect(activeOf(officer) + activeOf(otherOfficer)).toBeLessThanOrEqual(activeOf(adminBody));
    // кэш дулаахан байхад ч эрхгүй хүн 403 / 401
    expect((await get({ 'x-user-id': 'c', 'x-roles': 'CUSTOMER', 'x-org-id': admin['x-org-id'] })).status).toBe(403);
    expect((await get(actors.anonymous())).status).toBe(401);
    // org тусгаарлалт: өөр байгууллагын ADMIN ижил query-гээр ч бидний кэшийг авахгүй
    const other = await get({ 'x-user-id': 'a2', 'x-roles': 'ADMIN', 'x-org-id': 'org-other' });
    expect(other.status).toBe(200);
    expect(activeOf(other.body)).toBe(0);
  });
});

describe.skipIf(!hasTestDb)('report: экспортын хязгаар (мөр уншихаас өмнө) ба statement_timeout', () => {
  let env: ReportEnv;
  beforeAll(async () => { env = await bootReport(); });
  afterAll(async () => { await env.t.close(); });
  beforeEach(async () => { await resetAndSeed(env); });

  it('9 тайлан бүр: нийт мөр > maxRows үед мөр БУЦААХГҮЙ (нийт тоо зөв), ≤ maxRows үед бүх мөр', async () => {
    const service = env.t.app.get(ReportService) as unknown as { prepare: (ctx: RequestContext, key: string, q: object, paging: object) => { def: { run: (deps: object, input: object) => Promise<{ rows: unknown[]; total: number }> }; input: object } };
    const deps = { prisma: env.t.app.get(PrismaService), deposit: env.t.app.get<CoreDepositPort>(CORE_DEPOSIT_PORT) };
    const wide = { dateFrom: '2000-01-01', dateTo: '2100-01-01', sortDir: 'asc' };
    for (const key of ReportKey) {
      const { def, input } = service.prepare(adminCtx, key, wide, { page: 1, pageSize: 1000 });
      const all = await def.run(deps, input);
      expect(all.total, key).toBeGreaterThan(0);
      expect(all.rows.length, key).toBe(all.total);
      const over = await def.run(deps, { ...input, maxRows: all.total - 1 });
      expect(over.rows, key).toEqual([]);
      expect(over.total, key).toBe(all.total);
      const exact = await def.run(deps, { ...input, maxRows: all.total });
      expect(exact.rows.length, key).toBe(all.total);
    }
  });

  it('HTTP: EXPORT_TOO_LARGE нь xlsx бүтээхгүй, аудит бичихгүй; нарийсгасан шүүлтээр амжилттай', async () => {
    await env.t.prisma.setting.create({ data: { orgId: actors.admin()['x-org-id'], key: 'report.max_export_rows', valueJson: 2 } });
    const res = await env.http().get('/api/reports/outstanding-balance/export').set(actors.admin());
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('EXPORT_TOO_LARGE');
    expect(await env.t.prisma.reportRun.count()).toBe(0);
  });

  it('statement_timeout: хэт удаан query 57014-өөр таслагдаж isStatementTimeout танина; SET LOCAL нь холболтод үлдэхгүй', async () => {
    const prisma = env.t.app.get(PrismaService);
    const t0 = performance.now();
    const err = await queryWithTimeout(prisma, Prisma.sql`SELECT pg_sleep(3)`, 100).then(() => null, (e: unknown) => e);
    expect(err).not.toBeNull();
    expect(isStatementTimeout(err)).toBe(true);
    expect(performance.now() - t0).toBeLessThan(2500);
    expect(await queryWithTimeout<Array<{ ok: number }>>(prisma, Prisma.sql`SELECT 1::int AS ok`, 1000)).toEqual([{ ok: 1 }]);
    // pool-ын бүх холболтоор шалгана: statement_timeout хэвээр 0 (хязгааргүй)
    const shows = await Promise.all(Array.from({ length: 12 }, () => prisma.$queryRaw<Array<{ statement_timeout: string }>>`SHOW statement_timeout`));
    expect(shows.map((r) => r[0].statement_timeout)).toEqual(Array.from({ length: 12 }, () => '0'));
  });

  it('JSON тайлан statement_timeout-той гүйлгээнд ажиллана (жагсаалт хэвийн)', async () => {
    const res = await env.http().get('/api/reports/overdue-loans').set(actors.admin());
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThan(0);
  });
});

