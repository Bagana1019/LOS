import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReportKey } from '@los/contracts';
import { actors, hasTestDb } from '../../test-utils/factories';
import { seedBulkLoans } from './report.fixtures';
import { bootReport, resetReport, type ReportEnv } from './report.test-helpers';

// NFR-1: жагсаалт/тайлан ≤ 2 секунд, 10,000 зээл (тус бүр 12 мөртэй ЭТХ, төлбөр, барьцаа, олголт, 12 алхам) дээр.
const LOANS = 10_000;
const LIMIT_MS = 2000;
const WIDE = { dateFrom: '2000-01-01', dateTo: '2100-01-01' };

describe.skipIf(!hasTestDb)(`report: гүйцэтгэл (NFR-1), ${LOANS} зээл`, () => {
  let env: ReportEnv;
  const admin = actors.admin();
  beforeAll(async () => {
    env = await bootReport();
    await resetReport(env);
    await seedBulkLoans(env.t.prisma, LOANS);
  }, 280_000);
  afterAll(async () => { await env.t.close(); });

  async function timed(path: string, query: Record<string, string | number> = {}, headers = admin) {
    const t0 = performance.now();
    const res = await env.http().get(`/api${path}`).query(query).set(headers);
    return { ms: performance.now() - t0, res };
  }
  /** Хурд: 3 удаа (эхнийх нь халаалт) — хамгийн удаан нь ≤ 2с байх ёстой. */
  async function expectFast(label: string, path: string, query: Record<string, string | number> = {}, headers = admin) {
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const { ms, res } = await timed(path, query, headers);
      expect(res.status, `${label}: ${JSON.stringify(res.body).slice(0, 200)}`).toBe(200);
      times.push(ms);
    }
    console.info(`[perf] ${label}: ${times.map((t) => Math.round(t)).join(' / ')} мс`);
    expect(Math.max(...times), `${label} (${times.map(Math.round).join(',')} мс)`).toBeLessThan(LIMIT_MS);
  }

  it('өгөгдөл зөв үүссэн', async () => {
    expect(await env.t.prisma.loanApplication.count()).toBe(LOANS);
    expect(await env.t.prisma.repaymentScheduleRow.count()).toBe(LOANS * 12);
  });

  it.each([...ReportKey].filter((k) => k !== 'deposit-balances'))('%s: анхдагч эрэмбэ, нэг хуудас ≤ 2с', async (key) => {
    await expectFast(key, `/reports/${key}`, { ...WIDE, pageSize: 100 });
  });

  it('deposit-balances (санах ойн, Core mock) ≤ 2с', async () => {
    await expectFast('deposit-balances', '/reports/deposit-balances', { pageSize: 100 });
  });

  it('dashboard ≤ 2с', async () => {
    await expectFast('dashboard', '/reports/dashboard/summary');
  });

  it('нийт тоо, нийлбэр бүх 10,000 зээлийг хамарна (хуудсаар биш); хуудаслалт', async () => {
    const r = await timed('/reports/outstanding-balance', { pageSize: 10, page: 500 });
    expect(r.res.body.total).toBe(LOANS);
    expect(r.res.body.rows).toHaveLength(10);
    expect(r.res.body.totals.disbursedAmount).toBe(LOANS * 1_200_000);
    expect(r.ms).toBeLessThan(LIMIT_MS);
    const last = await timed('/reports/outstanding-balance', { pageSize: 10, page: 1001, sortBy: 'contractNo' });
    expect(last.res.body.rows).toHaveLength(0);
    expect(last.res.body.total).toBe(LOANS);
    const dash = (await timed('/reports/dashboard/summary')).res.body;
    expect(dash.portfolio.activeLoanCount).toBe(LOANS);
    expect(dash.portfolio.overdueLoanCount).toBe(LOANS);
    expect(dash.portfolio.aging.reduce((s: number, a: { loanCount: number }) => s + a.loanCount, 0)).toBe(LOANS);
  });

  it('эрэмбэ (бүх whitelist багана), шүүлт, хайлт, хүрээ ≤ 2с', async () => {
    await expectFast('overdue sort dpd asc', '/reports/overdue-loans', { sortBy: 'dpd', sortDir: 'asc', pageSize: 100 });
    await expectFast('overdue sort customerName', '/reports/overdue-loans', { sortBy: 'customerName', pageSize: 50, page: 7 });
    await expectFast('outstanding sort outstandingInterest', '/reports/outstanding-balance', { sortBy: 'outstandingInterest', sortDir: 'desc', pageSize: 100 });
    await expectFast('outstanding filter branch+officer', '/reports/outstanding-balance', { branchId: 'branch-2', officerId: 'officer-3' });
    await expectFast('overdue search contractNo', '/reports/overdue-loans', { search: 'BULKC00123' });
    await expectFast('overdue search name', '/reports/overdue-loans', { search: 'Нэр12' });
    await expectFast('overdue search register', '/reports/overdue-loans', { search: 'УБ90000000' });
    await expectFast('officer scope', '/reports/overdue-loans', { pageSize: 100 }, actors.officer('officer-2') as typeof admin);
    await expectFast('BM scope dashboard', '/reports/dashboard/summary', {}, actors.branchManager('bm-1', 'branch-1') as typeof admin);
    await expectFast('upcoming default window', '/reports/upcoming-repayments', { pageSize: 100 });
    await expectFast('historic asOf', '/reports/overdue-loans', { asOf: '2026-05-01', pageSize: 100 });
  });

  it('Excel экспорт 10,000 мөр: ажиллана, JSON-той нийт тоо ижил; event loop-ийг удаан гацаахгүй (бусад хүсэлтүүд тасрахгүй)', async () => {
    let worst = 0; let last = performance.now();
    const timer = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last - 10); last = now; }, 10);
    const t0 = performance.now();
    const res = await env.http().get('/api/reports/outstanding-balance/export').set(admin)
      .buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    const ms = performance.now() - t0;
    await new Promise((r) => setTimeout(r, 30)); // төгсгөлийн синхрон блок timer-д тусах боломж
    clearInterval(timer);
    console.info(`[perf] export 10k мөр: ${Math.round(ms)} мс, ${(res.body as Buffer).length} байт, event loop-ийн хамгийн урт гацалт ${Math.round(worst)} мс`);
    expect(res.status).toBe(200);
    expect(ms).toBeLessThan(30_000);
    // streaming writer + хэсэгчилсэн хөрвүүлэлт: ≈ 0.3с (Prisma-ийн үр дүн задлах). Өмнөх синхрон ExcelJS ≈ 3с+ гацаж байсан.
    expect(worst, `event loop ${Math.round(worst)} мс гацсан`).toBeLessThan(2000);
    expect(await env.t.prisma.reportRun.count()).toBe(1);
    expect((await env.t.prisma.reportRun.findFirst())!.rowCount).toBe(LOANS);
  }, 60_000);

  it('экспортын хязгаар: нийт мөр > report.max_export_rows бол мөр уншихгүйгээр 422 (хэдхэн секундэд), аудитгүй', async () => {
    await env.t.prisma.setting.create({ data: { orgId: admin['x-org-id'], key: 'report.max_export_rows', valueJson: LOANS - 1 } });
    try {
      const { ms, res } = await timed('/reports/outstanding-balance/export');
      console.info(`[perf] export 422 (10k мөр, хязгаар ${LOANS - 1}): ${Math.round(ms)} мс`);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('EXPORT_TOO_LARGE');
      expect(ms).toBeLessThan(LIMIT_MS * 2);
      expect(await env.t.prisma.reportRun.count()).toBe(1); // зөвхөн өмнөх амжилттай экспорт
    } finally {
      await env.t.prisma.setting.deleteMany({ where: { key: 'report.max_export_rows' } });
    }
  }, 60_000);

  it('dashboard: 50 зэрэгцээ хүсэлт (ижил түлхүүр) бүгд 200 (өмнө нь pool дүүрч P2024 → 500), нэг тооцооллын хугацаанд', async () => {
    const t0 = performance.now();
    const res = await Promise.all(Array.from({ length: 50 }, () => env.http().get('/api/reports/dashboard/summary').set(admin)));
    const ms = performance.now() - t0;
    const codes = res.reduce<Record<number, number>>((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});
    console.info(`[perf] dashboard x50 (ижил түлхүүр): ${Math.round(ms)} мс ${JSON.stringify(codes)}`);
    expect(codes).toEqual({ 200: 50 });
    expect(ms).toBeLessThan(10_000);
  }, 60_000);

  it('dashboard: 12 өөр түлхүүр зэрэг (ЗЭЗ, салбар, asOf) → 500 байхгүй (200 эсвэл 429), нийтлэг pool-д хүндрэл учруулахгүй', async () => {
    const queries = [
      ...Array.from({ length: 5 }, (_, i) => ({ headers: actors.officer(`officer-${i + 1}`), query: {} })),
      ...Array.from({ length: 3 }, (_, i) => ({ headers: admin, query: { branchId: `branch-${i + 1}` } })),
      ...Array.from({ length: 4 }, (_, i) => ({ headers: admin, query: { asOf: `2026-09-${String(10 + i).padStart(2, '0')}` } })),
    ];
    const t0 = performance.now();
    const res = await Promise.all(queries.map((q) => env.http().get('/api/reports/dashboard/summary').query(q.query).set(q.headers as typeof admin)));
    const ms = performance.now() - t0;
    console.info(`[perf] dashboard x12 (өөр түлхүүр): ${Math.round(ms)} мс ${JSON.stringify(res.map((r) => r.status))}`);
    expect(res.filter((r) => r.status !== 200 && r.status !== 429)).toHaveLength(0);
    expect(res.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(12);
  }, 90_000);

  it('индекс ашиглалт: ЗЭЗ-ийн хүрээний шүүлт индексээр (EXPLAIN), бүх хүснэгтийг seq scan хийхгүй', async () => {
    const plan = await env.t.prisma.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
      `EXPLAIN SELECT id FROM origination.loan_application WHERE org_id = 'org-test' AND officer_id = 'officer-3' AND status IN ('ACTIVE','MIGRATED')`,
    );
    const text = plan.map((p) => p['QUERY PLAN']).join('\n');
    expect(text).toMatch(/Index/);
    expect(text).not.toMatch(/Seq Scan on loan_application/);
  });
});
