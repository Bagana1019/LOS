import { MerchantDashboard } from '@los/contracts';
import { describe, expect, it } from 'vitest';
import type { LeaseDashboardRow } from '../domain/records';
import { makeDashboardRow } from '../testing/records';
import { calculateDashboard } from './dashboard.calculator';

// Огноо: Улаанбаатар = UTC+8. now = 2026-10-28 12:00 MN (04:00Z). Хүрээ: 10-26 … 10-28.
const now = new Date('2026-10-28T04:00:00.000Z');
const from = new Date('2026-10-25T16:00:00.000Z');
const z = (s: string) => new Date(`${s}Z`);
const plus = (d: Date, sec: number) => new Date(d.getTime() + sec * 1000);
const stores = new Map([['S1', 'Төв дэлгүүр'], ['S2', 'Салбар дэлгүүр']]);

const row = (id: string, o: Partial<LeaseDashboardRow>): LeaseDashboardRow => makeDashboardRow({ id, ...o });
const accepted = (created: Date) => plus(created, 120);

// r1 10-26 10:00 MN
const c1 = z('2026-10-26T02:00:00');
const c2 = z('2026-10-26T06:00:00'); // 10-26 14:00 MN
const c3 = z('2026-10-27T01:00:00'); // 10-27 09:00 MN
const c4 = z('2026-10-27T03:00:00');
const c5 = z('2026-10-27T07:00:00');
const c6 = z('2026-10-28T01:00:00'); // 10-28 09:00 MN
const c7 = z('2026-10-28T02:00:00');
const c8 = z('2026-10-28T03:30:00');
const c9 = z('2026-10-26T03:00:00'); // 10-26 11:00 MN
const c10 = z('2026-10-27T04:00:00');
const future = new Date(now.getTime() + 600_000);
const past = new Date(now.getTime() - 600_000);

const rows: LeaseDashboardRow[] = [
  row('r1', { status: 'SETTLED', storeId: 'S1', planCode: 'P1', decision: 'APPROVE', createdAt: c1, decidedAt: plus(c1, 20), decidedBy: 'SYSTEM', acceptedAt: accepted(c1), deliveredAt: plus(c1, 600), settledAt: plus(c1, 86_400), goodsPrice: 3_000_000, financedAmount: 2_400_000, merchantCommissionAmount: 72_000, merchantNetAmount: 2_328_000 }),
  row('r2', { status: 'DELIVERED', storeId: 'S1', planCode: 'P1', decision: 'APPROVE', createdAt: c2, decidedAt: plus(c2, 40), decidedBy: 'SYSTEM', acceptedAt: accepted(c2), deliveredAt: plus(c2, 600), goodsPrice: 2_000_000, financedAmount: 1_800_000, merchantCommissionAmount: 54_000, merchantNetAmount: 1_746_000 }),
  row('r3', { status: 'ACCEPTED', storeId: 'S2', planCode: 'P2', decision: 'APPROVE', createdAt: c3, decidedAt: plus(c3, 30), decidedBy: 'SYSTEM', acceptedAt: accepted(c3), goodsPrice: 1_500_000, financedAmount: 1_200_000, merchantCommissionAmount: 36_000, merchantNetAmount: 1_164_000 }),
  row('r4', { status: 'DECLINED', storeId: 'S2', planCode: 'P1', decision: 'DECLINE', createdAt: c4, decidedAt: plus(c4, 10), decidedBy: 'SYSTEM', goodsPrice: 5_000_000, financedAmount: 4_500_000 }),
  row('r5', { status: 'REFERRED', storeId: 'S1', planCode: 'P2', decision: 'REFER', createdAt: c5, decidedAt: plus(c5, 50), decidedBy: 'SYSTEM', expiresAt: future, goodsPrice: 800_000, financedAmount: 700_000 }),
  row('r6', { status: 'APPROVED', storeId: 'S1', planCode: 'P1', decision: 'APPROVE', createdAt: c6, decidedAt: plus(c6, 25), decidedBy: 'SYSTEM', expiresAt: future, goodsPrice: 1_100_000, financedAmount: 1_000_000 }),
  row('r7', { status: 'DRAFT', storeId: 'S2', planCode: 'P2', createdAt: c7, expiresAt: past, goodsPrice: 900_000, financedAmount: 800_000 }), // lazy EXPIRED
  row('r8', { status: 'DRAFT', storeId: 'S1', planCode: 'P1', createdAt: c8, expiresAt: future, goodsPrice: 700_000, financedAmount: 600_000 }),
  row('r9', { status: 'CANCELLED', storeId: 'S2', planCode: 'P1', decision: 'APPROVE', createdAt: c9, decidedAt: plus(c9, 60), decidedBy: 'SYSTEM', goodsPrice: 1_000_000, financedAmount: 900_000 }),
  row('r10', { status: 'APPROVED', storeId: 'S1', planCode: 'P2', decision: 'APPROVE', createdAt: c10, decidedAt: plus(c10, 3600), decidedBy: 'REVIEWER', expiresAt: future, goodsPrice: 2_200_000, financedAmount: 2_000_000 }),
];

describe('calculateDashboard (hand-computed)', () => {
  const r = calculateDashboard({ rows, now, from, to: now, storeNames: stores });

  it('totals', () => {
    expect(r.totals).toEqual({
      requests: 10,
      approved: 6, // r1 r2 r3 r6 r9 r10
      referred: 1, // r5 (нээлттэй)
      declined: 1, // r4
      accepted: 3, // r1 r2 r3
      delivered: 2, // r1 r2
      settled: 1, // r1
      cancelledOrExpired: 2, // r9 CANCELLED + r7 lazy EXPIRED
      approvalRate: 0.75, // 6 / 8 шийдвэртэй
      conversionRate: 0.5, // 3 / 6
      avgDecisionSeconds: 33.57, // (20+40+30+10+50+25+60)/7 — REVIEWER (r10) оруулахгүй
      financedAmount: 5_400_000, // 2.4M + 1.8M + 1.2M
      goodsSalesAmount: 6_500_000, // 3M + 2M + 1.5M
      commissionAmount: 126_000, // r1 72k + r2 54k
      awaitingSettlementNet: 1_746_000, // r2
      settledNet: 2_328_000, // r1
    });
  });
  it('daily is zero filled per Ulaanbaatar date, grouped by createdAt', () => {
    expect(r.daily).toEqual([
      { date: '2026-10-26', requests: 3, approved: 3, financedAmount: 4_200_000 }, // r1 r2 r9
      { date: '2026-10-27', requests: 4, approved: 2, financedAmount: 1_200_000 }, // r3 r4 r5 r10
      { date: '2026-10-28', requests: 3, approved: 1, financedAmount: 0 }, // r6 r7 r8
    ]);
  });
  it('byStore is sorted by requests desc', () => {
    expect(r.byStore).toEqual([
      { storeId: 'S1', storeName: 'Төв дэлгүүр', requests: 6, approved: 4, financedAmount: 4_200_000 },
      { storeId: 'S2', storeName: 'Салбар дэлгүүр', requests: 4, approved: 2, financedAmount: 1_200_000 },
    ]);
  });
  it('byPlan is sorted by requests desc', () => {
    expect(r.byPlan).toEqual([
      { planCode: 'P1', requests: 6, approved: 4, financedAmount: 4_200_000 },
      { planCode: 'P2', requests: 4, approved: 2, financedAmount: 1_200_000 },
    ]);
  });
  it('todo uses the effective status', () => {
    expect(r.todo).toEqual({ awaitingOtp: 1, awaitingAcceptance: 2, awaitingDelivery: 1, referred: 1 }); // r8 | r6 r10 | r3 | r5
  });
  it('result satisfies the contract shape', () => {
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const byStore = r.byStore.map((x, i) => ({ ...x, storeId: uuid(i + 1) }));
    const full = { range: { from: from.toISOString(), to: now.toISOString() }, ...r, byStore, limits: { maxTicketAmount: 1, dailyLimitAmount: null, dailyUsedAmount: 0 }, recent: [] };
    expect(MerchantDashboard.safeParse(full).success).toBe(true);
  });
});

describe('calculateDashboard edge cases', () => {
  it('no rows: null rates, zero totals, zero filled days and zero-row stores', () => {
    const r = calculateDashboard({ rows: [], now, from, to: now, storeNames: stores });
    expect(r.totals).toMatchObject({ requests: 0, approvalRate: null, conversionRate: null, avgDecisionSeconds: null, financedAmount: 0, commissionAmount: 0 });
    expect(r.daily.map((d) => d.date)).toEqual(['2026-10-26', '2026-10-27', '2026-10-28']);
    expect(r.daily.every((d) => d.requests === 0 && d.financedAmount === 0)).toBe(true);
    expect(r.byStore.map((s) => [s.storeId, s.requests])).toEqual([['S2', 0], ['S1', 0]]); // тэнцүү бол нэрээр: Салбар < Төв
    expect(r.byPlan).toEqual([]);
    expect(r.todo).toEqual({ awaitingOtp: 0, awaitingAcceptance: 0, awaitingDelivery: 0, referred: 0 });
  });
  it('decisions without approvals give approvalRate 0 and conversionRate null', () => {
    const r = calculateDashboard({ rows: [row('a', { decision: 'DECLINE', status: 'DECLINED', decidedBy: 'SYSTEM', decidedAt: plus(c1, 5), createdAt: c1 })], now, from, to: now, storeNames: stores });
    expect(r.totals.approvalRate).toBe(0);
    expect(r.totals.conversionRate).toBeNull();
    expect(r.totals.avgDecisionSeconds).toBe(5);
  });
  it('money sums are exact to 2 decimals (no float drift)', () => {
    const mk = (id: string, fin: number) => row(id, { status: 'ACCEPTED', decision: 'APPROVE', acceptedAt: accepted(c1), createdAt: c1, goodsPrice: fin, financedAmount: fin });
    const r = calculateDashboard({ rows: [mk('a', 0.1), mk('b', 0.2), mk('c', 100.1), mk('d', 200.2)], now, from, to: now, storeNames: stores });
    expect(r.totals.financedAmount).toBe(300.6);
    expect(r.totals.goodsSalesAmount).toBe(300.6);
  });
  it('an unknown store id in a row is still reported', () => {
    const r = calculateDashboard({ rows: [row('a', { storeId: 'ghost', createdAt: c1 })], now, from, to: now, storeNames: new Map() });
    expect(r.byStore).toEqual([{ storeId: 'ghost', storeName: '', requests: 1, approved: 0, financedAmount: 0 }]);
  });
  it('rows created just after midnight Ulaanbaatar land on the next date', () => {
    const justBefore = new Date('2026-10-26T15:59:59.999Z'); // 10-26 23:59:59.999 MN
    const justAfter = new Date('2026-10-26T16:00:00.000Z'); // 10-27 00:00 MN
    const r = calculateDashboard({ rows: [row('a', { createdAt: justBefore }), row('b', { createdAt: justAfter })], now, from, to: now, storeNames: stores });
    expect(r.daily.map((d) => [d.date, d.requests])).toEqual([['2026-10-26', 1], ['2026-10-27', 1], ['2026-10-28', 0]]);
  });
});

// n=14: хүлээн зөвшөөрсний дараа цуцлагдсан лизинг мөнгөн нийлбэрт орохгүй (POS-BR-9-ийн хэрэглээтэй нэг дүрэм), харин funnel-ийн тоонд орно.
describe('calculateDashboard: ACCEPTED then CANCELLED', () => {
  const live = row('live', { status: 'ACCEPTED', storeId: 'S1', planCode: 'P1', decision: 'APPROVE', createdAt: c1, decidedAt: plus(c1, 20), decidedBy: 'SYSTEM', acceptedAt: accepted(c1), goodsPrice: 1_500_000, financedAmount: 1_200_000 });
  const cancelledAfterAccept = row('cancelled', {
    status: 'CANCELLED', storeId: 'S2', planCode: 'P2', decision: 'APPROVE', createdAt: c1, decidedAt: plus(c1, 30), decidedBy: 'SYSTEM', acceptedAt: accepted(c1),
    goodsPrice: 3_000_000, financedAmount: 2_400_000, merchantCommissionAmount: 72_000, merchantNetAmount: 2_328_000,
  });
  const delivered = row('delivered', { status: 'DELIVERED', storeId: 'S1', planCode: 'P1', decision: 'APPROVE', createdAt: c3, decidedAt: plus(c3, 40), decidedBy: 'SYSTEM', acceptedAt: accepted(c3), deliveredAt: plus(c3, 600), goodsPrice: 2_000_000, financedAmount: 1_800_000, merchantCommissionAmount: 54_000, merchantNetAmount: 1_746_000 });
  const r = calculateDashboard({ rows: [live, cancelledAfterAccept, delivered], now, from, to: now, storeNames: stores });

  it('money sums count only ACCEPTED/DELIVERED/SETTLED leases', () => {
    expect(r.totals.financedAmount).toBe(3_000_000); // 1.2M + 1.8M, цуцлагдсан 2.4M орохгүй
    expect(r.totals.goodsSalesAmount).toBe(3_500_000); // 1.5M + 2M, цуцлагдсан 3M орохгүй
    expect(r.daily).toEqual([
      { date: '2026-10-26', requests: 2, approved: 2, financedAmount: 1_200_000 },
      { date: '2026-10-27', requests: 1, approved: 1, financedAmount: 1_800_000 },
      { date: '2026-10-28', requests: 0, approved: 0, financedAmount: 0 },
    ]);
    expect(r.byStore).toEqual([
      { storeId: 'S1', storeName: 'Төв дэлгүүр', requests: 2, approved: 2, financedAmount: 3_000_000 },
      { storeId: 'S2', storeName: 'Салбар дэлгүүр', requests: 1, approved: 1, financedAmount: 0 },
    ]);
    expect(r.byPlan).toEqual([
      { planCode: 'P1', requests: 2, approved: 2, financedAmount: 3_000_000 },
      { planCode: 'P2', requests: 1, approved: 1, financedAmount: 0 },
    ]);
  });

  it('funnel counts keep the cancelled-after-accept lease: accepted / conversionRate count "ever accepted", it is also in cancelledOrExpired', () => {
    expect(r.totals).toMatchObject({ requests: 3, approved: 3, accepted: 3, delivered: 1, settled: 0, cancelledOrExpired: 1, conversionRate: 1 });
    expect(r.totals.conversionRate as number).toBeLessThanOrEqual(1);
  });

  it('commission and net amounts stay delivery/settlement based (a cancelled lease never contributes)', () => {
    expect(r.totals).toMatchObject({ commissionAmount: 54_000, awaitingSettlementNet: 1_746_000, settledNet: 0 });
  });

  it('a lease that is stored ACCEPTED/DELIVERED but whose acceptedAt is missing is not counted as financed', () => {
    const weird = calculateDashboard({ rows: [row('w', { status: 'ACCEPTED', createdAt: c1, goodsPrice: 10, financedAmount: 9 })], now, from, to: now, storeNames: stores });
    expect(weird.totals.financedAmount).toBe(0);
  });

  it('rows that share an id are not conflated (financed set is by row, not by id)', () => {
    const a = row('same', { status: 'ACCEPTED', decision: 'APPROVE', acceptedAt: accepted(c1), createdAt: c1, goodsPrice: 100, financedAmount: 100 });
    const b = row('same', { status: 'CANCELLED', decision: 'APPROVE', acceptedAt: accepted(c1), createdAt: c1, goodsPrice: 900, financedAmount: 900 });
    const res = calculateDashboard({ rows: [a, b], now, from, to: now, storeNames: stores });
    expect(res.totals.financedAmount).toBe(100);
    expect(res.byStore.find((x) => x.storeId === 's1')?.financedAmount).toBe(100);
  });
});
