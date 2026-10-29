import { GatewayTimeoutException, HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { addDays, agingBucket, parRatio } from '@los/calc';
import { AgingBucket, ApplicationStatus, DashboardSummary, type DashboardQuery } from '@los/contracts';
import { Clock } from '@los/nest-common';
import { Prisma } from '.prisma/client-origination';
import { PrismaService } from '../../prisma.service';
import type { RequestContext } from '@los/contracts';
import { Semaphore, SemaphoreFullError } from './concurrency';
import { queryWithTimeout, isStatementTimeout } from './report-db';
import { addMonths, lastDayOfMonth, lastMonths, monthStart, ubDayStartUtc } from './report-dates';
import { effectiveScope, resolveReportScope } from './report-scope';
import {
  DISBURSED_STATUSES, HAS_OUTSTANDING, OUT_PRINCIPAL, OUT_TOTAL, REPAYING_STATUSES, and, installmentsCte, loanConditions, loansCte, sql, type LoanSelection,
} from './report-sql';
import { round, toNumber, type Raw } from './report-values';
import { todayUB } from '../../shared/clock';

const n = (v: unknown): number => toNumber(v) ?? 0;

/** Цуглуулалтад энэ сард төлөх ёстой мөртэй, гэхдээ бүрэн төлөгдөж хаагдсан (CLOSED) зээл ч орно — эс бөгөөс хамгийн сайн төлөгчид хасагдаж хувь доогуур гарна. */
const COLLECTION_STATUSES = [...REPAYING_STATUSES, 'CLOSED'] as const;

/** Нэг dashboard тооцооллын дотор зэрэг ажиллах query (6 query нэг дор 6 холболт эзэлж, нийтлэг Prisma pool-ыг дүүргэж байсан). */
export const DASHBOARD_QUERY_CONCURRENCY = 2;
/** Процесс даяар зэрэг тооцоологдох dashboard (өөр түлхүүртэй) ба хүлээх дараалал → pool-д хамгийн ихдээ 2×2 = 4 холболт. Дараалал дүүрвэл 429. */
export const DASHBOARD_CONCURRENCY = 2;
export const DASHBOARD_MAX_QUEUE = 50;

/** Dashboard-ын үр дүнг (org+хүрээ+валют+asOf) түлхүүрээр хадгалах хугацаа (мс). 0 → кэшгүй (single-flight л ажиллана). */
export const DASHBOARD_CACHE_TTL_MS = Symbol('DASHBOARD_CACHE_TTL_MS');
export const DEFAULT_DASHBOARD_CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 500;

/** REPORT_DASHBOARD_CACHE_SECONDS (0 = кэшгүй); буруу/сөрөг бол анхдагч 30с. */
export function dashboardCacheTtlFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.REPORT_DASHBOARD_CACHE_SECONDS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_DASHBOARD_CACHE_TTL_MS;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : DEFAULT_DASHBOARD_CACHE_TTL_MS;
}

/**
 * KPI dashboard (FR-13.3-ын нэгтгэл). Тайлантай адил хүрээ (NFR-3), ижил SQL хэсгүүд (одоогийн ЭТХ, allocation-ын Σ).
 * "Энэ сар" = asOf-ийг агуулсан UB сар, asOf өдрийн төгсгөл хүртэл. Валют холихгүй: бүх дүн `currency`-ээр.
 *
 * Ачаалал (нийтлэг Prisma pool 4 цөмд 9 холболт): (1) ижил түлхүүрийн зэрэгцээ хүсэлт нэг тооцоололд нэгдэнэ (single-flight),
 * (2) үр дүн DASHBOARD_CACHE_TTL_MS хадгалагдана, (3) нэг тооцоолол хамгийн ихдээ DASHBOARD_QUERY_CONCURRENCY query зэрэг ажиллана,
 * (4) өөр түлхүүртэй тооцоолол процесс даяар DASHBOARD_CONCURRENCY-ээс илүү зэрэг ажиллахгүй, (5) query бүр statement_timeout-той.
 * Хүрээ (branch/officer) нь түлхүүрт орсон тул кэш нь эрхийн хүрээг давахгүй; эрхийн шалгалт кэшээс ӨМНӨ хийгдэнэ.
 */
@Injectable()
export class DashboardService {
  private readonly slots = new Semaphore(DASHBOARD_CONCURRENCY, DASHBOARD_MAX_QUEUE);
  private readonly cache = new Map<string, { value: DashboardSummary; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<DashboardSummary>>();

  constructor(private readonly prisma: PrismaService, private readonly clock: Clock, @Inject(DASHBOARD_CACHE_TTL_MS) private readonly cacheTtlMs: number) {}

  async summary(ctx: RequestContext, query: DashboardQuery): Promise<DashboardSummary> {
    const scope = resolveReportScope(ctx);
    const eff = effectiveScope(scope, { branchId: query.branchId });
    const asOf = query.asOf ?? todayUB(this.clock);
    const currency = query.currency.toUpperCase();
    const key = JSON.stringify([scope.orgId, eff.branchId, eff.officerId, currency, asOf]);

    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.slots.run(() => this.compute({ orgId: scope.orgId, branchId: eff.branchId, officerId: eff.officerId }, currency, asOf))
        .then((value) => { this.remember(key, value); return value; })
        .finally(() => { this.inflight.delete(key); });
      this.inflight.set(key, pending);
    }
    try {
      return await pending;
    } catch (e) {
      if (e instanceof SemaphoreFullError) throw new HttpException({ code: 'REPORT_BUSY', message: 'Dashboard одоогоор хэт ачаалалтай байна. Түр хүлээгээд дахин оролдоно уу' }, HttpStatus.TOO_MANY_REQUESTS);
      if (isStatementTimeout(e)) throw new GatewayTimeoutException({ code: 'REPORT_TIMEOUT', message: 'Dashboard бэлтгэхэд хэт удаан байна. Түр хүлээгээд дахин оролдоно уу' });
      throw e;
    }
  }

  private remember(key: string, value: DashboardSummary): void {
    if (this.cacheTtlMs <= 0) return;
    const now = Date.now();
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      for (const [k, v] of this.cache) if (v.expiresAt <= now) this.cache.delete(k);
      while (this.cache.size >= CACHE_MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value as string); // хамгийн эртний
    }
    this.cache.set(key, { value, expiresAt: now + this.cacheTtlMs });
  }

  private async compute(eff: { orgId: string; branchId: string | null; officerId: string | null }, currency: string, asOf: string): Promise<DashboardSummary> {
    const sel = (statuses: readonly string[] | null): LoanSelection => ({ orgId: eff.orgId, branchId: eff.branchId, officerId: eff.officerId, productId: null, currency, statuses, search: null });

    // Хамгийн хүнд (ЭТХ-ийн) query-үүд эхэнд: хоёр слот эхлээд тэдгээрт, дараа нь хөнгөнүүдэд.
    const gate = new Semaphore(DASHBOARD_QUERY_CONCURRENCY);
    const [portfolio, collections, monthly, byStatus, flow, top] = await Promise.all([
      gate.run(() => this.portfolio(sel(REPAYING_STATUSES), asOf)),
      gate.run(() => this.collections(sel(COLLECTION_STATUSES), asOf)),
      gate.run(() => this.disbursementsByMonth(sel(null), asOf)),
      gate.run(() => this.byStatus(sel(null))),
      gate.run(() => this.flow(sel(null), asOf)),
      gate.run(() => this.topProducts(sel(null))),
    ]);

    const months = lastMonths(asOf, 12);
    const monthlyRows = months.map((m) => ({ month: m, amount: round(monthly.get(m)?.amount ?? 0, 2), count: monthly.get(m)?.count ?? 0 }));
    const thisMonth = monthlyRows[monthlyRows.length - 1];
    const lastMonth = monthlyRows[monthlyRows.length - 2];
    const ytdPrefix = `${asOf.slice(0, 4)}-`;
    const decided = flow.approved + flow.returned;

    return DashboardSummary.parse({
      asOf, currency, scope: { branchId: eff.branchId, officerId: eff.officerId },
      applications: {
        byStatus: ApplicationStatus.map((status) => ({ status, count: byStatus.get(status)?.count ?? 0, amount: round(byStatus.get(status)?.amount ?? 0, 2) })),
        submittedThisMonth: flow.submitted, approvedThisMonth: flow.approved, returnedThisMonth: flow.returned,
        approvalRate: decided > 0 ? round(flow.approved / decided, 6) : null,
        avgDecisionHours: flow.avgDecisionHours,
      },
      disbursements: {
        thisMonthAmount: thisMonth.amount, lastMonthAmount: lastMonth.amount, thisMonthCount: thisMonth.count,
        yearToDateAmount: round(monthlyRows.filter((r) => r.month.startsWith(ytdPrefix)).reduce((s, r) => s + r.amount, 0), 2),
        monthly: monthlyRows,
      },
      portfolio, collections, topProducts: top,
      generatedAt: this.clock.now().toISOString(),
    });
  }

  private async byStatus(sel: LoanSelection): Promise<Map<string, { count: number; amount: number }>> {
    const rows = await queryWithTimeout<Raw[]>(this.prisma, sql`
      SELECT la.status AS status, COUNT(*)::int AS count, COALESCE(SUM(la.amount), 0) AS amount
      FROM origination.loan_application la WHERE ${and(loanConditions(sel))} GROUP BY la.status`);
    return new Map(rows.map((r) => [String(r.status), { count: n(r.count), amount: n(r.amount) }]));
  }

  /** Энэ сарын илгээсэн/батлагдсан/буцаасан, шийдвэрийн дундаж цаг (сүүлийн 90 хоногт шийдвэрлэгдсэн). */
  private async flow(sel: LoanSelection, asOf: string) {
    const from = ubDayStartUtc(monthStart(asOf));
    const to = ubDayStartUtc(addDays(asOf, 1));
    const since = ubDayStartUtc(addDays(asOf, -90));
    const decision = Prisma.raw('GREATEST(la.approved_at, la.returned_at)');
    const [r] = await queryWithTimeout<Raw[]>(this.prisma, sql`
      SELECT
        COUNT(*) FILTER (WHERE la.submitted_at >= ${from}::timestamp AND la.submitted_at < ${to}::timestamp)::int AS submitted,
        COUNT(*) FILTER (WHERE la.approved_at >= ${from}::timestamp AND la.approved_at < ${to}::timestamp)::int AS approved,
        COUNT(*) FILTER (WHERE la.returned_at >= ${from}::timestamp AND la.returned_at < ${to}::timestamp)::int AS returned,
        AVG(EXTRACT(EPOCH FROM (${decision} - la.submitted_at)) / 3600.0)
          FILTER (WHERE la.submitted_at IS NOT NULL AND ${decision} >= la.submitted_at AND ${decision} >= ${since}::timestamp AND ${decision} < ${to}::timestamp) AS avg_hours
      FROM origination.loan_application la WHERE ${and(loanConditions(sel))}`);
    return { submitted: n(r?.submitted), approved: n(r?.approved), returned: n(r?.returned), avgDecisionHours: r?.avg_hours == null ? null : round(n(r.avg_hours), 2) };
  }

  /** Сүүлийн 12 сарын олголт (APPROVED | SENT_TO_CORE, disburse_date ≤ asOf). */
  private async disbursementsByMonth(sel: LoanSelection, asOf: string): Promise<Map<string, { amount: number; count: number }>> {
    const first = `${addMonths(asOf.slice(0, 7), -11)}-01`;
    const rows = await queryWithTimeout<Raw[]>(this.prisma, sql`
      SELECT to_char(d.disburse_date, 'YYYY-MM') AS month, COALESCE(SUM(d.disburse_amount), 0) AS amount, COUNT(*)::int AS count
      FROM origination.disbursement_request d JOIN origination.loan_application la ON la.id = d.application_id
      WHERE ${and(loanConditions(sel))} AND d.status IN (${Prisma.join([...DISBURSED_STATUSES])})
        AND d.disburse_date >= ${first}::date AND d.disburse_date <= ${asOf}::date
      GROUP BY 1`);
    return new Map(rows.map((r) => [String(r.month), { amount: n(r.amount), count: n(r.count) }]));
  }

  /** ACTIVE/MIGRATED багц: DPD-ээр бүлэглээд ангиллыг packages/calc `agingBucket`-аар (нэг эх сурвалж) тодорхойлно. */
  private async portfolio(sel: LoanSelection, asOf: string): Promise<DashboardSummary['portfolio']> {
    const rows = await queryWithTimeout<Raw[]>(this.prisma, sql`
      WITH ${loansCte(sel)}, ${installmentsCte({ asOf })},
      agg AS (
        SELECT i.application_id, SUM(${OUT_PRINCIPAL}) AS out_principal,
          MIN(i.due_date) FILTER (WHERE i.due_date < ${asOf}::date AND ${HAS_OUTSTANDING}) AS oldest_due,
          COALESCE(SUM(${OUT_TOTAL}) FILTER (WHERE i.due_date < ${asOf}::date), 0) AS od_amount
        FROM inst i GROUP BY i.application_id
      )
      SELECT COALESCE(${asOf}::date - agg.oldest_due, 0)::int AS dpd, COUNT(*)::int AS loans,
        COALESCE(SUM(COALESCE(agg.out_principal, l.amount, 0)), 0) AS principal, COALESCE(SUM(agg.od_amount), 0) AS od_amount
      FROM loans l LEFT JOIN agg ON agg.application_id = l.id GROUP BY 1`);

    const buckets = new Map<AgingBucket, { loanCount: number; principal: number }>(AgingBucket.map((b) => [b, { loanCount: 0, principal: 0 }]));
    let loans = 0; let principal = 0; let overdueAmount = 0; let overdueLoans = 0; let overduePrincipal = 0;
    for (const r of rows) {
      const dpd = n(r.dpd);
      const b = buckets.get(agingBucket(dpd)) as { loanCount: number; principal: number };
      b.loanCount += n(r.loans); b.principal += n(r.principal);
      loans += n(r.loans); principal += n(r.principal); overdueAmount += n(r.od_amount);
      if (dpd > 0) { overdueLoans += n(r.loans); overduePrincipal += n(r.principal); }
    }
    return {
      activeLoanCount: loans, outstandingPrincipal: round(principal, 2), overdueAmount: round(overdueAmount, 2), overdueLoanCount: overdueLoans,
      parRatio: parRatio(round(overduePrincipal, 2), round(principal, 2)),
      aging: AgingBucket.map((bucket) => ({ bucket, loanCount: buckets.get(bucket)?.loanCount ?? 0, principal: round(buckets.get(bucket)?.principal ?? 0, 2) })),
    };
  }

  /**
   * Энэ сард төлөх ёстой (ЭТХ-ийн нийт) / цуглуулсан (тэр мөрүүдэд хуваарилагдсан төлөлт) / дараагийн 7 хоногийн үлдэгдэл (asOf..asOf+7).
   * Төлөх ёстой/цуглуулсан нь энэ сард бүрэн төлөгдөж CLOSED болсон зээлийг ч хамарна (тэд хамгийн сайн төлөгчид — хасвал хувь хазайна);
   * харин "дараагийн 7 хоног" нь зөвхөн одоо эргэн төлөгдөж буй (ACTIVE/MIGRATED) зээлийн үлдэгдэл (Эргэн төлөлт хийгдэх тайлантай нэг эх сурвалж).
   */
  private async collections(sel: LoanSelection, asOf: string): Promise<DashboardSummary['collections']> {
    const ms = monthStart(asOf);
    const me = lastDayOfMonth(asOf);
    const in7 = addDays(asOf, 7);
    const [r] = await queryWithTimeout<Raw[]>(this.prisma, sql`
      WITH ${loansCte(sel)}, ${installmentsCte({ asOf, dueFrom: ms, dueTo: me > in7 ? me : in7 })}
      SELECT
        COALESCE(SUM(i.interest + i.principal) FILTER (WHERE i.due_date >= ${ms}::date AND i.due_date <= ${me}::date), 0) AS due_month,
        COALESCE(SUM(LEAST(i.paid_interest, i.interest) + LEAST(i.paid_principal, i.principal)) FILTER (WHERE i.due_date >= ${ms}::date AND i.due_date <= ${me}::date), 0) AS collected,
        COALESCE(SUM(${OUT_TOTAL}) FILTER (WHERE i.due_date >= ${asOf}::date AND i.due_date <= ${in7}::date AND l.status IN (${Prisma.join([...REPAYING_STATUSES])})), 0) AS next7
      FROM inst i JOIN loans l ON l.id = i.application_id`);
    const due = round(n(r?.due_month), 2);
    const collected = round(n(r?.collected), 2);
    return { dueThisMonth: due, collectedThisMonth: collected, collectionRate: due > 0 ? round(collected / due, 6) : null, dueNext7Days: round(n(r?.next7), 2) };
  }

  /** Топ 5 бүтээгдэхүүн: DRAFT-аас бусад хүсэлтийн дүнгээр (дараа нь тоо, нэр). */
  private async topProducts(sel: LoanSelection): Promise<DashboardSummary['topProducts']> {
    const rows = await queryWithTimeout<Raw[]>(this.prisma, sql`
      SELECT la.product_id AS "productId", COALESCE(pr.name, 'Тодорхойгүй') AS name, COUNT(*)::int AS count, COALESCE(SUM(la.amount), 0) AS amount
      FROM origination.loan_application la LEFT JOIN origination.product pr ON pr.id = la.product_id
      WHERE ${and(loanConditions(sel))} AND la.status <> 'DRAFT'
      GROUP BY la.product_id, pr.name ORDER BY amount DESC, count DESC, name ASC LIMIT 5`);
    return rows.map((r) => ({ productId: r.productId == null ? null : String(r.productId), productName: String(r.name), count: n(r.count), amount: round(n(r.amount), 2) }));
  }
}
