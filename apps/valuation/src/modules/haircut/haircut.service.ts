import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { HaircutRuleInput, HaircutRuleView, RequestContext } from '@los/contracts';
import { DomainError } from '@los/nest-common';
import { advisoryLock } from '../../common/locks';
import { HaircutRepository, type HaircutRow } from './haircut.repository';

const toView = (r: HaircutRow): HaircutRuleView => ({
  id: r.id,
  productId: r.productId,
  assetType: r.assetType as HaircutRuleView['assetType'],
  haircutRate: Number(r.haircutRate),
  isActive: r.isActive,
  updatedAt: r.updatedAt.toISOString(),
});

const RATE_DECIMALS = 1e4; // haircut_rule.haircut_rate is DECIMAL(7,4)
const invalid = (path: string, message: string) => new DomainError('VALIDATION_FAILED', 'Оруулсан өгөгдөл буруу', HttpStatus.BAD_REQUEST, [{ path, message }]);

/** FR-14.2 — haircut rules per (product | all products, asset type). The suggestion resolves them (HaircutLookupService). */
@Injectable()
export class HaircutService {
  private readonly logger = new Logger(HaircutService.name);

  constructor(@Inject(HaircutRepository) private readonly repo: HaircutRepository) {}

  async list(ctx: RequestContext, filter: { productId?: string | null; assetType?: string; includeInactive: boolean }): Promise<HaircutRuleView[]> {
    return (await this.repo.list(ctx.orgId, filter)).map(toView);
  }

  /** Create or update the rule of (org, productId | null, assetType); a deactivated rule becomes active again. */
  async upsert(ctx: RequestContext, input: HaircutRuleInput): Promise<HaircutRuleView> {
    const productId = input.productId === null ? null : input.productId.trim();
    if (productId === '') throw invalid('productId', 'productId хоосон байж болохгүй (бүх бүтээгдэхүүнд бол null)');
    // The column keeps 4 decimals: refuse more instead of silently rounding the rate the admin typed.
    if (Math.abs(input.haircutRate * RATE_DECIMALS - Math.round(input.haircutRate * RATE_DECIMALS)) > 1e-6) throw invalid('haircutRate', 'Haircut-ийн хувь 4 орноос илүү аравтын бутархайгүй байх ёстой');
    const row = await this.repo.transaction(async (tx) => {
      await advisoryLock(tx, 'haircut_rule', ctx.orgId, input.assetType); // also covers NULL product_id, which no unique index can
      const existing = await this.repo.findOne(tx, ctx.orgId, productId, input.assetType);
      return existing
        ? this.repo.update(tx, existing.id, { haircutRate: input.haircutRate, isActive: true, actorId: ctx.userId })
        : this.repo.create(tx, { orgId: ctx.orgId, productId, assetType: input.assetType, haircutRate: input.haircutRate, actorId: ctx.userId });
    });
    this.logger.log(`haircut_rule_upserted assetType=${row.assetType} orgWide=${row.productId === null}`);
    return toView(row);
  }

  /** Soft delete: `is_active = false` (idempotent). The rule stops applying; the resolution falls through to the next level. */
  async deactivate(ctx: RequestContext, id: string): Promise<HaircutRuleView> {
    const row = await this.repo.transaction(async (tx) => {
      const existing = await this.repo.findById(tx, ctx.orgId, id);
      if (!existing) throw new DomainError('HAIRCUT_NOT_FOUND', 'Haircut-ийн дүрэм олдсонгүй', HttpStatus.NOT_FOUND);
      return existing.isActive ? this.repo.update(tx, id, { isActive: false, actorId: ctx.userId }) : existing;
    });
    return toView(row);
  }
}
