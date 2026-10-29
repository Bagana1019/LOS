import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AgingBucket, ApplicationStatus, DashboardSummary } from '@los/contracts';
import { actors, createApplication, hasTestDb } from '../../test-utils/factories';
import { OTHER_ORG, createPayment, rowsOf, seedLoan, seedOtherOrgLoan, type World } from './report.fixtures';
import { bootReport, getReport, resetAndSeed, resetReport, type ReportEnv } from './report.test-helpers';

type Q = Record<string, string | number>;

// Хүлээгдэх утгууд report.fixtures.ts-ийн тайлбар дээр гараар тооцсон (MNT, asOf 2026-10-28, ADMIN).
describe.skipIf(!hasTestDb)('report: dashboard (KPI) (HTTP)', () => {
  let env: ReportEnv;
  let w: World;
  const admin = actors.admin();
  beforeAll(async () => { env = await bootReport(); });
  afterAll(async () => { await env.t.close(); });
  beforeEach(async () => { w = await resetAndSeed(env); });

  const summary = async (headers: Record<string, string>, query: Q = {}): Promise<DashboardSummary> => {
    const res = await env.http().get('/api/reports/dashboard/summary').query(query).set(headers);
    if (res.status !== 200) throw new Error(`dashboard → ${res.status} ${JSON.stringify(res.body)}`);
    return DashboardSummary.parse(res.body);
  };
  const statusOf = (d: DashboardSummary, s: string) => d.applications.byStatus.find((x) => x.status === s)!;
  const bucketOf = (d: DashboardSummary, b: string) => d.portfolio.aging.find((x) => x.bucket === b)!;

  describe('ADMIN, MNT, asOf 2026-10-28', () => {
    it('хэлбэр: DTO parse, scope, 9 төлөв, 5 хувин, 12 сар', async () => {
      const d = await summary(admin);
      expect(d.asOf).toBe('2026-10-28');
      expect(d.currency).toBe('MNT');
      expect(d.scope).toEqual({ branchId: null, officerId: null });
      expect(d.generatedAt).toBe('2026-10-28T02:00:00.000Z');
      expect(d.applications.byStatus.map((s) => s.status)).toEqual([...ApplicationStatus]);
      expect(d.portfolio.aging.map((a) => a.bucket)).toEqual([...AgingBucket]);
      expect(d.disbursements.monthly.map((m) => m.month)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
    });

    it('хүсэлтүүд: төлвөөр (тоо + дүн), энэ сарын урсгал, батлах хувь, шийдвэрийн дундаж цаг', async () => {
      const a = (await summary(admin)).applications;
      expect(a.byStatus.map((s) => [s.status, s.count, s.amount])).toEqual([
        ['DRAFT', 1, 2_000_000], ['SUBMITTED', 1, 3_000_000], ['IN_APPROVAL', 0, 0], ['APPROVED', 1, 800_000], ['RETURNED', 1, 1_500_000],
        ['DISBURSING', 1, 700_000], ['ACTIVE', 5, 2_650_000], ['CLOSED', 2, 500_000], ['MIGRATED', 0, 0], // LD нь USD тул MNT-д орохгүй
      ]);
      expect(a).toMatchObject({ submittedThisMonth: 4, approvedThisMonth: 2, returnedThisMonth: 1, approvalRate: 0.666667 });
      expect(a.avgDecisionHours).toBe(30); // LB 12ц, LI 36ц, LJ 48ц, LN 24ц (LA нь 90 хоногоос өмнө)
    });

    it('олголт: энэ сар / өмнөх сар / YTD / сараар (хоосон сар 0)', async () => {
      const d = (await summary(admin)).disbursements;
      expect(d).toMatchObject({ thisMonthAmount: 250_000, thisMonthCount: 1, lastMonthAmount: 300_000, yearToDateAmount: 2_550_000 });
      expect(d.monthly.map((m) => [m.month, m.amount, m.count])).toEqual([
        ['2025-11', 0, 0], ['2025-12', 0, 0], ['2026-01', 0, 0], ['2026-02', 0, 0], ['2026-03', 0, 0], ['2026-04', 0, 0],
        ['2026-05', 400_000, 1], ['2026-06', 1_000_000, 1], ['2026-07', 600_000, 1], ['2026-08', 0, 0], ['2026-09', 300_000, 1], ['2026-10', 250_000, 1],
      ]); // DRAFT/SUBMITTED олголтын хүсэлт тооцогдохгүй
    });

    it('багц: үлдэгдэл, хэтэрсэн дүн/тоо, PAR, aging (packages/calc-ийн ангилал)', async () => {
      const p = (await summary(admin)).portfolio;
      expect(p).toMatchObject({ activeLoanCount: 5, outstandingPrincipal: 2_510_000, overdueAmount: 1_050_000, overdueLoanCount: 2, parRatio: 0.581673 });
      expect(p.aging.map((x) => [x.bucket, x.loanCount, x.principal])).toEqual([
        ['CURRENT', 3, 1_050_000], ['DPD_1_30', 0, 0], ['DPD_31_60', 1, 460_000], ['DPD_61_90', 0, 0], ['DPD_90_PLUS', 1, 1_000_000],
      ]);
      expect(p.aging.reduce((s, x) => s + x.loanCount, 0)).toBe(p.activeLoanCount);
      expect(p.aging.reduce((s, x) => s + x.principal, 0)).toBe(p.outstandingPrincipal);
    });

    it('цуглуулалт: энэ сард төлөх / цуглуулсан / хувь / дараагийн 7 хоног', async () => {
      const c = (await summary(admin)).collections;
      expect(c).toEqual({ dueThisMonth: 435_000, collectedThisMonth: 5_000, collectionRate: 0.011494, dueNext7Days: 320_000 });
    });

    it('топ бүтээгдэхүүн: DRAFT-гүй, дүнгээр буурах', async () => {
      const t = (await summary(admin)).topProducts;
      expect(t).toEqual([
        { productId: w.products.business.id, productName: 'Бизнесийн зээл', count: 6, amount: 5_650_000 },
        { productId: w.products.consumer.id, productName: 'Хэрэглээний зээл', count: 5, amount: 3_500_000 },
      ]);
    });

    it('dueNext7Days = "Эргэн төлөлт хийгдэх" тайлангийн [asOf, asOf+7] нийт үлдэгдэл (нэг эх сурвалж)', async () => {
      const up = await getReport(env, admin, 'upcoming-repayments', { currency: 'MNT', dateFrom: '2026-10-28', dateTo: '2026-11-04', pageSize: 100 });
      expect(up.totals?.outstanding).toBe((await summary(admin)).collections.dueNext7Days);
    });

    it('багц нь "Зээлийн үлдэгдэл" ба "Хугацаа хэтэрсэн" тайлантай тулгарна', async () => {
      const p = (await summary(admin)).portfolio;
      const bal = await getReport(env, admin, 'outstanding-balance', { currency: 'MNT' });
      expect(bal.totals?.outstandingPrincipal).toBe(p.outstandingPrincipal);
      expect(bal.total).toBe(p.activeLoanCount);
      const od = await getReport(env, admin, 'overdue-loans', { currency: 'MNT' });
      expect(od.total).toBe(p.overdueLoanCount);
      expect(od.rows.reduce((s, r) => s + (r.overdueTotal as number), 0)).toBe(p.overdueAmount);
    });
  });

  describe('валют, шүүлт, asOf', () => {
    it('USD: MNT-тэй холихгүй; жижиг үсэг зөвшөөрнө', async () => {
      const d = await summary(admin, { currency: 'usd' });
      expect(d.currency).toBe('USD');
      expect(statusOf(d, 'MIGRATED')).toMatchObject({ count: 1, amount: 3000 });
      expect(statusOf(d, 'ACTIVE').count).toBe(0);
      expect(d.portfolio).toMatchObject({ activeLoanCount: 1, outstandingPrincipal: 2000, overdueAmount: 1100, overdueLoanCount: 1, parRatio: 1 });
      expect(bucketOf(d, 'DPD_1_30')).toEqual({ bucket: 'DPD_1_30', loanCount: 1, principal: 2000 });
      expect(d.collections).toEqual({ dueThisMonth: 1100, collectedThisMonth: 0, collectionRate: 0, dueNext7Days: 0 });
      expect(d.disbursements.yearToDateAmount).toBe(0);
      expect(d.topProducts).toEqual([{ productId: w.products.consumer.id, productName: 'Хэрэглээний зээл', count: 1, amount: 3000 }]);
      expect((await summary(admin, { currency: 'EUR' })).portfolio.activeLoanCount).toBe(0);
    });

    it('түүхэн asOf=2026-09-30: тэр өдрийн байдал (дараах төлөлт, олголт үл тооцно)', async () => {
      const d = await summary(admin, { asOf: '2026-09-30' });
      expect(d.asOf).toBe('2026-09-30');
      expect(d.disbursements.monthly.at(-1)).toEqual({ month: '2026-09', amount: 300_000, count: 1 });
      expect(d.disbursements.monthly[0].month).toBe('2025-10');
      expect(d.disbursements).toMatchObject({ thisMonthAmount: 300_000, lastMonthAmount: 0, yearToDateAmount: 2_300_000 }); // LN 10-12 хараахан үгүй
      expect(d.applications).toMatchObject({ submittedThisMonth: 1, approvedThisMonth: 1, returnedThisMonth: 0, approvalRate: 1, avgDecisionHours: 12 });
      expect(d.portfolio).toMatchObject({ activeLoanCount: 5, outstandingPrincipal: 2_510_000, overdueAmount: 720_000, overdueLoanCount: 2, parRatio: 0.581673 });
      expect(bucketOf(d, 'DPD_1_30')).toMatchObject({ loanCount: 1, principal: 460_000 }); // LA: 09-10 → 20 хоног (LB-1 төлөлт 10-27 хараахан үгүй)
      expect(bucketOf(d, 'DPD_90_PLUS')).toMatchObject({ loanCount: 1, principal: 1_000_000 }); // LC: 07-01 → 91 хоног
      // 9-р сар: LA 110k (50k төлсөн) + LC 220k + LF 110k (CLOSED, бүтнээр төлсөн — цуглуулалтад ордог, finding: CLOSED хасагдаж хувь хазайна) → 440k / 160k
      expect(d.collections).toEqual({ dueThisMonth: 440_000, collectedThisMonth: 160_000, collectionRate: 0.363636, dueNext7Days: 220_000 });
    });

    it('salbar-ийн шүүлт (ADMIN): branchId=branch-2', async () => {
      const d = await summary(admin, { branchId: 'branch-2' });
      expect(d.scope).toEqual({ branchId: 'branch-2', officerId: null });
      expect(d.portfolio).toMatchObject({ activeLoanCount: 2, outstandingPrincipal: 1_250_000, overdueAmount: 880_000, overdueLoanCount: 1, parRatio: 0.8 });
    });
  });

  describe('хүрээ (NFR-3)', () => {
    it('ЗЭЗ: зөвхөн өөрийн хүсэлт; өөр салбарын шүүлтийг үл тооно', async () => {
      const d = await summary(actors.officer('officer-1'), { branchId: 'branch-2' });
      expect(d.scope).toEqual({ branchId: 'branch-2', officerId: 'officer-1' }); // ЗЭЗ-ийн хүрээ дээр салбарын шүүлт нарийсгана
      expect(d.portfolio.activeLoanCount).toBe(0);
      const own = await summary(actors.officer('officer-1'));
      expect(own.scope).toEqual({ branchId: null, officerId: 'officer-1' });
      expect(own.applications.byStatus.map((s) => [s.status, s.count, s.amount]).filter(([, c]) => c !== 0)).toEqual([
        ['SUBMITTED', 1, 3_000_000], ['RETURNED', 1, 1_500_000], ['DISBURSING', 1, 700_000], ['ACTIVE', 3, 1_400_000], ['CLOSED', 1, 400_000],
      ]);
      expect(own.applications).toMatchObject({ submittedThisMonth: 2, approvedThisMonth: 0, returnedThisMonth: 1, approvalRate: 0, avgDecisionHours: 24 });
      expect(own.disbursements).toMatchObject({ thisMonthAmount: 0, lastMonthAmount: 300_000, yearToDateAmount: 1_300_000 });
      expect(own.portfolio).toMatchObject({ activeLoanCount: 3, outstandingPrincipal: 1_260_000, overdueAmount: 170_000, overdueLoanCount: 1, parRatio: 0.365079 });
      expect(own.collections).toEqual({ dueThisMonth: 215_000, collectedThisMonth: 5_000, collectionRate: 0.023256, dueNext7Days: 100_000 });
      expect(own.topProducts.map((p) => [p.productName, p.count, p.amount])).toEqual([['Хэрэглээний зээл', 5, 3_500_000], ['Бизнесийн зээл', 2, 3_500_000]]); // дүн тэнцүү → тоо буурах
    });

    it('салбарын захирал: зөвхөн өөрийн салбар', async () => {
      const bm2 = await summary(actors.branchManager('bm-2', 'branch-2'));
      expect(bm2.scope).toEqual({ branchId: 'branch-2', officerId: null });
      expect(bm2.portfolio).toMatchObject({ activeLoanCount: 2, outstandingPrincipal: 1_250_000, parRatio: 0.8 });
      expect(statusOf(bm2, 'DRAFT')).toMatchObject({ count: 1, amount: 2_000_000 });
      const sneaky = await summary(actors.branchManager('bm-1', 'branch-1'), { branchId: 'branch-2' });
      expect(sneaky.scope.branchId).toBe('branch-1');
      expect(sneaky.portfolio.activeLoanCount).toBe(3);
      const res = await env.http().get('/api/reports/dashboard/summary').set({ 'x-user-id': 'bm', 'x-roles': 'BRANCH_MANAGER', 'x-org-id': admin['x-org-id'] });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('BRANCH_REQUIRED');
    });

    it('APPROVER бүгдийг харна; хэрэглэгчийн дүр: 401/403', async () => {
      expect((await summary(actors.approver())).portfolio.activeLoanCount).toBe(5);
      expect((await env.http().get('/api/reports/dashboard/summary').set(actors.anonymous())).status).toBe(401);
      expect((await env.http().get('/api/reports/dashboard/summary').set({ 'x-customer-id': 'c', 'x-roles': 'CUSTOMER', 'x-org-id': admin['x-org-id'] })).status).toBe(403);
    });

    it('org тусгаарлалт', async () => {
      await seedOtherOrgLoan(env.t.prisma);
      expect((await summary(admin)).portfolio.activeLoanCount).toBe(5);
      const other = await summary({ ...admin, 'x-org-id': OTHER_ORG });
      expect(other.portfolio.activeLoanCount).toBe(1);
      expect(statusOf(other, 'ACTIVE').count).toBe(1);
    });
  });

  describe('оролтын шалгалт ба хилийн тохиолдол', () => {
    it.each([{ currency: 'MN' }, { currency: 'MNTX' }, { asOf: '2026-02-30' }, { asOf: 'yesterday' }])('%j → 400', async (q) => {
      const res = await env.http().get('/api/reports/dashboard/summary').query(q).set(admin);
      expect(res.status).toBe(400);
    });

    it('Улаанбаатарын цагийн хил: сарын эхлэл (UB 10-01 00:00) ба asOf өдрийн төгсгөл', async () => {
      const mk = (appNo: string, submittedAt: string) => createApplication(env.t.prisma, { appNo, status: 'SUBMITTED', amount: 1, submittedAt: new Date(submittedAt) });
      const base = (await summary(admin)).applications.submittedThisMonth;
      await mk('B-1', '2026-09-30T15:59:59Z'); // UB 09-30 23:59:59 → өмнөх сар
      expect((await summary(admin)).applications.submittedThisMonth).toBe(base);
      await mk('B-2', '2026-09-30T16:00:00Z'); // UB 10-01 00:00:00 → энэ сар
      expect((await summary(admin)).applications.submittedThisMonth).toBe(base + 1);
      await mk('B-3', '2026-10-28T15:59:59Z'); // UB 10-28 23:59:59 → asOf өдрийн дотор
      expect((await summary(admin)).applications.submittedThisMonth).toBe(base + 2);
      await mk('B-4', '2026-10-28T16:00:00Z'); // UB 10-29 00:00:00 → asOf-ийн дараа
      expect((await summary(admin)).applications.submittedThisMonth).toBe(base + 2);
    });

    it('идемпотент + зэрэгцээ: ижил хариу, өгөгдөл өөрчлөгдөхгүй, аудитгүй', async () => {
      const strip = (d: DashboardSummary) => ({ ...d, generatedAt: '' });
      const first = strip(await summary(admin));
      const many = await Promise.all(Array.from({ length: 8 }, (_, i) => summary(i % 2 ? admin : actors.approver())));
      for (const m of many) expect(strip(m)).toEqual(first);
      expect(await env.t.prisma.reportRun.count()).toBe(0);
    });

    it('сарын шилжилт: 1-р сар → өмнөх сар = өмнөх жилийн 12-р сар, YTD зөвхөн энэ жил', async () => {
      env.t.clock.set('2026-01-15T02:00:00Z');
      const d = await summary(admin, { asOf: '2026-01-15' });
      expect(d.disbursements.monthly[0].month).toBe('2025-02');
      expect(d.disbursements.monthly.at(-1)!.month).toBe('2026-01');
      expect(d.disbursements.monthly.at(-2)!.month).toBe('2025-12');
      expect(d.disbursements.yearToDateAmount).toBe(0);
      expect(d.portfolio.parRatio === null || d.portfolio.parRatio >= 0).toBe(true);
    });
  });

  // Finding: collections нь зөвхөн ACTIVE/MIGRATED-ээр хязгаарлагдаж, энэ сард бүрэн төлөөд CLOSED болсон зээлийг хасч collectionRate-ийг доош хазайлгаж байсан.
  describe('цуглуулалт: энэ сард CLOSED болсон зээл', () => {
    const DUE = '2026-10-10';
    let n = 0;
    /** Нэг мөртэй (100k үндсэн + 10k хүү) зээл. `paid` бол мөрийг бүтнээр нь 10-09-нд төлүүлнэ. */
    async function loan(status: 'ACTIVE' | 'CLOSED', o: { paid?: boolean; extraDue?: string; officerId?: string } = {}) {
      n++;
      const rows = rowsOf(o.extraDue ? [DUE, o.extraDue] : [DUE], 100_000, 10_000);
      const l = await seedLoan(env.t.prisma, {
        key: `CL${n}`, last: `Овог${n}`, first: `Нэр${n}`, register: `УБ9100${String(n).padStart(4, '0')}`, phone: `9100${String(n).padStart(4, '0')}`,
        app: { contractNo: `CLC${n}`, status, amount: 100_000 * rows.length, termMonths: rows.length, interestRate: 24, branchId: 'branch-1', officerId: o.officerId ?? 'officer-1' },
      }, { rows });
      if (o.paid) await createPayment(env.t.prisma, l.app.id, { id: `CLP${n}`, paidAt: '2026-10-09T04:00:00Z', amount: 110_000, allocations: [{ rowId: l.rows[0].id, interest: 10_000, principal: 100_000 }] });
      return l;
    }

    it('10 зээл: 6 нь бүрэн төлөөд CLOSED, 4 нь төлөөгүй ACTIVE → due 1,100,000 / collected 660,000 / хувь 60% (өмнө нь due 440,000, collected 0, 0%)', async () => {
      await resetReport(env);
      for (let i = 0; i < 6; i++) await loan('CLOSED', { paid: true });
      for (let i = 0; i < 4; i++) await loan('ACTIVE');
      const d = await summary(admin);
      expect(d.collections).toEqual({ dueThisMonth: 1_100_000, collectedThisMonth: 660_000, collectionRate: 0.6, dueNext7Days: 0 });
      // багц (PAR, aging) зөвхөн эргэн төлөгдөж буй зээл: CLOSED орохгүй
      expect(d.portfolio).toMatchObject({ activeLoanCount: 4, overdueLoanCount: 4, outstandingPrincipal: 400_000 });
      expect(d.applications.byStatus.find((x) => x.status === 'CLOSED')).toMatchObject({ count: 6 });
    });

    it('ACTIVE зээл бүтнээр төлөгдөөд CLOSED болох үед хувь буурахгүй (төлөлт хийсэн зээл хасагдахгүй)', async () => {
      await resetReport(env);
      const l = await loan('ACTIVE', { paid: true });
      await loan('ACTIVE');
      expect((await summary(admin)).collections).toMatchObject({ dueThisMonth: 220_000, collectedThisMonth: 110_000, collectionRate: 0.5 });
      await env.t.prisma.loanApplication.update({ where: { id: l.app.id }, data: { status: 'CLOSED' } });
      expect((await summary(admin)).collections).toMatchObject({ dueThisMonth: 220_000, collectedThisMonth: 110_000, collectionRate: 0.5 });
    });

    it('хүрээ: ЗЭЗ зөвхөн өөрийн CLOSED зээлийг цуглуулалтад авна', async () => {
      await resetReport(env);
      await loan('CLOSED', { paid: true, officerId: 'officer-1' });
      await loan('CLOSED', { paid: true, officerId: 'officer-2' });
      await loan('ACTIVE', { officerId: 'officer-2' });
      expect((await summary(actors.officer('officer-1'))).collections).toMatchObject({ dueThisMonth: 110_000, collectedThisMonth: 110_000, collectionRate: 1 });
      expect((await summary(actors.officer('officer-2'))).collections).toMatchObject({ dueThisMonth: 220_000, collectedThisMonth: 110_000, collectionRate: 0.5 });
    });

    it('"дараагийн 7 хоног" зөвхөн ACTIVE/MIGRATED: CLOSED зээлийн төлөгдөөгүй ирээдүйн мөр орохгүй (Эргэн төлөлт хийгдэх тайлантай нэг эх сурвалж)', async () => {
      await resetReport(env);
      await loan('CLOSED', { paid: true, extraDue: '2026-11-02' }); // Core-оос эрт хаагдсан: 11-02 мөр манай ЭТХ-д төлөгдөөгүй үлдсэн
      await loan('ACTIVE', { paid: true, extraDue: '2026-11-02' });
      const d = await summary(admin);
      expect(d.collections.dueNext7Days).toBe(110_000); // зөвхөн ACTIVE зээлийнх
      const up = await getReport(env, admin, 'upcoming-repayments', { currency: 'MNT', dateFrom: '2026-10-28', dateTo: '2026-11-04', pageSize: 100 });
      expect(up.totals?.outstanding).toBe(d.collections.dueNext7Days);
      expect(d.collections).toMatchObject({ dueThisMonth: 220_000, collectedThisMonth: 220_000, collectionRate: 1 }); // 11-02 мөр 10-р сард тооцогдохгүй
    });

    it('өмнөх сард хаагдсан зээл энэ сарын цуглуулалтад нөлөөлөхгүй', async () => {
      await resetReport(env);
      const old = await seedLoan(env.t.prisma, { key: 'OLD', last: 'Хуучин', first: 'Зээл', register: 'УБ91009999', phone: '91009999', app: { contractNo: 'CLOLD', status: 'CLOSED', amount: 100_000, termMonths: 1, interestRate: 24, branchId: 'branch-1', officerId: 'officer-1' } }, { rows: rowsOf(['2026-09-10'], 100_000, 10_000) });
      await createPayment(env.t.prisma, old.app.id, { id: 'OLDP', paidAt: '2026-09-09T04:00:00Z', amount: 110_000, allocations: [{ rowId: old.rows[0].id, interest: 10_000, principal: 100_000 }] });
      expect((await summary(admin)).collections).toEqual({ dueThisMonth: 0, collectedThisMonth: 0, collectionRate: null, dueNext7Days: 0 });
    });
  });

  describe('хоосон өгөгдөл', () => {
    it('тэг ба null (0-д хуваахгүй), 12 сар, 5 хувин, 9 төлөв', async () => {
      await resetReport(env);
      const d = await summary(admin);
      expect(d.applications.byStatus).toHaveLength(9);
      expect(d.applications.byStatus.every((s) => s.count === 0 && s.amount === 0)).toBe(true);
      expect(d.applications).toMatchObject({ submittedThisMonth: 0, approvedThisMonth: 0, returnedThisMonth: 0, approvalRate: null, avgDecisionHours: null });
      expect(d.disbursements.monthly).toHaveLength(12);
      expect(d.disbursements.monthly.every((m) => m.amount === 0 && m.count === 0)).toBe(true);
      expect(d.disbursements).toMatchObject({ thisMonthAmount: 0, lastMonthAmount: 0, thisMonthCount: 0, yearToDateAmount: 0 });
      expect(d.portfolio).toMatchObject({ activeLoanCount: 0, outstandingPrincipal: 0, overdueAmount: 0, overdueLoanCount: 0, parRatio: null });
      expect(d.portfolio.aging).toHaveLength(5);
      expect(d.portfolio.aging.every((a) => a.loanCount === 0 && a.principal === 0)).toBe(true);
      expect(d.collections).toEqual({ dueThisMonth: 0, collectedThisMonth: 0, collectionRate: null, dueNext7Days: 0 });
      expect(d.topProducts).toEqual([]);
    });

    it('зөвхөн ЭТХ-гүй идэвхтэй зээл: үлдэгдэл = зээлийн дүн, хэтрэлтгүй', async () => {
      await resetReport(env);
      await createApplication(env.t.prisma, { appNo: 'NS-1', status: 'ACTIVE', amount: 700_000, contractNo: 'NS1' });
      const d = await summary(admin);
      expect(d.portfolio).toMatchObject({ activeLoanCount: 1, outstandingPrincipal: 700_000, overdueAmount: 0, overdueLoanCount: 0, parRatio: 0 });
      expect(bucketOf(d, 'CURRENT')).toMatchObject({ loanCount: 1, principal: 700_000 });
    });
  });
});
