import { Inject, Injectable } from '@nestjs/common';
import type { PlanCreate, PlanUpdate, PlanView } from '@los/contracts';
import { validationFailed } from '../common/zod.pipe';
import type { RequestContext } from '../common/request-context';
import { DomainError } from '../domain/errors';
import type { MerchantRecord, PlanRecord } from '../domain/records';
import { Clock, IdGenerator } from '../ports';
import { MerchantRepository, PlanRepository } from '../persistence/repositories';
import { backOfficeScope, inBranch, requireAdmin, type BackOfficeScope } from './access';
import { toPlanView } from './view.mappers';

const issue = (path: string, message: string) => validationFailed([{ code: 'custom', path: [path], message }]);

/** POS-FR-3 хөтөлбөр (plan) CRUD + POS-BR-11 боломжит хөтөлбөр. */
@Injectable()
export class PlanService {
  constructor(
    @Inject(PlanRepository) private readonly plans: PlanRepository,
    @Inject(MerchantRepository) private readonly merchants: MerchantRepository,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(IdGenerator) private readonly ids: IdGenerator,
  ) {}

  /** POS-BR-11: идэвхтэй, validFrom ≤ now ≤ validTo, merchantId null эсвэл тухайн мерчант. */
  async availablePlansFor(merchant: Pick<MerchantRecord, 'id' | 'orgId'>, now: Date): Promise<PlanRecord[]> {
    const all = await this.plans.listPlansForMerchant(merchant.orgId, merchant.id);
    return all.filter((p) => p.isActive && (p.merchantId === null || p.merchantId === merchant.id)
      && (p.validFrom === null || p.validFrom.getTime() <= now.getTime()) && (p.validTo === null || now.getTime() <= p.validTo.getTime()));
  }

  async create(ctx: RequestContext, input: PlanCreate): Promise<PlanView> {
    requireAdmin(ctx);
    await this.checkMerchant(ctx.orgId, input.merchantId);
    const validFrom = input.validFrom ? new Date(input.validFrom) : null;
    const validTo = input.validTo ? new Date(input.validTo) : null;
    this.checkValidity(validFrom, validTo);
    if (await this.plans.findPlanByCode(ctx.orgId, input.code)) throw new DomainError('DUPLICATE_CODE', `plan code ${input.code} already exists`);
    const now = this.clock.now();
    const rec: PlanRecord = {
      id: this.ids.uuid(), orgId: ctx.orgId, version: 1, merchantId: input.merchantId, code: input.code, name: input.name, productId: input.productId,
      goodsCategories: input.goodsCategories, minAmount: input.minAmount, maxAmount: input.maxAmount, termOptions: [...input.termOptions].sort((a, b) => a - b),
      annualRate: input.annualRate, feeRate: input.feeRate, minDownPaymentRate: input.minDownPaymentRate, commissionRate: input.commissionRate,
      policy: input.policy, validFrom, validTo, isActive: input.isActive,
      createdAt: now, updatedAt: now, createdBy: ctx.userId, updatedBy: ctx.userId,
    };
    return toPlanView(await this.plans.createPlan(rec));
  }

  /** Уншсан мөрийн `version`-ээр CAS хадгална: зэрэгцээ өөрчлөлт давхарлагдвал 409 CONCURRENT_UPDATE (isActive/policy-г буцаахгүй). */
  async update(ctx: RequestContext, id: string, input: PlanUpdate): Promise<PlanView> {
    const scope = requireAdmin(ctx);
    const cur = await this.load(ctx, scope, id);
    if (input.merchantId !== undefined) await this.checkMerchant(ctx.orgId, input.merchantId);
    const next: PlanRecord = { ...cur, updatedAt: this.clock.now(), updatedBy: ctx.userId };
    if (input.name !== undefined) next.name = input.name;
    if (input.merchantId !== undefined) next.merchantId = input.merchantId;
    if (input.productId !== undefined) next.productId = input.productId;
    if (input.goodsCategories !== undefined) next.goodsCategories = input.goodsCategories;
    if (input.minAmount !== undefined) next.minAmount = input.minAmount;
    if (input.maxAmount !== undefined) next.maxAmount = input.maxAmount;
    if (input.termOptions !== undefined) next.termOptions = [...input.termOptions].sort((a, b) => a - b);
    if (input.annualRate !== undefined) next.annualRate = input.annualRate;
    if (input.feeRate !== undefined) next.feeRate = input.feeRate;
    if (input.minDownPaymentRate !== undefined) next.minDownPaymentRate = input.minDownPaymentRate;
    if (input.commissionRate !== undefined) next.commissionRate = input.commissionRate;
    if (input.policy !== undefined) next.policy = input.policy;
    if (input.validFrom !== undefined) next.validFrom = input.validFrom ? new Date(input.validFrom) : null;
    if (input.validTo !== undefined) next.validTo = input.validTo ? new Date(input.validTo) : null;
    if (input.isActive !== undefined) next.isActive = input.isActive;
    if (next.minAmount > next.maxAmount) throw issue('maxAmount', 'minAmount ≤ maxAmount');
    if (new Set(next.termOptions).size !== next.termOptions.length) throw issue('termOptions', 'Хугацаа давхцсан');
    this.checkValidity(next.validFrom, next.validTo);
    return toPlanView(await this.plans.savePlan(next));
  }

  async get(ctx: RequestContext, id: string): Promise<PlanView> {
    return toPlanView(await this.load(ctx, backOfficeScope(ctx), id));
  }

  async list(ctx: RequestContext, filter: { merchantId?: string; isActive?: boolean }): Promise<PlanView[]> {
    const scope = backOfficeScope(ctx);
    if (filter.merchantId) await this.requireVisibleMerchant(ctx.orgId, scope, filter.merchantId);
    const all = await this.plans.listPlans(ctx.orgId, filter);
    if (scope.branchId === null) return all.map(toPlanView);
    // BRANCH_MANAGER: бүх мерчантын хөтөлбөр + өөрийн салбарын мерчантын хөтөлбөр
    const visible: PlanRecord[] = [];
    const branchOf = new Map<string, boolean>();
    for (const p of all) {
      if (p.merchantId === null) { visible.push(p); continue; }
      if (!branchOf.has(p.merchantId)) {
        const m = await this.merchants.findMerchant(ctx.orgId, p.merchantId);
        branchOf.set(p.merchantId, !!m && inBranch(scope, m.branchId));
      }
      if (branchOf.get(p.merchantId)) visible.push(p);
    }
    return visible.map(toPlanView);
  }

  private async load(ctx: RequestContext, scope: BackOfficeScope, id: string): Promise<PlanRecord> {
    const p = await this.plans.findPlan(ctx.orgId, id);
    if (!p) throw new DomainError('NOT_FOUND', 'Plan not found');
    if (p.merchantId !== null && scope.branchId !== null) await this.requireVisibleMerchant(ctx.orgId, scope, p.merchantId);
    return p;
  }

  private async requireVisibleMerchant(orgId: string, scope: BackOfficeScope, merchantId: string): Promise<MerchantRecord> {
    const m = await this.merchants.findMerchant(orgId, merchantId);
    if (!m || !inBranch(scope, m.branchId)) throw new DomainError('NOT_FOUND', 'Merchant not found');
    return m;
  }

  private async checkMerchant(orgId: string, merchantId: string | null): Promise<void> {
    if (merchantId && !(await this.merchants.findMerchant(orgId, merchantId))) throw issue('merchantId', 'Мерчант олдсонгүй');
  }

  private checkValidity(from: Date | null, to: Date | null): void {
    if (from && to && from.getTime() > to.getTime()) throw issue('validTo', 'validFrom ≤ validTo');
  }
}
