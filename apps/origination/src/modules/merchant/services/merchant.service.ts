import { Inject, Injectable } from '@nestjs/common';
import type {
  MerchantCreate, MerchantListQuery, MerchantProfile, MerchantStatusChange, MerchantUpdate, MerchantView, StoreCreate, StoreUpdate, StoreView,
} from '@los/contracts';
import { last4 } from '../common/masking';
import type { Paged } from '../common/paged';
import type { RequestContext } from '../common/request-context';
import { DomainError } from '../domain/errors';
import { merchantStatusChanged } from '../domain/events';
import { assertMerchantTransition } from '../domain/merchant-state';
import type { MerchantRecord, StoreRecord } from '../domain/records';
import { Clock, IdGenerator, PiiCipher } from '../ports';
import { MerchantRepository } from '../persistence/repositories';
import { backOfficeScope, inBranch, merchantScope, requireAdmin, type BackOfficeScope } from './access';
import { PlanService } from './plan.service';
import { toMerchantView, toPlanView, toStoreView } from './view.mappers';

/** POS-FR-1/-2: мерчант, дэлгүүр удирдлага + мерчант порталын профайл. */
@Injectable()
export class MerchantService {
  constructor(
    @Inject(MerchantRepository) private readonly merchants: MerchantRepository,
    @Inject(PlanService) private readonly plans: PlanService,
    @Inject(PiiCipher) private readonly cipher: PiiCipher,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(IdGenerator) private readonly ids: IdGenerator,
  ) {}

  // ───── мерчант ─────
  async create(ctx: RequestContext, input: MerchantCreate): Promise<MerchantView> {
    requireAdmin(ctx);
    const now = this.clock.now();
    const rec: MerchantRecord = {
      id: this.ids.uuid(), orgId: ctx.orgId, version: 1, code: input.code, name: input.name, legalName: input.legalName ?? null, companyRegisterNo: input.companyRegisterNo ?? null,
      category: input.category ?? null, contactName: input.contactName, phone: input.phone, email: input.email ?? null, branchId: input.branchId,
      status: 'PENDING', statusReason: null, commissionRate: input.commissionRate, maxTicketAmount: input.maxTicketAmount, dailyLimitAmount: input.dailyLimitAmount,
      settlementBankCode: input.settlement.bankCode, settlementAccountEncrypted: this.cipher.encrypt(input.settlement.accountNo),
      settlementAccountLast4: last4(input.settlement.accountNo), settlementHolderName: input.settlement.holderName,
      contractNo: input.contractNo ?? null, contractSignedAt: input.contractSignedAt ? new Date(input.contractSignedAt) : null,
      createdAt: now, updatedAt: now, createdBy: ctx.userId, updatedBy: ctx.userId,
    };
    return toMerchantView(await this.merchants.createMerchant(rec, [])); // POS-FR-10: үүсгэхэд event байхгүй
  }

  /** Уншсан мөрийн `version`-ээр CAS хадгална: зэрэгцээ өөрчлөлт (статус, данс) давхарлагдвал 409 CONCURRENT_UPDATE (POS-BR-10), дахин оролдоно. */
  async update(ctx: RequestContext, id: string, input: MerchantUpdate): Promise<MerchantView> {
    const scope = requireAdmin(ctx);
    const cur = await this.loadVisible(ctx, scope, id);
    const next: MerchantRecord = { ...cur, updatedAt: this.clock.now(), updatedBy: ctx.userId };
    if (input.name !== undefined) next.name = input.name;
    if (input.legalName !== undefined) next.legalName = input.legalName;
    if (input.companyRegisterNo !== undefined) next.companyRegisterNo = input.companyRegisterNo;
    if (input.category !== undefined) next.category = input.category;
    if (input.contactName !== undefined) next.contactName = input.contactName;
    if (input.phone !== undefined) next.phone = input.phone;
    if (input.email !== undefined) next.email = input.email;
    if (input.branchId !== undefined) next.branchId = input.branchId;
    if (input.commissionRate !== undefined) next.commissionRate = input.commissionRate;
    if (input.maxTicketAmount !== undefined) next.maxTicketAmount = input.maxTicketAmount;
    if (input.dailyLimitAmount !== undefined) next.dailyLimitAmount = input.dailyLimitAmount;
    if (input.contractNo !== undefined) next.contractNo = input.contractNo;
    if (input.contractSignedAt !== undefined) next.contractSignedAt = new Date(input.contractSignedAt);
    if (input.settlement !== undefined) {
      next.settlementBankCode = input.settlement.bankCode;
      next.settlementAccountEncrypted = this.cipher.encrypt(input.settlement.accountNo);
      next.settlementAccountLast4 = last4(input.settlement.accountNo);
      next.settlementHolderName = input.settlement.holderName;
    }
    return toMerchantView(await this.merchants.saveMerchant(next, []));
  }

  /**
   * PENDING→ACTIVE|TERMINATED, ACTIVE→SUSPENDED|TERMINATED, SUSPENDED→ACTIVE|TERMINATED. Шалтгаан хадгалагдаж, event нэг дуудлагад.
   * Шилжилтийн шалгалт ба хадгалалт нэг `version`-д баригдана: хоцорсон хуулбараар TERMINATED-ийг SUSPENDED болгож, event-ээс зөрж болохгүй (POS-BR-10).
   */
  async changeStatus(ctx: RequestContext, id: string, input: MerchantStatusChange): Promise<MerchantView> {
    const scope = requireAdmin(ctx);
    const cur = await this.loadVisible(ctx, scope, id);
    assertMerchantTransition(cur.status, input.status);
    const now = this.clock.now();
    const event = merchantStatusChanged({ ids: this.ids, clock: this.clock }, { orgId: ctx.orgId, actorId: ctx.userId, correlationId: ctx.correlationId },
      { merchantId: cur.id, from: cur.status, to: input.status, reason: input.reason });
    const saved = await this.merchants.saveMerchant({ ...cur, status: input.status, statusReason: input.reason, updatedAt: now, updatedBy: ctx.userId }, [event]);
    return toMerchantView(saved);
  }

  async get(ctx: RequestContext, id: string): Promise<MerchantView> {
    return toMerchantView(await this.loadVisible(ctx, backOfficeScope(ctx), id));
  }

  async list(ctx: RequestContext, query: MerchantListQuery): Promise<Paged<MerchantView>> {
    const scope = backOfficeScope(ctx);
    const { items, total } = await this.merchants.listMerchants(ctx.orgId, { status: query.status, q: query.q?.trim() || undefined, ...(scope.branchId ? { branchId: scope.branchId } : {}) }, { page: query.page, pageSize: query.pageSize });
    return { items: items.map(toMerchantView), total, page: query.page, pageSize: query.pageSize };
  }

  // ───── дэлгүүр ─────
  async createStore(ctx: RequestContext, merchantId: string, input: StoreCreate): Promise<StoreView> {
    const scope = requireAdmin(ctx);
    const merchant = await this.loadVisible(ctx, scope, merchantId);
    const now = this.clock.now();
    const rec: StoreRecord = {
      id: this.ids.uuid(), orgId: ctx.orgId, version: 1, merchantId: merchant.id, code: input.code, name: input.name, address: input.address, phone: input.phone ?? null, isActive: input.isActive,
      createdAt: now, updatedAt: now, createdBy: ctx.userId, updatedBy: ctx.userId,
    };
    return toStoreView(await this.merchants.createStore(rec));
  }

  async updateStore(ctx: RequestContext, merchantId: string, storeId: string, input: StoreUpdate): Promise<StoreView> {
    const scope = requireAdmin(ctx);
    const merchant = await this.loadVisible(ctx, scope, merchantId);
    const cur = await this.merchants.findStore(merchant.id, storeId);
    if (!cur) throw new DomainError('NOT_FOUND', 'Store not found');
    const next: StoreRecord = { ...cur, updatedAt: this.clock.now(), updatedBy: ctx.userId };
    if (input.name !== undefined) next.name = input.name;
    if (input.address !== undefined) next.address = input.address;
    if (input.phone !== undefined) next.phone = input.phone;
    if (input.isActive !== undefined) next.isActive = input.isActive;
    return toStoreView(await this.merchants.saveStore(next));
  }

  async listStores(ctx: RequestContext, merchantId: string): Promise<StoreView[]> {
    const merchant = await this.loadVisible(ctx, backOfficeScope(ctx), merchantId);
    return (await this.merchants.listStores(merchant.id)).map(toStoreView);
  }

  // ───── мерчант портал ─────
  /** GET /merchant-portal/me */
  async getProfile(ctx: RequestContext): Promise<MerchantProfile> {
    const scope = merchantScope(ctx);
    const merchant = await this.merchants.findMerchant(ctx.orgId, scope.merchantId);
    if (!merchant) throw new DomainError('NOT_FOUND', 'Merchant not found');
    const now = this.clock.now();
    const stores = (await this.merchants.listStores(merchant.id)).filter((s) => s.isActive && (scope.storeId === null || s.id === scope.storeId));
    const plans = merchant.status === 'ACTIVE' ? await this.plans.availablePlansFor(merchant, now) : [];
    return {
      merchant: { id: merchant.id, code: merchant.code, name: merchant.name, status: merchant.status, maxTicketAmount: merchant.maxTicketAmount, dailyLimitAmount: merchant.dailyLimitAmount },
      stores: stores.map((s) => ({ id: s.id, code: s.code, name: s.name })),
      currentStoreId: scope.storeId,
      role: scope.role,
      plans: plans.map(toPlanView).map(({ id, code, name, goodsCategories, minAmount, maxAmount, termOptions, annualRate, feeRate, minDownPaymentRate, validFrom, validTo }) => (
        { id, code, name, goodsCategories, minAmount, maxAmount, termOptions, annualRate, feeRate, minDownPaymentRate, validFrom, validTo })),
    };
  }

  /** Back-office: BRANCH_MANAGER өөр салбарын мерчантыг 404-өөр харна (оршин байгааг задруулахгүй). */
  private async loadVisible(ctx: RequestContext, scope: BackOfficeScope, id: string): Promise<MerchantRecord> {
    const m = await this.merchants.findMerchant(ctx.orgId, id);
    if (!m || !inBranch(scope, m.branchId)) throw new DomainError('NOT_FOUND', 'Merchant not found');
    return m;
  }
}
