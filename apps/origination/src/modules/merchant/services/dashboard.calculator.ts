import type { MerchantDashboard, PosLeaseStatus } from '@los/contracts';
import { fromCents, toCents } from '../common/money';
import { mnDateKey, mnDaysBetween } from '../common/time';
import { effectiveStatus } from '../domain/lease-state';
import type { LeaseDashboardRow } from '../domain/records';

export interface DashboardCalcInput {
  rows: readonly LeaseDashboardRow[];
  now: Date;
  /** daily цуваа үүсгэх Улаанбаатарын огнооны хүрээ (хоёр захыг оруулна) */
  from: Date;
  to: Date;
  /** хүрээн дэх дэлгүүрүүд (id → нэр); мөр байхгүй дэлгүүр 0-оор гарна */
  storeNames: ReadonlyMap<string, string>;
}
export type DashboardCalcResult = Pick<MerchantDashboard, 'totals' | 'daily' | 'byStore' | 'byPlan' | 'todo'>;

const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;
const sumBy = <T>(items: readonly T[], f: (t: T) => number) => fromCents(items.reduce((s, t) => s + toCents(f(t)), 0));

/** Санхүүжилт "хүчинтэй" төлөвүүд — POS-BR-9 өдрийн лимитийн ашиглалттай (`sumAcceptedFinanced`) нэг багц. */
const LIVE_FINANCED_STATUSES: readonly PosLeaseStatus[] = ['ACCEPTED', 'DELIVERED', 'SETTLED'];

/**
 * POS-FR-7 Merchant Dashboard-ын цэвэр тооцоо (docs/05 + даалгаврын DASHBOARD SPEC).
 * Бүх төлөвийг `effectiveStatus`-аар (lazy expiry) үнэлнэ. Мөнгөн нийлбэр 2 оронтой.
 *
 * Хоёр өөр утга (зориуд):
 *  - ТОО (`accepted`, `delivered`, `settled`, `approved`, `conversionRate`) = урсгалын (funnel) тоо: "тухайн шатанд хүрсэн" (acceptedAt != null / decision = APPROVE).
 *    Хүлээн зөвшөөрсний дараа цуцалсан лизинг ч хөрвөлтөд тоологдоно — худалдан авагч санал авсан нь үнэн; `approved` нь мөн дараа нь цуцлагдсаныг тоолдог тул
 *    `conversionRate = accepted / approved` ижил суурьтай (≤ 1). Ийм лизинг `cancelledOrExpired`-д мөн орно (давхар тооллого зориуд).
 *  - МӨНГӨН ДҮН (`financedAmount`, `goodsSalesAmount`, daily/byStore/byPlan-ийн `financedAmount`) = ОДООГИЙН байдал: effective төлөв ACCEPTED/DELIVERED/SETTLED үед л.
 *    Хүлээн зөвшөөрсний дараа CANCELLED болсон лизинг санхүүждэггүй, бараа хүлээлгэн өгөөгүй тул борлуулалт биш (өдрийн лимитийн ашиглалттай нийцнэ).
 */
export function calculateDashboard({ rows, now, from, to, storeNames }: DashboardCalcInput): DashboardCalcResult {
  const withStatus = rows.map((r) => ({ r, status: effectiveStatus(r, now) }));
  const approved = rows.filter((r) => r.decision === 'APPROVE');
  const declined = rows.filter((r) => r.decision === 'DECLINE');
  const decided = rows.filter((r) => r.decision !== null);
  const accepted = rows.filter((r) => r.acceptedAt !== null); // funnel: хэзээ нэгэн цагт хүлээн зөвшөөрсөн
  const financedRows = withStatus.filter((x) => x.r.acceptedAt !== null && LIVE_FINANCED_STATUSES.includes(x.status)).map((x) => x.r); // мөнгөн дүн: одоо хүчинтэй
  const isFinanced = new Set<LeaseDashboardRow>(financedRows); // мөрийн объектоор (id давхцсан ч алдаагүй)
  const delivered = rows.filter((r) => r.deliveredAt !== null);
  const settled = rows.filter((r) => r.settledAt !== null);
  const systemDecided = rows.filter((r) => r.decidedBy === 'SYSTEM' && r.decidedAt !== null);
  const countStatus = (...s: string[]) => withStatus.filter((x) => s.includes(x.status)).length;

  const totals: MerchantDashboard['totals'] = {
    requests: rows.length,
    approved: approved.length,
    referred: countStatus('REFERRED'),
    declined: declined.length,
    accepted: accepted.length,
    delivered: delivered.length,
    settled: settled.length,
    cancelledOrExpired: countStatus('CANCELLED', 'EXPIRED'),
    approvalRate: decided.length ? round(approved.length / decided.length, 4) : null,
    conversionRate: approved.length ? round(accepted.length / approved.length, 4) : null,
    avgDecisionSeconds: systemDecided.length ? round(systemDecided.reduce((s, r) => s + (r.decidedAt!.getTime() - r.createdAt.getTime()) / 1000, 0) / systemDecided.length, 2) : null,
    financedAmount: sumBy(financedRows, (r) => r.financedAmount),
    goodsSalesAmount: sumBy(financedRows, (r) => r.goodsPrice),
    commissionAmount: sumBy(delivered, (r) => r.merchantCommissionAmount),
    awaitingSettlementNet: sumBy(delivered.filter((r) => r.settledAt === null), (r) => r.merchantNetAmount),
    settledNet: sumBy(settled, (r) => r.merchantNetAmount),
  };

  const daily = mnDaysBetween(from, to).map((date) => {
    const day = rows.filter((r) => mnDateKey(r.createdAt) === date);
    return { date, requests: day.length, approved: day.filter((r) => r.decision === 'APPROVE').length, financedAmount: sumBy(day.filter((r) => isFinanced.has(r)), (r) => r.financedAmount) };
  });

  const group = (r: LeaseDashboardRow[]) => ({ requests: r.length, approved: r.filter((x) => x.decision === 'APPROVE').length, financedAmount: sumBy(r.filter((x) => isFinanced.has(x)), (x) => x.financedAmount) });
  const storeIds = new Set([...storeNames.keys(), ...rows.map((r) => r.storeId)]);
  const byStore = [...storeIds].map((storeId) => ({ storeId, storeName: storeNames.get(storeId) ?? '', ...group(rows.filter((r) => r.storeId === storeId)) }))
    .sort((a, b) => b.requests - a.requests || a.storeName.localeCompare(b.storeName));
  const byPlan = [...new Set(rows.map((r) => r.planCode))].map((planCode) => ({ planCode, ...group(rows.filter((r) => r.planCode === planCode)) }))
    .sort((a, b) => b.requests - a.requests || a.planCode.localeCompare(b.planCode));

  const todo: MerchantDashboard['todo'] = {
    awaitingOtp: countStatus('DRAFT'), awaitingAcceptance: countStatus('APPROVED'), awaitingDelivery: countStatus('ACCEPTED'), referred: countStatus('REFERRED'),
  };
  return { totals, daily, byStore, byPlan, todo };
}
