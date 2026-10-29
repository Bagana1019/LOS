import { Inject, Injectable } from '@nestjs/common';
import type { MerchantDashboard, MerchantDashboardQuery } from '@los/contracts';
import type { RequestContext } from '../common/request-context';
import { DAY_MS, mnDayRange, mnStartOfDay } from '../common/time';
import { DomainError } from '../domain/errors';
import { Clock } from '../ports';
import { LeaseRepository, MerchantRepository, type LeaseScope } from '../persistence/repositories';
import { merchantScope } from './access';
import { calculateDashboard } from './dashboard.calculator';
import { toLeaseListItem } from './view.mappers';

export const DASHBOARD_DEFAULT_DAYS = 30;
export const DASHBOARD_MAX_DAYS = 92;
const RECENT_COUNT = 8;

@Injectable()
export class DashboardService {
  constructor(
    @Inject(LeaseRepository) private readonly leases: LeaseRepository,
    @Inject(MerchantRepository) private readonly merchants: MerchantRepository,
    @Inject(Clock) private readonly clock: Clock,
  ) {}

  /** GET /merchant-portal/dashboard. Хүрээ анхдагчаар сүүлийн 30 өдөр (Улаанбаатар); дээд 92 хоног. `to` оруулан (inclusive) тооцно. */
  async dashboard(ctx: RequestContext, query: MerchantDashboardQuery): Promise<MerchantDashboard> {
    const scope = merchantScope(ctx);
    const merchant = await this.merchants.findMerchant(ctx.orgId, scope.merchantId);
    if (!merchant) throw new DomainError('NOT_FOUND', 'Merchant not found');
    const now = this.clock.now();

    const to = query.to ? new Date(query.to) : now;
    const from = query.from ? new Date(query.from) : mnStartOfDay(new Date(to.getTime() - (DASHBOARD_DEFAULT_DAYS - 1) * DAY_MS));
    if (from.getTime() > to.getTime()) throw new DomainError('VALIDATION_FAILED', 'from must not be after to', { issues: [{ path: 'from', message: 'from must not be after to' }] });
    if (to.getTime() - from.getTime() > DASHBOARD_MAX_DAYS * DAY_MS) {
      throw new DomainError('VALIDATION_FAILED', `Range must not exceed ${DASHBOARD_MAX_DAYS} days`, { issues: [{ path: 'from', message: `Range must not exceed ${DASHBOARD_MAX_DAYS} days` }] });
    }

    // STAFF → storeId албадан өөрийнх; ADMIN → заавал өөрийн мерчантын дэлгүүр
    const allStores = await this.merchants.listStores(merchant.id);
    const storeId = scope.storeId ?? query.storeId;
    if (storeId && !allStores.some((s) => s.id === storeId)) throw new DomainError('NOT_FOUND', 'Store not found');
    const stores = storeId ? allStores.filter((s) => s.id === storeId) : allStores;
    const leaseScope: LeaseScope = { orgId: ctx.orgId, merchantId: merchant.id, ...(storeId ? { storeId } : {}) };

    const rows = await this.leases.dashboardRows(leaseScope, from, new Date(to.getTime() + 1));
    const [dayFrom, dayTo] = mnDayRange(now);
    const [dailyUsedAmount, recent] = await Promise.all([
      this.leases.sumAcceptedFinanced(merchant.id, dayFrom, dayTo),
      this.leases.listLeases(leaseScope, {}, { page: 1, pageSize: RECENT_COUNT }),
    ]);
    const storeNames = new Map(allStores.map((s) => [s.id, s.name] as const));
    const calc = calculateDashboard({ rows, now, from, to, storeNames: new Map(stores.map((s) => [s.id, s.name] as const)) });
    return {
      range: { from: from.toISOString(), to: to.toISOString() },
      ...calc,
      limits: { maxTicketAmount: merchant.maxTicketAmount, dailyLimitAmount: merchant.dailyLimitAmount, dailyUsedAmount },
      recent: recent.items.map((l) => toLeaseListItem(l, { storeName: storeNames.get(l.storeId) ?? '', now })),
    };
  }
}
