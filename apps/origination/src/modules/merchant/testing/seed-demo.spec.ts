import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MerchantDashboard, PosLeaseAdminView } from '@los/contracts';
import { Clock } from '../ports';
import { personasFor, toContext } from './personas';
import { DEMO_ORG_ID, DemoClock, seedDemo, type DemoSeedResult } from './seed-demo';
import { TestApp } from './test-app';

describe('seedDemo (demo data for scripts/merchant-demo.ts)', () => {
  const clock = new DemoClock();
  let t: TestApp;
  let seeded: DemoSeedResult;
  beforeAll(async () => {
    t = await TestApp.create({ overrides: [{ provide: Clock, useValue: clock }] });
    seeded = await seedDemo(t.services, clock);
  });
  afterAll(async () => { await t.close(); });

  it('creates about 25 leases across the expected statuses, and the clock goes live afterwards', () => {
    expect(seeded.leases).toBe(25);
    expect(Object.keys(seeded.byStatus).sort()).toEqual(['ACCEPTED', 'APPROVED', 'CANCELLED', 'DECLINED', 'DELIVERED', 'DRAFT', 'EXPIRED', 'REFERRED', 'SETTLED']);
    expect(seeded.byStatus).toMatchObject({ DECLINED: 3, EXPIRED: 2, CANCELLED: 3, DELIVERED: 3, SETTLED: 9, REFERRED: 2, ACCEPTED: 1, APPROVED: 1, DRAFT: 1 });
    expect(Math.abs(clock.now().getTime() - Date.now())).toBeLessThan(5_000);
  });

  it('produces dashboard data for merchant A and keeps merchant B separate', async () => {
    const p = personasFor(seeded.fixtures.merchantA.id, DEMO_ORG_ID);
    const res = await t.getJson('/merchant-portal/dashboard', p.merchantAdmin());
    expect(res.status).toBe(200);
    const dash = MerchantDashboard.parse(res.body);
    expect(dash.totals.requests).toBeGreaterThan(10);
    expect(dash.totals.settled).toBeGreaterThanOrEqual(3);
    expect(dash.totals.financedAmount).toBeGreaterThan(0);
    expect(dash.daily.filter((d) => d.requests > 0).length).toBeGreaterThan(5); // 14 хоногт тархсан
    expect(dash.byStore.length).toBe(2);
    const b = await t.getJson('/merchant-portal/dashboard', personasFor(seeded.fixtures.merchantB.id, DEMO_ORG_ID).merchantAdmin());
    const dashB = MerchantDashboard.parse(b.body);
    expect(dashB.byStore.length).toBe(2);
    expect(dashB.totals.requests + dash.totals.requests).toBe(seeded.leases);
  });

  it('lender sees referred leases waiting for review without raw PII', async () => {
    const p = personasFor(seeded.fixtures.merchantA.id, DEMO_ORG_ID);
    const list = await t.getJson('/pos-leases?status=REFERRED', p.lenderAdmin());
    expect(list.body.total).toBe(2);
    const one = PosLeaseAdminView.parse((await t.getJson(`/pos-leases/${list.body.items[0].id}`, p.approver())).body);
    expect(one.status).toBe('REFERRED');
    expect(JSON.stringify(list.body)).not.toMatch(/УЕ9005\d{4}/);
    expect(toContext(p.approver()).orgId).toBe(DEMO_ORG_ID);
  });

  it('events were emitted through the outbox for the whole history', () => {
    const types = new Set<string>(t.outbox.events.map((e) => e.type));
    for (const type of ['PosLeaseDecided', 'PosLeaseAccepted', 'PosLeaseDelivered', 'PosLeaseSettled', 'PosLeaseCancelled', 'MerchantStatusChanged']) expect(types.has(type)).toBe(true);
  });
});
