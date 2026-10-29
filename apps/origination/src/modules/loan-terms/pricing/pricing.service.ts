import { HttpStatus, Injectable } from '@nestjs/common';
import { quoteRiskPricing, RiskPricingError, validateTierSet } from '@los/calc';
import type { PricingQuoteRequest, PricingQuoteResponse, PricingTierSet, RequestContext, SavePricingTiersRequest } from '@los/contracts';
import { buildEvent, enqueueOutbox, recordAudit } from '@los/database';
import { DomainError } from '@los/nest-common';
import { PrismaService } from '../../../prisma.service';
import { activeRows, replaceActiveSet, toTierSet } from './pricing-tier.store';

/** SettingsChanged event-ийн `key` — бусад сервис шатлалын projection-оо шинэчлэх (CLAUDE.md §3.2.8). */
export const PRICING_SETTING_KEY = 'pricing.tiers';

// FR-5.5: Sosco Score-оос хамаарсан хүү, шимтгэлийг систем САНАЛ БОЛГОНО. Эцсийн нөхцөл FR-5.1-ийн дагуу бүтээгдэхүүний хязгаарт байна (BR-6).
@Injectable()
export class PricingService {
  constructor(private readonly db: PrismaService) {}

  /** Бүтээгдэхүүний өөрийн шатлал байвал түүнийг, үгүй бол байгууллагын нийтлэгийг. */
  private async effectiveSet(orgId: string, productId: string | null): Promise<PricingTierSet | null> {
    for (const scope of productId ? [productId, null] : [null]) {
      const rows = await activeRows(this.db, orgId, scope);
      if (rows.length) return toTierSet(rows, scope);
    }
    return null;
  }

  private async requireProductBounds(orgId: string, productId: string) {
    const p = await this.db.product.findFirst({ where: { id: productId, orgId, isActive: true }, select: { minRate: true, maxRate: true } });
    if (!p) throw new DomainError('PRODUCT_NOT_FOUND', `Бүтээгдэхүүн олдсонгүй: ${productId}`, HttpStatus.NOT_FOUND);
    return { minRate: p.minRate.toNumber(), maxRate: p.maxRate.toNumber() };
  }

  async getTierSet(ctx: RequestContext, productId: string | null): Promise<PricingTierSet> {
    if (productId) await this.requireProductBounds(ctx.orgId, productId);
    const set = await this.effectiveSet(ctx.orgId, productId);
    if (!set) throw notConfigured();
    return set;
  }

  /** Шалгалт → шинэ version + audit + SettingsChanged outbox нэг транзакцид. */
  async saveTierSet(ctx: RequestContext, req: SavePricingTiersRequest): Promise<PricingTierSet> {
    if (req.productId) await this.requireProductBounds(ctx.orgId, req.productId);
    const issues = validateTierSet(req.tiers);
    if (issues.length) throw new DomainError('INVALID_TIER_SET', 'Шатлал буруу байна', HttpStatus.UNPROCESSABLE_ENTITY, issues);
    return this.db.$transaction(async (tx) => {
      const { previous, saved } = (await replaceActiveSet(tx, { orgId: ctx.orgId, productId: req.productId, tiers: req.tiers, actorId: ctx.userId }))!;
      await recordAudit(tx, {
        orgId: ctx.orgId, entity: 'PRICING_TIERS', entityId: req.productId ?? 'DEFAULT', action: 'PRICING_TIERS_REPLACED', actorId: ctx.userId,
        beforeJson: previous && { version: previous.version, tiers: previous.tiers }, afterJson: { version: saved.version, tiers: saved.tiers }, correlationId: ctx.correlationId,
      });
      await enqueueOutbox(tx, buildEvent(ctx, 'SettingsChanged', { key: PRICING_SETTING_KEY, productId: req.productId }));
      return saved;
    });
  }

  async quote(ctx: RequestContext, req: PricingQuoteRequest): Promise<PricingQuoteResponse> {
    const bounds = await this.requireProductBounds(ctx.orgId, req.productId);
    const set = await this.effectiveSet(ctx.orgId, req.productId);
    if (!set) throw notConfigured();
    try {
      const quote = quoteRiskPricing({ soscoScore: req.soscoScore, tiers: set.tiers, bounds, amount: req.amount });
      return { ...quote, productRateBounds: bounds, config: { scope: set.scope, productId: set.productId, version: set.version } };
    } catch (e) {
      if (e instanceof RiskPricingError) throw new DomainError(e.code, e.message, HttpStatus.UNPROCESSABLE_ENTITY);
      throw e;
    }
  }
}

const notConfigured = () => new DomainError('PRICING_NOT_CONFIGURED', 'Эрсдэлд суурилсан үнийн шатлал тохируулагдаагүй байна', HttpStatus.NOT_FOUND);
