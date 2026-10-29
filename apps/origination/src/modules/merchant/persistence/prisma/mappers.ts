import type { Address, GoodsCategory, MerchantStatus, PosDecision, PosLeaseStatus, PosOtpPurpose, PosPolicyOverride, PosQuote } from '@los/contracts';
import { Prisma } from './client';
import type {
  Merchant as MerchantRow, MerchantStore as StoreRow, PosLease as LeaseRow, PosLeaseEvent as EventRow, PosLeaseOtp as OtpRow, PosLeasePlan as PlanRow,
} from './client';
import type {
  LeaseAffordability, LeaseDashboardRow, LeaseEventRecord, LeaseReason, LeaseRecord, MerchantRecord, OtpRecord, PlanRecord, StoreRecord, TimelineInput,
} from '../../domain/records';
import { uuidV7 } from './uuid7';

// Domain record ↔ Prisma row хөрвүүлэлт. Зөвхөн энд Prisma.Decimal / DbNull / JsonValue-тай ажиллана: record-д Prisma төрөл ГООХГҮЙ (мөнгө = number, огноо = Date).

// ───────────── Decimal / Json ─────────────
/** number → numeric(18,2)/(7,4). `new Decimal(number)` нь тооны хамгийн богино десятичийн илэрхийллийг ашигладаг тул 0.1 → 0.1 яг. Хязгаарлагдмал биш утгыг хадгалахгүй. */
export function dec(n: number): Prisma.Decimal {
  if (!Number.isFinite(n)) throw new RangeError('Non-finite number cannot be stored as numeric');
  return new Prisma.Decimal(n);
}
export const decOrNull = (n: number | null): Prisma.Decimal | null => (n === null ? null : dec(n));
export const num = (d: Prisma.Decimal): number => d.toNumber();
export const numOrNull = (d: Prisma.Decimal | null): number | null => (d === null ? null : d.toNumber());

export const toJson = (v: unknown): Prisma.InputJsonValue => v as Prisma.InputJsonValue;
/** JS null → SQL NULL (Json? багана дээр `null` өгвөл Prisma алдаа өгнө). */
export const toJsonOrNull = (v: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull => (v === null || v === undefined ? Prisma.DbNull : (v as Prisma.InputJsonValue));
const fromJson = <T>(v: Prisma.JsonValue | null): T => v as unknown as T;
const fromJsonOrNull = <T>(v: Prisma.JsonValue | null): T | null => (v === null ? null : (v as unknown as T));

// ───────────── Merchant ─────────────
export function merchantToRecord(r: MerchantRow): MerchantRecord {
  return {
    id: r.id, orgId: r.orgId, version: r.version, code: r.code, name: r.name, legalName: r.legalName, companyRegisterNo: r.companyRegisterNo, category: r.category as GoodsCategory | null,
    contactName: r.contactName, phone: r.phone, email: r.email, branchId: r.branchId, status: r.status as MerchantStatus, statusReason: r.statusReason,
    commissionRate: num(r.commissionRate), maxTicketAmount: num(r.maxTicketAmount), dailyLimitAmount: numOrNull(r.dailyLimitAmount),
    settlementBankCode: r.settlementBankCode, settlementAccountEncrypted: r.settlementAccountEncrypted, settlementAccountLast4: r.settlementAccountLast4, settlementHolderName: r.settlementHolderName,
    contractNo: r.contractNo, contractSignedAt: r.contractSignedAt, createdAt: r.createdAt, updatedAt: r.updatedAt, createdBy: r.createdBy, updatedBy: r.updatedBy,
  };
}
/** id, orgId, version, createdAt, createdBy-аас бусад (хадгалагдсаны дараа өөрчлөгдөх боломжтой) талбарууд. `version`-ийг repository CAS-аар (+1) тусад нь удирдана. */
export function merchantMutable(m: MerchantRecord) {
  return {
    code: m.code, name: m.name, legalName: m.legalName, companyRegisterNo: m.companyRegisterNo, category: m.category, contactName: m.contactName, phone: m.phone, email: m.email,
    branchId: m.branchId, status: m.status, statusReason: m.statusReason, commissionRate: dec(m.commissionRate), maxTicketAmount: dec(m.maxTicketAmount), dailyLimitAmount: decOrNull(m.dailyLimitAmount),
    settlementBankCode: m.settlementBankCode, settlementAccountEncrypted: m.settlementAccountEncrypted, settlementAccountLast4: m.settlementAccountLast4, settlementHolderName: m.settlementHolderName,
    contractNo: m.contractNo, contractSignedAt: m.contractSignedAt, updatedAt: m.updatedAt, updatedBy: m.updatedBy,
  };
}
export function merchantToCreate(m: MerchantRecord): Prisma.MerchantUncheckedCreateInput {
  return { id: m.id, orgId: m.orgId, version: 1, createdAt: m.createdAt, createdBy: m.createdBy, ...merchantMutable(m) }; // insert үргэлж version 1
}

// ───────────── Store ─────────────
export function storeToRecord(r: StoreRow): StoreRecord {
  return {
    id: r.id, orgId: r.orgId, version: r.version, merchantId: r.merchantId, code: r.code, name: r.name, address: fromJson<Address>(r.addressJson), phone: r.phone, isActive: r.isActive,
    createdAt: r.createdAt, updatedAt: r.updatedAt, createdBy: r.createdBy, updatedBy: r.updatedBy,
  };
}
export function storeMutable(s: StoreRecord) {
  return { code: s.code, name: s.name, addressJson: toJson(s.address), phone: s.phone, isActive: s.isActive, updatedAt: s.updatedAt, updatedBy: s.updatedBy };
}
export function storeToCreate(s: StoreRecord): Prisma.MerchantStoreUncheckedCreateInput {
  return { id: s.id, orgId: s.orgId, version: 1, merchantId: s.merchantId, createdAt: s.createdAt, createdBy: s.createdBy, ...storeMutable(s) };
}

// ───────────── Plan ─────────────
export function planToRecord(r: PlanRow): PlanRecord {
  return {
    id: r.id, orgId: r.orgId, version: r.version, merchantId: r.merchantId, code: r.code, name: r.name, productId: r.productId,
    goodsCategories: fromJson<GoodsCategory[]>(r.goodsCategoriesJson), minAmount: num(r.minAmount), maxAmount: num(r.maxAmount), termOptions: fromJson<number[]>(r.termOptionsJson),
    annualRate: num(r.annualRate), feeRate: num(r.feeRate), minDownPaymentRate: num(r.minDownPaymentRate), commissionRate: numOrNull(r.commissionRate),
    policy: fromJson<PosPolicyOverride>(r.policyJson), validFrom: r.validFrom, validTo: r.validTo, isActive: r.isActive,
    createdAt: r.createdAt, updatedAt: r.updatedAt, createdBy: r.createdBy, updatedBy: r.updatedBy,
  };
}
export function planMutable(p: PlanRecord) {
  return {
    merchantId: p.merchantId, code: p.code, name: p.name, productId: p.productId, goodsCategoriesJson: toJson(p.goodsCategories), minAmount: dec(p.minAmount), maxAmount: dec(p.maxAmount),
    termOptionsJson: toJson(p.termOptions), annualRate: dec(p.annualRate), feeRate: dec(p.feeRate), minDownPaymentRate: dec(p.minDownPaymentRate), commissionRate: decOrNull(p.commissionRate),
    policyJson: toJson(p.policy), validFrom: p.validFrom, validTo: p.validTo, isActive: p.isActive, updatedAt: p.updatedAt, updatedBy: p.updatedBy,
  };
}
export function planToCreate(p: PlanRecord): Prisma.PosLeasePlanUncheckedCreateInput {
  return { id: p.id, orgId: p.orgId, version: 1, createdAt: p.createdAt, createdBy: p.createdBy, ...planMutable(p) };
}

// ───────────── Lease ─────────────
export function leaseToRecord(r: LeaseRow): LeaseRecord {
  return {
    id: r.id, orgId: r.orgId, branchId: r.branchId, leaseNo: r.leaseNo, version: r.version,
    merchantId: r.merchantId, storeId: r.storeId, planId: r.planId, planCode: r.planCode, planName: r.planName, status: r.status as PosLeaseStatus,
    idempotencyKey: r.idempotencyKey, requestHash: r.requestHash,
    buyerRegisterEncrypted: r.buyerRegisterEncrypted, buyerRegisterHash: r.buyerRegisterHash, buyerRegisterMasked: r.buyerRegisterMasked, buyerPhone: r.buyerPhone,
    buyerLastName: r.buyerLastName, buyerFirstName: r.buyerFirstName,
    goodsCategory: r.goodsCategory as GoodsCategory, goodsName: r.goodsName, goodsSerialNo: r.goodsSerialNo, goodsPrice: num(r.goodsPrice),
    // POS: quote_json нь PosQuote-ийн эх сурвалж; денормалчилсан багана (down_payment …) зөвхөн тайлан/нийлбэрт
    quote: fromJson<PosQuote>(r.quoteJson),
    decision: r.decision as PosDecision | null, decisionReasons: fromJson<LeaseReason[]>(r.decisionReasonsJson), dtiRatio: numOrNull(r.dtiRatio), affordability: fromJsonOrNull<LeaseAffordability>(r.affordabilityJson),
    screeningSummary: fromJsonOrNull<Record<string, unknown>>(r.screeningJson),
    decidedAt: r.decidedAt, decidedBy: r.decidedBy as 'SYSTEM' | 'REVIEWER' | null, decisionComment: r.decisionComment,
    consentVerifiedAt: r.consentVerifiedAt, consentTextVersion: r.consentTextVersion,
    expiresAt: r.expiresAt, acceptedAt: r.acceptedAt, deliveredAt: r.deliveredAt, deliveredBy: r.deliveredBy,
    settledAt: r.settledAt, settlementRef: r.settlementRef, cancelledAt: r.cancelledAt, cancelReason: r.cancelReason, applicationId: r.applicationId,
    createdAt: r.createdAt, updatedAt: r.updatedAt, createdBy: r.createdBy, updatedBy: r.updatedBy,
  };
}
/** id, orgId, createdAt, createdBy-аас бусад бүх талбар (санах ойн хэрэгжүүлэлтийн "бүтэн бичлэгийг солих" семантиктай ижил). Денормалчилсан багана `l.quote`-оос. */
export function leaseMutable(l: LeaseRecord) {
  const q = l.quote;
  return {
    branchId: l.branchId, leaseNo: l.leaseNo, merchantId: l.merchantId, storeId: l.storeId, planId: l.planId, planCode: l.planCode, planName: l.planName, status: l.status,
    idempotencyKey: l.idempotencyKey, requestHash: l.requestHash,
    buyerRegisterEncrypted: l.buyerRegisterEncrypted, buyerRegisterHash: l.buyerRegisterHash, buyerRegisterMasked: l.buyerRegisterMasked, buyerPhone: l.buyerPhone,
    buyerLastName: l.buyerLastName, buyerFirstName: l.buyerFirstName,
    goodsCategory: l.goodsCategory, goodsName: l.goodsName, goodsSerialNo: l.goodsSerialNo, goodsPrice: dec(l.goodsPrice),
    quoteJson: toJson(q), downPayment: dec(q.downPayment), financedAmount: dec(q.financedAmount), feeAmount: dec(q.feeAmount), principal: dec(q.principal), termMonths: q.termMonths,
    annualRate: dec(q.annualRate), monthlyPayment: dec(q.monthlyPayment), merchantCommissionAmount: dec(q.merchantCommissionAmount), merchantNetAmount: dec(q.merchantNetAmount),
    decision: l.decision, decisionReasonsJson: toJson(l.decisionReasons), dtiRatio: decOrNull(l.dtiRatio), affordabilityJson: toJsonOrNull(l.affordability), screeningJson: toJsonOrNull(l.screeningSummary),
    decidedAt: l.decidedAt, decidedBy: l.decidedBy, decisionComment: l.decisionComment, consentVerifiedAt: l.consentVerifiedAt, consentTextVersion: l.consentTextVersion,
    expiresAt: l.expiresAt, acceptedAt: l.acceptedAt, deliveredAt: l.deliveredAt, deliveredBy: l.deliveredBy, settledAt: l.settledAt, settlementRef: l.settlementRef,
    cancelledAt: l.cancelledAt, cancelReason: l.cancelReason, applicationId: l.applicationId, updatedAt: l.updatedAt, updatedBy: l.updatedBy,
  };
}
export function leaseToCreate(l: LeaseRecord): Prisma.PosLeaseUncheckedCreateInput {
  return { id: l.id, orgId: l.orgId, version: l.version, createdAt: l.createdAt, createdBy: l.createdBy, ...leaseMutable(l) };
}

/** Dashboard-д хэрэгтэй багануудын жагсаалт (quote_json зэрэг том талбарыг уншихгүй). */
export const DASHBOARD_SELECT = {
  id: true, status: true, storeId: true, planCode: true, decision: true, createdAt: true, decidedAt: true, decidedBy: true, expiresAt: true, acceptedAt: true, deliveredAt: true, settledAt: true,
  goodsPrice: true, financedAmount: true, merchantCommissionAmount: true, merchantNetAmount: true,
} satisfies Prisma.PosLeaseSelect;
export function dashboardRowOf(r: Prisma.PosLeaseGetPayload<{ select: typeof DASHBOARD_SELECT }>): LeaseDashboardRow {
  return {
    id: r.id, status: r.status as PosLeaseStatus, storeId: r.storeId, planCode: r.planCode, decision: r.decision as PosDecision | null, createdAt: r.createdAt, decidedAt: r.decidedAt,
    decidedBy: r.decidedBy as 'SYSTEM' | 'REVIEWER' | null, expiresAt: r.expiresAt, acceptedAt: r.acceptedAt, deliveredAt: r.deliveredAt, settledAt: r.settledAt,
    goodsPrice: num(r.goodsPrice), financedAmount: num(r.financedAmount), merchantCommissionAmount: num(r.merchantCommissionAmount), merchantNetAmount: num(r.merchantNetAmount),
  };
}

// ───────────── Timeline ─────────────
/** `SYSTEM` | `BUYER` | `MERCHANT:<userId>` | `LENDER:<userId>` → actor_id (`:` -ийн дараах хэсэг, байхгүй бол null) + actor_label (бүтэн утга). */
export function actorParts(actor: string): { actorId: string | null; actorLabel: string } {
  const i = actor.indexOf(':');
  return { actorId: i > 0 && i < actor.length - 1 ? actor.slice(i + 1) : null, actorLabel: actor };
}
export function timelineToCreate(l: Pick<LeaseRecord, 'id' | 'orgId'>, t: TimelineInput): Prisma.PosLeaseEventUncheckedCreateInput {
  return {
    id: uuidV7(), orgId: l.orgId, leaseId: l.id, at: t.at, action: t.action, fromStatus: t.fromStatus, toStatus: t.toStatus, ...actorParts(t.actor), dataJson: toJsonOrNull(t.data),
  };
}
export function eventToRecord(r: EventRow): LeaseEventRecord {
  return {
    id: r.id, leaseId: r.leaseId, at: r.at, action: r.action, fromStatus: r.fromStatus as PosLeaseStatus | null, toStatus: r.toStatus as PosLeaseStatus | null,
    actor: r.actorLabel, data: fromJsonOrNull<Record<string, unknown>>(r.dataJson),
  };
}

// ───────────── OTP ─────────────
export function otpToRecord(r: OtpRow): OtpRecord {
  return {
    id: r.id, orgId: r.orgId, leaseId: r.leaseId, purpose: r.purpose as PosOtpPurpose, codeHash: r.codeHash, expiresAt: r.expiresAt, attempts: r.attempts,
    sentToMasked: r.sentToMasked, sentAt: r.sentAt, verifiedAt: r.verifiedAt,
  };
}
export function otpMutable(o: OtpRecord) {
  return { purpose: o.purpose, codeHash: o.codeHash, expiresAt: o.expiresAt, attempts: o.attempts, sentToMasked: o.sentToMasked, sentAt: o.sentAt, verifiedAt: o.verifiedAt };
}
export function otpToCreate(o: OtpRecord): Prisma.PosLeaseOtpUncheckedCreateInput {
  return { id: o.id, orgId: o.orgId, leaseId: o.leaseId, ...otpMutable(o) };
}
