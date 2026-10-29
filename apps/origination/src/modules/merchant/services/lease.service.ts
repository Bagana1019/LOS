import { createHash } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { decidePosLease, isConsentChannelVerified } from '@los/calc';
import {
  POS_POLICY_DEFAULTS, PosPolicy,
  type OtpSent, type PosLeaseAccept, type PosLeaseAdminListQuery, type PosLeaseAdminView, type PosLeaseCancel, type PosLeaseCreate, type PosLeaseDeliver,
  type PosLeaseListItem, type PosLeaseListQuery, type PosLeaseReview, type PosLeaseSettle, type PosLeaseSubmit, type PosLeaseView, type PosLeaseWithOtp,
  type PosPolicyOverride, type PosScreeningResponse,
} from '@los/contracts';
import { maskPhone, maskRegister, scrubPii } from '../common/masking';
import { toCents } from '../common/money';
import type { Paged } from '../common/paged';
import type { RequestContext } from '../common/request-context';
import { addHours, addMinutes, addSeconds, mnDateKey, mnDayRange, mnYYMMDD } from '../common/time';
import { POS_CONFIG, type PosConfig } from '../config/pos.config';
import { DomainError, LeaseKeyConflict } from '../domain/errors';
import { leaseRef, posLeaseAccepted, posLeaseCancelled, posLeaseDecided, posLeaseDelivered, posLeaseSettled, type EventMeta } from '../domain/events';
import { assertTransition, effectiveStatus } from '../domain/lease-state';
import { assertMerchantActive, assertMerchantOperable } from '../domain/merchant-state';
import type { LeaseRecord, MerchantRecord, TimelineInput } from '../domain/records';
import { BuyerScreeningPort, Clock, IdGenerator, PiiCipher } from '../ports';
import { LeaseRepository, MerchantRepository, PlanRepository, type LeaseFilter, type LeaseScope } from '../persistence/repositories';
import { backOfficeScope, lenderActor, merchantActor, merchantScope, requireAdmin, type MerchantScope } from './access';
import { OtpService } from './otp.service';
import { QuoteService } from './quote.service';
import { toLeaseAdminView, toLeaseListItem, toLeaseView } from './view.mappers';

export const CONSENT_TEXT_VERSION = 'POS-CONSENT-v1';
const MAX_LEASE_NO_RETRIES = 5;
const REGISTER_QUERY = /^[А-ЯӨҮЁ]{2}\d{8}$/u;

/** Тогтвортой түлхүүрийн эрэмбэтэй JSON (requestHash-д). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((k) => (value as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** POS-FR-8 хайлт: бүтэн регистр (hash) | утасны сүүлийн 4–8 орон | лизингийн дугаарын хэсэг (≥ 3). */
export function buildSearchFilter(q: string | undefined, cipher: Pick<PiiCipher, 'hash'>): Pick<LeaseFilter, 'buyerRegisterHash' | 'buyerPhoneSuffix' | 'leaseNoLike'> {
  const text = q?.trim();
  if (!text) return {};
  const upper = text.toUpperCase();
  if (REGISTER_QUERY.test(upper)) return { buyerRegisterHash: cipher.hash(upper) };
  if (/^\d{4,8}$/.test(text)) return { buyerPhoneSuffix: text };
  if (text.length >= 3) return { leaseNoLike: text };
  return {};
}

/** plan.policy-ийн тодорхойлогдсон утгуудаар POS_POLICY_DEFAULTS-ийг дарна. */
export function effectivePolicy(override: PosPolicyOverride): PosPolicy {
  const defined = Object.fromEntries(Object.entries(override).filter(([, v]) => v !== undefined));
  return PosPolicy.parse({ ...POS_POLICY_DEFAULTS, ...defined });
}

const invalidAction = (lease: Pick<LeaseRecord, 'status'>, action: string) =>
  new DomainError('INVALID_TRANSITION', `Action ${action} is not allowed in status ${lease.status}`, { from: lease.status, action });

/**
 * POS лизингийн бүх урсгал (docs/05 §3-§5). Бүх үйлдэл tenant хүрээгээр (мерчант/дэлгүүр/салбар) repository-д шүүгдэнэ;
 * хүрээнээс гадуур → 404. Бичилт бүр optimistic `version`-тэй, event нь бизнес бичлэгтэй нэг repository дуудлагад.
 */
@Injectable()
export class LeaseService {
  constructor(
    @Inject(LeaseRepository) private readonly leases: LeaseRepository,
    @Inject(MerchantRepository) private readonly merchants: MerchantRepository,
    @Inject(PlanRepository) private readonly plans: PlanRepository,
    @Inject(OtpService) private readonly otp: OtpService,
    @Inject(QuoteService) private readonly quotes: QuoteService,
    @Inject(BuyerScreeningPort) private readonly screening: BuyerScreeningPort,
    @Inject(PiiCipher) private readonly cipher: PiiCipher,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(IdGenerator) private readonly ids: IdGenerator,
    @Inject(POS_CONFIG) private readonly config: PosConfig,
  ) {}

  // ───────────── үүсгэх ─────────────
  /** POS-BR-12: Idempotency-Key. Replay → ижил лизинг (replayed=true, шинэ SMS-гүй). */
  async createLease(ctx: RequestContext, idempotencyKey: string, input: PosLeaseCreate): Promise<{ result: PosLeaseWithOtp; replayed: boolean }> {
    const scope = merchantScope(ctx);
    if (scope.storeId !== null && input.storeId !== undefined && input.storeId !== scope.storeId) {
      throw new DomainError('STORE_SCOPE_VIOLATION', 'The store is outside your scope');
    }
    const merchant = await this.requireMerchant(ctx.orgId, scope.merchantId);
    assertMerchantActive(merchant.status);
    const storeId = await this.resolveStoreId(scope, merchant, input.storeId);
    const store = await this.merchants.findStore(merchant.id, storeId);
    if (!store) throw new DomainError('NOT_FOUND', 'Store not found');
    if (!store.isActive) throw new DomainError('STORE_NOT_ACTIVE', 'Store is not active');

    // Регистрийн түлхүүргүй sha256-г brute-force хийх боломжтой тул requestHash-д регистрийн HMAC-hash-ыг оруулна.
    const requestHash = createHash('sha256').update(canonicalJson({ ...input, storeId, buyer: { ...input.buyer, registerNo: this.cipher.hash(input.buyer.registerNo) } })).digest('hex');
    const existing = await this.leases.findByIdempotencyKey(merchant.id, idempotencyKey);
    if (existing) return { result: await this.replay(ctx, existing, requestHash), replayed: true };

    const { plan, quote } = await this.quotes.price(merchant, {
      planCode: input.planCode, goodsPrice: input.goods.price, downPayment: input.downPayment, termMonths: input.termMonths, goodsCategory: input.goods.category,
    });
    const now = this.clock.now();
    const id = this.ids.uuid();
    // version: 1 = DB-ийн `pos_lease_version_check (version >= 1)` ба баганын анхдагч утга; saveLease бүр +1.
    // branchId = мерчантын ӨНӨӨДРИЙН салбарын түүхэн хуулбар (POS-BR-13); BRANCH_MANAGER-ийн хүрээг энэ биш merchant.branch_id-аар шүүнэ (docs/05 §2, §8).
    const base: LeaseRecord = {
      id, orgId: ctx.orgId, branchId: merchant.branchId, leaseNo: '', version: 1, merchantId: merchant.id, storeId, planId: plan.id, planCode: plan.code, planName: plan.name,
      status: 'DRAFT', idempotencyKey, requestHash,
      buyerRegisterEncrypted: this.cipher.encrypt(input.buyer.registerNo), buyerRegisterHash: this.cipher.hash(input.buyer.registerNo),
      buyerRegisterMasked: maskRegister(input.buyer.registerNo), buyerPhone: input.buyer.phone, buyerLastName: null, buyerFirstName: null,
      goodsCategory: input.goods.category, goodsName: input.goods.name, goodsSerialNo: input.goods.serialNo ?? null, goodsPrice: input.goods.price,
      quote, decision: null, decisionReasons: [], dtiRatio: null, affordability: null, screeningSummary: null,
      decidedAt: null, decidedBy: null, decisionComment: null, consentVerifiedAt: null, consentTextVersion: null,
      expiresAt: addMinutes(now, this.config.draftTtlMinutes), acceptedAt: null, deliveredAt: null, deliveredBy: null, settledAt: null, settlementRef: null,
      cancelledAt: null, cancelReason: null, applicationId: null,
      createdAt: now, updatedAt: now, createdBy: ctx.userId, updatedBy: ctx.userId,
    };
    let saved: LeaseRecord | null = null;
    for (let attempt = 0; saved === null; attempt++) {
      const lease: LeaseRecord = { ...base, leaseNo: `POS-${mnYYMMDD(now)}-${this.ids.leaseSuffix()}` };
      const timeline: TimelineInput = { leaseId: id, at: now, action: 'CREATED', fromStatus: null, toStatus: 'DRAFT', actor: merchantActor(ctx), data: null };
      try {
        saved = await this.leases.insertLease(lease, timeline, []);
      } catch (e) {
        if (!(e instanceof LeaseKeyConflict)) throw e;
        if (e.kind === 'IDEMPOTENCY') {
          const raced = await this.leases.findByIdempotencyKey(merchant.id, idempotencyKey);
          if (!raced) throw e;
          return { result: await this.replay(ctx, raced, requestHash), replayed: true };
        }
        if (attempt >= MAX_LEASE_NO_RETRIES) throw e;
      }
    }
    // SMS амжилтгүй бол DomainError(SMS_UNAVAILABLE); лизинг DRAFT хэвээр — кассир resend хийнэ.
    const otp = await this.issueConsentOtp(saved, ctx);
    return { result: { lease: await this.toView(saved, merchant), otp }, replayed: false };
  }

  /**
   * Зөвшөөрлийн OTP илгээж, зэрэгцээ хүсэлт (replay) түрүүлж илгээчихсэн бол OTP_RESEND_TOO_SOON-г алдаа БИШ амжилт гэж үзэж сүүлийн кодыг буцаана
   * (POS-BR-12: ижил key + бие → 200, 429 биш). Давхар SMS-ийг replay() өөрөө өгөхгүй (доор).
   */
  private async issueConsentOtp(lease: LeaseRecord, ctx: RequestContext): Promise<OtpSent> {
    try {
      return await this.otp.issue(lease, 'CONSENT', ctx);
    } catch (e) {
      if (e instanceof DomainError && e.code === 'OTP_RESEND_TOO_SOON') {
        const latest = await this.otp.latest(lease.id, 'CONSENT');
        if (latest) return this.otp.toOtpSent(latest);
      }
      throw e;
    }
  }

  private async replay(ctx: RequestContext, existing: LeaseRecord, requestHash: string): Promise<PosLeaseWithOtp> {
    if (existing.requestHash !== requestHash) throw new DomainError('IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used with a different request');
    const merchant = await this.requireMerchant(existing.orgId, existing.merchantId);
    const latest = await this.otp.latest(existing.id, 'CONSENT');
    const now = this.clock.now();
    let otp: OtpSent;
    if (latest) otp = this.otp.toOtpSent(latest);
    else if (effectiveStatus(existing, now) === 'DRAFT' && !existing.consentVerifiedAt) {
      // Код байхгүй: (1) үүсгэгч хүсэлт SMS-ээ илгээж байгаа ЯВЦДАА байж болно, эсвэл (2) өмнөх SMS амжилтгүй болсон.
      // Лизинг дахин илгээх хугацаанаас (POS_OTP_RESEND_SECONDS) залуу бол ХЭЗЭЭ Ч шинэ SMS илгээхгүй (давхар SMS / 429-өөс сэргийлнэ): кассир resendAvailableAt-аас
      // эсвэл "код дахин илгээх" үйлдлээр шинээр авна. Хугацаа өнгөрсөн (үүсгэгч дууссан нь тодорхой) үед л "replay heals" — шинэ код илгээнэ.
      const resendAt = addSeconds(existing.createdAt, this.config.otpResendSeconds);
      if (now < resendAt) {
        otp = { purpose: 'CONSENT', phoneMasked: maskPhone(existing.buyerPhone), expiresAt: addSeconds(existing.createdAt, this.config.otpTtlSeconds).toISOString(), resendAvailableAt: resendAt.toISOString() };
      } else otp = await this.issueConsentOtp(existing, ctx);
    } else {
      const stamp = now.toISOString(); // зөвшөөрөл аль хэдийн баталгаажсан — идэвхтэй код байхгүй
      otp = { purpose: 'CONSENT', phoneMasked: maskPhone(existing.buyerPhone), expiresAt: stamp, resendAvailableAt: stamp };
    }
    return { lease: await this.toView(existing, merchant), otp };
  }

  private async resolveStoreId(scope: MerchantScope, merchant: MerchantRecord, requested: string | undefined): Promise<string> {
    if (scope.storeId !== null) return scope.storeId;
    if (requested) return requested;
    const active = (await this.merchants.listStores(merchant.id)).filter((s) => s.isActive);
    if (active.length === 1) return active[0].id;
    throw new DomainError('VALIDATION_FAILED', 'storeId required', { issues: [{ path: 'storeId', message: 'storeId required' }] });
  }

  async resendConsentOtp(ctx: RequestContext, id: string): Promise<OtpSent> {
    let lease = await this.loadForMerchant(ctx, id);
    lease = await this.expireIfStale(lease);
    if (lease.status !== 'DRAFT' || lease.consentVerifiedAt) throw invalidAction(lease, 'RESEND_CONSENT_OTP');
    assertMerchantActive((await this.requireMerchant(lease.orgId, lease.merchantId)).status);
    return this.otp.issue(lease, 'CONSENT', ctx);
  }

  // ───────────── шийдвэр ─────────────
  async submit(ctx: RequestContext, id: string, input: PosLeaseSubmit): Promise<PosLeaseView> {
    let lease = await this.loadForMerchant(ctx, id);
    lease = await this.expireIfStale(lease);
    if (lease.status !== 'DRAFT') throw invalidAction(lease, 'SUBMIT');
    const merchant = await this.requireMerchant(lease.orgId, lease.merchantId);
    assertMerchantActive(merchant.status);

    // POS-BR-7a: зөвшөөрөл (CONSENT OTP) баталгаажаагүй лизингэд лавлагаа татахгүй.
    if (!lease.consentVerifiedAt) {
      if (!input.otp) throw new DomainError('CONSENT_REQUIRED', 'Buyer consent code is required');
      await this.otp.verify(lease, 'CONSENT', input.otp);
      const at = this.clock.now();
      lease = await this.leases.saveLease(
        { ...lease, consentVerifiedAt: at, consentTextVersion: CONSENT_TEXT_VERSION, updatedAt: at, updatedBy: ctx.userId },
        { leaseId: lease.id, at, action: 'CONSENT_VERIFIED', fromStatus: 'DRAFT', toStatus: 'DRAFT', actor: 'BUYER', data: { consentTextVersion: CONSENT_TEXT_VERSION } },
        [],
      );
    }

    const plan = await this.plans.findPlan(lease.orgId, lease.planId);
    if (!plan) throw new DomainError('PLAN_NOT_AVAILABLE', 'The leasing plan is no longer available');
    const policy = effectivePolicy(plan.policy);

    // Гадаад лавлагаа: амжилтгүй бол лизинг DRAFT, зөвшөөрөл хадгалагдсан хэвээр (OTP-гүй дахин оролдож болно).
    const registerNo = this.cipher.decrypt(lease.buyerRegisterEncrypted);
    let screening: PosScreeningResponse;
    try {
      screening = await this.screening.screen({ leaseId: lease.id, registerNo, phone: lease.buyerPhone, consentVerifiedAt: lease.consentVerifiedAt!.toISOString() }, ctx.correlationId);
    } catch (e) {
      throw e instanceof DomainError && e.code === 'SCREENING_UNAVAILABLE' ? e : new DomainError('SCREENING_UNAVAILABLE', 'Credit screening is temporarily unavailable');
    }

    const decidedAt = this.clock.now();
    // POS-BR-1: урьдчилгааны санал хөтөлбөрийн дүнгийн хүрээ, мерчантын тасалбарын хязгаар, доод урьдчилгааны хувьд нийцсэн байх ёстой (FR-14 suggestion).
    const result = decidePosLease({
      quote: lease.quote, screening, policy, today: mnDateKey(decidedAt),
      limits: { minAmount: plan.minAmount, maxAmount: plan.maxAmount, maxTicketAmount: merchant.maxTicketAmount, minDownPaymentRate: plan.minDownPaymentRate },
    });
    // POS-BR-6: OTP кассирын оруулсан утсанд очдог тул утас иргэнийх гэдэг нь kyc-ээр (phoneMatches === true) батлагдаагүй бол нэрийг хадгалахгүй/харуулахгүй;
    // үр дүн нь calc-д REFER (MANUAL_REVIEW) болж хязгаарлагдсан тул регистрийн зээлийн байдал мерчантад задрахгүй.
    const channelVerified = isConsentChannelVerified(screening.identity);
    const status = result.decision === 'APPROVE' ? 'APPROVED' : result.decision === 'REFER' ? 'REFERRED' : 'DECLINED';
    assertTransition(lease.status, status);
    const expiresAt = result.decision === 'APPROVE' ? addMinutes(decidedAt, policy.offerTtlMinutes)
      : result.decision === 'REFER' ? addHours(decidedAt, this.config.referralTtlHours) : null;
    const next: LeaseRecord = {
      ...lease, status, expiresAt, updatedAt: decidedAt, updatedBy: ctx.userId,
      buyerLastName: channelVerified ? screening.identity.lastName : null, buyerFirstName: channelVerified ? screening.identity.firstName : null,
      decision: result.decision, decisionReasons: result.reasons, dtiRatio: result.dtiRatio, affordability: result.affordability,
      // PII/дүнгүй хураангуй: зөвхөн тугнууд ба тоо
      screeningSummary: {
        blacklistHit: screening.blacklist.hit, pep: screening.pep, cibAvailable: screening.cib.available, ficoScore: screening.cib.ficoScore,
        activeLoanCount: screening.cib.activeLoanCount, maxDpdDays: screening.cib.maxDpdDays, incomeSource: screening.income.source, incomeMonths: screening.income.months,
      },
      decidedAt, decidedBy: 'SYSTEM', decisionComment: null,
    };
    const event = posLeaseDecided({ ids: this.ids, clock: this.clock }, this.meta(ctx), {
      ...leaseRef(lease), decision: result.decision, decidedBy: 'SYSTEM', financedAmount: lease.quote.financedAmount,
      decisionSeconds: Math.max(0, (decidedAt.getTime() - lease.createdAt.getTime()) / 1000),
    });
    const saved = await this.leases.saveLease(next, { leaseId: lease.id, at: decidedAt, action: 'DECIDED', fromStatus: 'DRAFT', toStatus: status, actor: 'SYSTEM', data: { decision: result.decision } }, [event]);
    return this.toView(saved, merchant);
  }

  // ───────────── санал хүлээн авах ─────────────
  async requestAcceptOtp(ctx: RequestContext, id: string): Promise<OtpSent> {
    const lease = await this.loadApproved(ctx, id, 'REQUEST_ACCEPT_OTP');
    assertMerchantActive((await this.requireMerchant(lease.orgId, lease.merchantId)).status);
    return this.otp.issue(lease, 'ACCEPT', ctx);
  }

  async accept(ctx: RequestContext, id: string, input: PosLeaseAccept): Promise<PosLeaseView> {
    const lease = await this.loadApproved(ctx, id, 'ACCEPT');
    const merchant = await this.requireMerchant(lease.orgId, lease.merchantId);
    assertMerchantActive(merchant.status);
    const now = this.clock.now();
    // POS-BR-9: өдрийн лимит (Улаанбаатарын өдөр)
    if (merchant.dailyLimitAmount !== null) {
      const [from, to] = mnDayRange(now);
      const used = await this.leases.sumAcceptedFinanced(merchant.id, from, to);
      if (toCents(used) + toCents(lease.quote.financedAmount) > toCents(merchant.dailyLimitAmount)) {
        throw new DomainError('DAILY_LIMIT_EXCEEDED', 'Daily limit exceeded', { dailyLimitAmount: merchant.dailyLimitAmount, usedAmount: used });
      }
    }
    await this.otp.verify(lease, 'ACCEPT', input.otp);
    const q = lease.quote;
    const event = posLeaseAccepted({ ids: this.ids, clock: this.clock }, this.meta(ctx), {
      ...leaseRef(lease), financedAmount: q.financedAmount, principal: q.principal, termMonths: q.termMonths, annualRate: q.annualRate, monthlyPayment: q.monthlyPayment,
    });
    const saved = await this.leases.saveLease(
      { ...lease, status: 'ACCEPTED', acceptedAt: now, expiresAt: null, updatedAt: now, updatedBy: ctx.userId },
      { leaseId: lease.id, at: now, action: 'ACCEPTED', fromStatus: 'APPROVED', toStatus: 'ACCEPTED', actor: 'BUYER', data: null }, [event],
    );
    return this.toView(saved, merchant);
  }

  /** requestAcceptOtp/accept-ийн нийтлэг шалгалт: APPROVED ба хугацаа дуусаагүй. */
  private async loadApproved(ctx: RequestContext, id: string, action: string): Promise<LeaseRecord> {
    let lease = await this.loadForMerchant(ctx, id);
    lease = await this.expireIfStale(lease);
    if (lease.status === 'EXPIRED' && lease.decision === 'APPROVE') throw new DomainError('OFFER_EXPIRED', 'The offer has expired');
    if (lease.status !== 'APPROVED') throw invalidAction(lease, action);
    return lease;
  }

  // ───────────── хүлээлгэн өгөх / цуцлах ─────────────
  async deliver(ctx: RequestContext, id: string, input: PosLeaseDeliver): Promise<PosLeaseView> {
    const lease = await this.loadForMerchant(ctx, id);
    if (lease.status !== 'ACCEPTED') throw invalidAction(lease, 'DELIVER');
    const merchant = await this.requireMerchant(lease.orgId, lease.merchantId);
    assertMerchantOperable(merchant.status); // POS-BR-10: SUSPENDED-д дуусгахыг зөвшөөрнө
    assertTransition(lease.status, 'DELIVERED');
    const now = this.clock.now();
    const event = posLeaseDelivered({ ids: this.ids, clock: this.clock }, this.meta(ctx), {
      ...leaseRef(lease), netAmount: lease.quote.merchantNetAmount, commissionAmount: lease.quote.merchantCommissionAmount,
    });
    const saved = await this.leases.saveLease(
      { ...lease, status: 'DELIVERED', deliveredAt: now, deliveredBy: ctx.userId, goodsSerialNo: input.serialNo ?? lease.goodsSerialNo, updatedAt: now, updatedBy: ctx.userId },
      { leaseId: lease.id, at: now, action: 'DELIVERED', fromStatus: 'ACCEPTED', toStatus: 'DELIVERED', actor: merchantActor(ctx), data: null }, [event],
    );
    return this.toView(saved, merchant);
  }

  async cancel(ctx: RequestContext, id: string, input: PosLeaseCancel): Promise<PosLeaseView> {
    let lease = await this.loadForMerchant(ctx, id);
    lease = await this.expireIfStale(lease);
    const merchant = await this.requireMerchant(lease.orgId, lease.merchantId);
    assertMerchantOperable(merchant.status);
    assertTransition(lease.status, 'CANCELLED');
    const now = this.clock.now();
    const reason = scrubPii(input.reason); // чөлөөт текстэд регистр/утас орвол маскална
    const event = posLeaseCancelled({ ids: this.ids, clock: this.clock }, this.meta(ctx), { ...leaseRef(lease), fromStatus: lease.status, reason });
    const saved = await this.leases.saveLease(
      { ...lease, status: 'CANCELLED', cancelledAt: now, cancelReason: reason, updatedAt: now, updatedBy: ctx.userId },
      { leaseId: lease.id, at: now, action: 'CANCELLED', fromStatus: lease.status, toStatus: 'CANCELLED', actor: merchantActor(ctx), data: null }, [event],
    );
    return this.toView(saved, merchant);
  }

  // ───────────── лизингийн байгууллага ─────────────
  /** REFER хянах: зөвхөн REFERRED. APPROVE → санал нээгдэнэ (policy.offerTtlMinutes). */
  async review(ctx: RequestContext, id: string, input: PosLeaseReview): Promise<PosLeaseAdminView> {
    const scope = backOfficeScope(ctx);
    let lease = await this.loadForBackOffice(ctx, scope.branchId, id);
    lease = await this.expireIfStale(lease);
    if (lease.status !== 'REFERRED') throw invalidAction(lease, 'REVIEW');
    const status = input.decision === 'APPROVE' ? 'APPROVED' : 'DECLINED';
    assertTransition(lease.status, status);
    const plan = await this.plans.findPlan(lease.orgId, lease.planId);
    const policy = effectivePolicy(plan?.policy ?? {});
    const now = this.clock.now();
    const event = posLeaseDecided({ ids: this.ids, clock: this.clock }, this.meta(ctx), {
      ...leaseRef(lease), decision: input.decision, decidedBy: 'REVIEWER', financedAmount: lease.quote.financedAmount,
      decisionSeconds: Math.max(0, (now.getTime() - lease.createdAt.getTime()) / 1000),
    });
    const saved = await this.leases.saveLease(
      {
        ...lease, status, decision: input.decision, decidedAt: now, decidedBy: 'REVIEWER', decisionComment: scrubPii(input.comment), // POS-BR-7: чөлөөт тайлбарт орсон регистр/утсыг маскална
        expiresAt: status === 'APPROVED' ? addMinutes(now, policy.offerTtlMinutes) : null, updatedAt: now, updatedBy: ctx.userId,
      },
      { leaseId: lease.id, at: now, action: 'REVIEWED', fromStatus: 'REFERRED', toStatus: status, actor: lenderActor(ctx), data: { decision: input.decision } }, [event],
    );
    return this.toAdminView(saved);
  }

  /** Мерчантад төлбөр шилжүүлсэн (ADMIN): зөвхөн DELIVERED. */
  async settle(ctx: RequestContext, id: string, input: PosLeaseSettle): Promise<PosLeaseAdminView> {
    const scope = requireAdmin(ctx);
    const lease = await this.loadForBackOffice(ctx, scope.branchId, id);
    if (lease.status !== 'DELIVERED') throw invalidAction(lease, 'SETTLE');
    assertTransition(lease.status, 'SETTLED');
    const now = this.clock.now();
    const event = posLeaseSettled({ ids: this.ids, clock: this.clock }, this.meta(ctx), { ...leaseRef(lease), netAmount: lease.quote.merchantNetAmount, settlementRef: input.settlementRef });
    const saved = await this.leases.saveLease(
      { ...lease, status: 'SETTLED', settledAt: now, settlementRef: input.settlementRef, updatedAt: now, updatedBy: ctx.userId },
      { leaseId: lease.id, at: now, action: 'SETTLED', fromStatus: 'DELIVERED', toStatus: 'SETTLED', actor: lenderActor(ctx), data: null }, [event],
    );
    return this.toAdminView(saved);
  }

  // ───────────── унших ─────────────
  async getForMerchant(ctx: RequestContext, id: string): Promise<PosLeaseView> {
    const lease = await this.loadForMerchant(ctx, id);
    return this.toView(lease, await this.requireMerchant(lease.orgId, lease.merchantId));
  }

  async getForBackOffice(ctx: RequestContext, id: string): Promise<PosLeaseAdminView> {
    const scope = backOfficeScope(ctx);
    return this.toAdminView(await this.loadForBackOffice(ctx, scope.branchId, id));
  }

  async listForMerchant(ctx: RequestContext, query: PosLeaseListQuery): Promise<Paged<PosLeaseListItem>> {
    const scope = merchantScope(ctx);
    const leaseScope: LeaseScope = { orgId: ctx.orgId, merchantId: scope.merchantId, ...(scope.storeId ?? query.storeId ? { storeId: scope.storeId ?? query.storeId } : {}) };
    return this.list(leaseScope, query);
  }

  async listForBackOffice(ctx: RequestContext, query: PosLeaseAdminListQuery): Promise<Paged<PosLeaseListItem>> {
    const scope = backOfficeScope(ctx);
    const leaseScope: LeaseScope = {
      orgId: ctx.orgId, ...(query.merchantId ? { merchantId: query.merchantId } : {}), ...(query.storeId ? { storeId: query.storeId } : {}), ...(scope.branchId ? { branchId: scope.branchId } : {}),
    };
    return this.list(leaseScope, query);
  }

  private async list(scope: LeaseScope, query: PosLeaseListQuery): Promise<Paged<PosLeaseListItem>> {
    const filter: LeaseFilter = {
      ...(query.status?.length ? { statuses: query.status } : {}), ...(query.from ? { from: new Date(query.from) } : {}), ...(query.to ? { to: new Date(query.to) } : {}),
      ...buildSearchFilter(query.q, this.cipher),
    };
    const page = await this.leases.listLeases(scope, filter, { page: query.page, pageSize: query.pageSize });
    const now = this.clock.now();
    const storeNames = await this.storeNames([...new Set(page.items.map((l) => l.merchantId))]);
    return { items: page.items.map((l) => toLeaseListItem(l, { storeName: storeNames.get(l.storeId) ?? '', now })), total: page.total, page: query.page, pageSize: query.pageSize };
  }

  // ───────────── хугацаа дуусалт ─────────────
  /** Хуваарьт цэвэрлэгээ (Модуль 0 BullMQ): хугацаа дууссан DRAFT/REFERRED/APPROVED → EXPIRED. Зэрэгцээ өөрчлөлтийг алгасна. */
  async expireStale(now: Date = this.clock.now(), limit = 200): Promise<number> {
    let expired = 0;
    for (const lease of await this.leases.listExpirable(now, limit)) {
      if ((await this.expire(lease, now, `expire-stale:${this.ids.uuid()}`)).won) expired++; // зэрэгцээ ажиллагаанд хожигдсоныг тоолохгүй
    }
    return expired;
  }

  /** Lazy expiry: хадгалагдсан төлөв хуучирсан бол EXPIRED болгож хадгална (уншилт БИШ — үйлдэл дээр). */
  private async expireIfStale(lease: LeaseRecord): Promise<LeaseRecord> {
    const now = this.clock.now();
    if (lease.status === 'EXPIRED' || effectiveStatus(lease, now) !== 'EXPIRED') return lease;
    return (await this.expire(lease, now, 'system:lazy-expiry')).lease;
  }

  /** `won=false` → зэрэгцээ үйлдэл түрүүлж хадгалсан (одоогийн бичлэгийг буцаана), event дахин үүсгэхгүй. */
  private async expire(lease: LeaseRecord, now: Date, correlationId: string): Promise<{ lease: LeaseRecord; won: boolean }> {
    assertTransition(lease.status, 'EXPIRED');
    const event = posLeaseCancelled({ ids: this.ids, clock: this.clock }, { orgId: lease.orgId, actorId: null, correlationId }, { ...leaseRef(lease), fromStatus: lease.status, reason: 'EXPIRED' });
    try {
      const saved = await this.leases.saveLease(
        { ...lease, status: 'EXPIRED', updatedAt: now, updatedBy: null },
        { leaseId: lease.id, at: now, action: 'EXPIRED', fromStatus: lease.status, toStatus: 'EXPIRED', actor: 'SYSTEM', data: null }, [event],
      );
      return { lease: saved, won: true };
    } catch (e) {
      if (e instanceof DomainError && e.code === 'CONCURRENT_UPDATE') return { lease: (await this.leases.findLease({ orgId: lease.orgId }, lease.id)) ?? lease, won: false };
      throw e;
    }
  }

  // ───────────── туслах ─────────────
  private meta(ctx: RequestContext): EventMeta {
    return { orgId: ctx.orgId, actorId: ctx.userId, correlationId: ctx.correlationId };
  }

  private async loadForMerchant(ctx: RequestContext, id: string): Promise<LeaseRecord> {
    const scope = merchantScope(ctx);
    const lease = await this.leases.findLease({ orgId: ctx.orgId, merchantId: scope.merchantId, ...(scope.storeId ? { storeId: scope.storeId } : {}) }, id);
    if (!lease) throw new DomainError('NOT_FOUND', 'Lease not found');
    return lease;
  }

  private async loadForBackOffice(ctx: RequestContext, branchId: string | null, id: string): Promise<LeaseRecord> {
    const lease = await this.leases.findLease({ orgId: ctx.orgId, ...(branchId ? { branchId } : {}) }, id);
    if (!lease) throw new DomainError('NOT_FOUND', 'Lease not found');
    return lease;
  }

  private async requireMerchant(orgId: string, merchantId: string): Promise<MerchantRecord> {
    const m = await this.merchants.findMerchant(orgId, merchantId);
    if (!m) throw new DomainError('NOT_FOUND', 'Merchant not found');
    return m;
  }

  private async storeNames(merchantIds: string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    for (const mid of merchantIds) for (const s of await this.merchants.listStores(mid)) names.set(s.id, s.name);
    return names;
  }

  private async toView(lease: LeaseRecord, merchant: MerchantRecord): Promise<PosLeaseView> {
    const [store, timeline] = await Promise.all([this.merchants.findStore(lease.merchantId, lease.storeId), this.leases.timeline(lease.id)]);
    return toLeaseView(lease, { storeName: store?.name ?? '', timeline, now: this.clock.now(), merchantStatus: merchant.status });
  }

  private async toAdminView(lease: LeaseRecord): Promise<PosLeaseAdminView> {
    const merchant = await this.requireMerchant(lease.orgId, lease.merchantId);
    const [store, timeline] = await Promise.all([this.merchants.findStore(lease.merchantId, lease.storeId), this.leases.timeline(lease.id)]);
    return toLeaseAdminView(lease, { storeName: store?.name ?? '', timeline, now: this.clock.now(), merchantStatus: merchant.status, merchantName: merchant.name });
  }
}

