import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DashboardSummary } from '@los/contracts';
import { actors, hasTestDb } from '../../test-utils/factories';
import { accountsFor } from '../../integrations/core-deposit/core-deposit.mock';
import { bootReport, col, getReport, resetAndSeed, type ReportEnv } from './report.test-helpers';
import type { World } from './report.fixtures';

// F11-2: asOf нь зээлийн олонлогийг ч хязгаарлана — зээл asOf өдрийн төгсгөл (UB) хүртэл олгогдсон байж л тоологдоно.
// Олголтын огноо (fixtures): LA 07-05, LB 09-28, LC 06-01, LN 10-12 (UB 10:00); LD (MIGRATED) ба LE (ACTIVE) нь огноогүй (NULL).
describe.skipIf(!hasTestDb)('report: asOf нь зээлийн олонлогийг хязгаарлана (F11-2)', () => {
  let env: ReportEnv;
  let w: World;
  const admin = actors.admin();
  beforeAll(async () => { env = await bootReport(); });
  afterAll(async () => { await env.t.close(); });
  beforeEach(async () => { w = await resetAndSeed(env); });

  const nos = async (key: string, query: Record<string, string | number>) => [...new Set(col(await getReport(env, admin, key, query), 'contractNo') as string[])].sort();
  const summary = async (query: Record<string, string>): Promise<DashboardSummary> => {
    const res = await env.http().get('/api/reports/dashboard/summary').query(query).set(admin);
    if (res.status !== 200) throw new Error(`dashboard → ${res.status} ${JSON.stringify(res.body)}`);
    return DashboardSummary.parse(res.body);
  };
  const disbursedAt = (id: string, iso: string) => env.t.prisma.loanApplication.update({ where: { id }, data: { disbursedAt: new Date(iso) } });

  describe('outstanding-balance', () => {
    it('asOf-аас хойш олгогдсон зээл орохгүй', async () => {
      expect(await nos('outstanding-balance', { asOf: '2026-07-04' })).toEqual(['B10026LC', 'B10026LD', 'B10026LE']);
      expect(await nos('outstanding-balance', { asOf: '2026-09-30' })).toEqual(['B10026LA', 'B10026LB', 'B10026LC', 'B10026LD', 'B10026LE']);
      expect(await nos('outstanding-balance', { asOf: '2026-10-28' })).toEqual(['B10026LA', 'B10026LB', 'B10026LC', 'B10026LD', 'B10026LE', 'B10026LN']);
    });

    it('олгосон өдрийн төгсгөл хүртэл орно: LA (07-05 UB 10:00) asOf=07-04-д үгүй, 07-05-д бий', async () => {
      expect(await nos('outstanding-balance', { asOf: '2026-07-04', currency: 'MNT' })).not.toContain('B10026LA');
      expect(await nos('outstanding-balance', { asOf: '2026-07-05', currency: 'MNT' })).toContain('B10026LA');
    });

    it('UB-ийн хил: 10-11 17:30 UTC = UB 10-12 01:30 → asOf=10-11-д үгүй, 10-12-т бий', async () => {
      await disbursedAt(w.LN.app.id, '2026-10-11T17:30:00Z');
      expect(await nos('outstanding-balance', { asOf: '2026-10-11', currency: 'MNT' })).not.toContain('B10026LN');
      expect(await nos('outstanding-balance', { asOf: '2026-10-12', currency: 'MNT' })).toContain('B10026LN');
    });

    it('олгосон огноо тодорхойгүй (NULL: MIGRATED/эхний үлдэгдэл) зээлийг орхихгүй — бодит өгөгдөл зохиохгүй', async () => {
      expect(await nos('outstanding-balance', { asOf: '1900-01-01' })).toEqual(['B10026LD', 'B10026LE']);
    });

    it('нийлбэр asOf-ийн олонлогоор: asOf=07-04 MNT → LC 1,000,000 + LE 500,000', async () => {
      const r = await getReport(env, admin, 'outstanding-balance', { asOf: '2026-07-04', currency: 'MNT' });
      expect(r.totals).toMatchObject({ disbursedAmount: 1_500_000, outstandingPrincipal: 1_500_000 });
    });
  });

  describe('overdue-loans', () => {
    it('asOf-ийн өдөр олгогдоогүй зээл (LA нь 08-20 болсон) хугацаа хэтэрсэнд орохгүй', async () => {
      await disbursedAt(w.LA.app.id, '2026-08-20T02:00:00Z'); // LA-ийн 1-р мөр 08-10 → asOf=08-11-д хэтэрсэн байх байсан
      expect(await nos('overdue-loans', { asOf: '2026-08-11', currency: 'MNT' })).toEqual(['B10026LC']);
    });

    it('олгосон өдрөө (UB 08-11 10:00) asOf=08-11 бол орно: LA-ийн 08-10 мөр хэтэрсэн (DPD 1)', async () => {
      await disbursedAt(w.LA.app.id, '2026-08-11T02:00:00Z');
      expect(await nos('overdue-loans', { asOf: '2026-08-11', currency: 'MNT' })).toEqual(['B10026LA', 'B10026LC']);
    });
  });

  describe('upcoming-repayments', () => {
    it('asOf=07-04, цонх 08-31 хүртэл: зөвхөн LC-ийн 08-01 (LA 07-05-д олгогдох тул 08-10 мөр орохгүй)', async () => {
      const r = await getReport(env, admin, 'upcoming-repayments', { asOf: '2026-07-04', dateTo: '2026-08-31', currency: 'MNT' });
      expect(r.rows.map((x) => [x.contractNo, x.dueDate])).toEqual([['B10026LC', '2026-08-01']]);
    });
  });

  describe('deposit-balances', () => {
    it('asOf=07-04: зөвхөн тэр үед зээлтэй байсан харилцагчид (LC, LD, LE)', async () => {
      const a = await getReport(env, admin, 'deposit-balances', { asOf: '2026-07-04', pageSize: 100 });
      const expected = [[w.LC.customer.id, 'УБ90000003'], [w.LD.customer.id, 'УБ90000004'], [w.LE.customer.id, 'УБ90000005']].flatMap(([id, reg]) => accountsFor(id, reg));
      expect(a.total).toBe(expected.length);
    });
  });

  describe('dashboard', () => {
    it('asOf=2026-07-04: багц зөвхөн LC + LE (LA, LB, LN хараахан олгогдоогүй)', async () => {
      const d = await summary({ asOf: '2026-07-04' });
      // LC 07-01 мөр хэтэрсэн (3 хоног): 220k, үндсэн 1,000,000 / 1,500,000
      expect(d.portfolio).toMatchObject({ activeLoanCount: 2, outstandingPrincipal: 1_500_000, overdueAmount: 220_000, overdueLoanCount: 1, parRatio: 0.666667 });
    });

    it('asOf=1900-01-01: олгосон огнотой зээл байхгүй → зөвхөн огноогүй LE', async () => {
      const d = await summary({ asOf: '1900-01-01' });
      expect(d.portfolio).toMatchObject({ activeLoanCount: 1, outstandingPrincipal: 500_000 });
    });

    it('цуглуулалт: asOf сард олгогдоогүй зээлийн мөр "төлөх ёстой"-д орохгүй', async () => {
      await disbursedAt(w.LA.app.id, '2026-08-20T02:00:00Z'); // LA 08-10 мөр (110k) asOf=08-11-д олголтоос өмнөх тул тоологдохгүй
      const d = await summary({ asOf: '2026-08-11' });
      // 8-р сар: LC 08-01 220k + LF 08-20 110k (CLOSED, 08-25-д төлсөн → asOf-д хараахан үгүй)
      expect(d.collections).toEqual({ dueThisMonth: 330_000, collectedThisMonth: 0, collectionRate: 0, dueNext7Days: 0 });
    });
  });
});
