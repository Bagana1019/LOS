import {
  type MerchantStatus, type MerchantView, type PlanView, type PosLeaseAdminView, type PosLeaseListItem, type PosLeaseView, type StoreView,
} from '@los/contracts';
import { publicReasonOf, suggestedDownPaymentFor } from '@los/calc';
import { maskAccountLast4, maskPhone } from '../common/masking';
import { allowedActions, effectiveStatus } from '../domain/lease-state';
import type { LeaseEventRecord, LeaseRecord, MerchantRecord, PlanRecord, StoreRecord } from '../domain/records';

// Бүх огноо ISO (offset-той); PII зөвхөн маскалсан. Мерчантын харагдац (PosLeaseView) дотоод шалтгаан/ӨОХ/чадамж/ЗМС-г ХЭЗЭЭ Ч агуулахгүй (POS-BR-6).
const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);

export function toMerchantView(m: MerchantRecord): MerchantView {
  return {
    id: m.id, code: m.code, name: m.name, legalName: m.legalName, companyRegisterNo: m.companyRegisterNo, category: m.category,
    contactName: m.contactName, phone: m.phone, email: m.email, branchId: m.branchId, status: m.status,
    commissionRate: m.commissionRate, maxTicketAmount: m.maxTicketAmount, dailyLimitAmount: m.dailyLimitAmount,
    settlement: { bankCode: m.settlementBankCode, accountMasked: maskAccountLast4(m.settlementAccountLast4), holderName: m.settlementHolderName },
    contractNo: m.contractNo, contractSignedAt: isoOrNull(m.contractSignedAt), createdAt: iso(m.createdAt), updatedAt: iso(m.updatedAt),
  };
}

export function toStoreView(s: StoreRecord): StoreView {
  return { id: s.id, merchantId: s.merchantId, code: s.code, name: s.name, address: s.address, phone: s.phone, isActive: s.isActive, createdAt: iso(s.createdAt) };
}

export function toPlanView(p: PlanRecord): PlanView {
  return {
    id: p.id, code: p.code, name: p.name, merchantId: p.merchantId, productId: p.productId, goodsCategories: p.goodsCategories,
    minAmount: p.minAmount, maxAmount: p.maxAmount, termOptions: p.termOptions, annualRate: p.annualRate, feeRate: p.feeRate,
    minDownPaymentRate: p.minDownPaymentRate, commissionRate: p.commissionRate, policy: p.policy,
    validFrom: isoOrNull(p.validFrom), validTo: isoOrNull(p.validTo), isActive: p.isActive, createdAt: iso(p.createdAt),
  };
}

export const buyerFullName = (l: Pick<LeaseRecord, 'consentVerifiedAt' | 'buyerLastName' | 'buyerFirstName'>): string | null =>
  l.consentVerifiedAt && l.buyerLastName && l.buyerFirstName ? `${l.buyerLastName} ${l.buyerFirstName}` : null;

/** Мерчантад харуулах ерөнхий шалтгаан (APPROVE → null). Reviewer-ийн татгалзалт нь дотоод код үлдээхгүй тул CREDIT_POLICY. */
function publicReason(l: LeaseRecord): PosLeaseView['decision']['publicReason'] {
  return l.decision ? publicReasonOf({ decision: l.decision, reasons: l.decisionReasons }) : null;
}

/** ӨОХ-оос шалтгаалсан REFER/DECLINE-д л урьдчилгааны санал (APPROVE болсон бол үгүй). */
function suggestedMinDownPayment(l: LeaseRecord): number | null {
  if (l.decision !== 'REFER' && l.decision !== 'DECLINE') return null;
  return suggestedDownPaymentFor({ reasons: l.decisionReasons, affordability: l.affordability });
}

const ACTOR_ROLES: readonly string[] = ['SYSTEM', 'BUYER', 'MERCHANT', 'LENDER'];
/** `LENDER:<userId>` → `LENDER`. Танигдаагүй угтвар → `UNKNOWN` (дотоод ID ямар ч тохиолдолд мерчантад гарахгүй). */
export const actorRole = (actor: string): string => {
  const role = actor.split(':', 1)[0];
  return ACTOR_ROLES.includes(role) ? role : 'UNKNOWN';
};

/**
 * POS-FR-11 timeline. Мерчантын харагдац (`exposeActorIds=false`) нь зөвхөн дүрийг (SYSTEM/BUYER/MERCHANT/LENDER) үзүүлнэ — лизингийн байгууллагын
 * ажилтны дотоод user id (`LENDER:<userId>`) гадаад мерчантад гарахгүй (POS-BR-6, docs/05 §13). Back-office-д бүтэн actor (аудит).
 */
export function toTimeline(events: LeaseEventRecord[], exposeActorIds = false): PosLeaseView['timeline'] {
  return events.map((e) => ({ at: iso(e.at), action: e.action, fromStatus: e.fromStatus, toStatus: e.toStatus, actor: exposeActorIds ? e.actor : actorRole(e.actor) }));
}

export interface LeaseViewExtras {
  storeName: string;
  timeline: LeaseEventRecord[];
  now: Date;
  merchantStatus?: MerchantStatus;
}

export function toLeaseView(l: LeaseRecord, x: LeaseViewExtras): PosLeaseView {
  const decisionSeconds = l.decidedBy === 'SYSTEM' && l.decidedAt ? Math.max(0, (l.decidedAt.getTime() - l.createdAt.getTime()) / 1000) : null;
  return {
    id: l.id, leaseNo: l.leaseNo, status: effectiveStatus(l, x.now), merchantId: l.merchantId, storeId: l.storeId, storeName: x.storeName,
    planCode: l.planCode, planName: l.planName,
    goods: { category: l.goodsCategory, name: l.goodsName, serialNo: l.goodsSerialNo, price: l.goodsPrice },
    quote: l.quote,
    buyer: { registerMasked: l.buyerRegisterMasked, phoneMasked: maskPhone(l.buyerPhone), fullName: buyerFullName(l) },
    decision: {
      result: l.decision, publicReason: publicReason(l), suggestedMinDownPayment: suggestedMinDownPayment(l),
      decidedAt: isoOrNull(l.decidedAt), decidedBy: l.decidedBy, decisionSeconds,
    },
    consentVerifiedAt: isoOrNull(l.consentVerifiedAt), expiresAt: isoOrNull(l.expiresAt), acceptedAt: isoOrNull(l.acceptedAt),
    deliveredAt: isoOrNull(l.deliveredAt), settledAt: isoOrNull(l.settledAt), cancelledAt: isoOrNull(l.cancelledAt), cancelReason: l.cancelReason,
    allowedActions: allowedActions(l, x.now, x.merchantStatus), timeline: toTimeline(x.timeline), createdAt: iso(l.createdAt),
  };
}

export function toLeaseAdminView(l: LeaseRecord, x: LeaseViewExtras & { merchantName: string }): PosLeaseAdminView {
  return {
    ...toLeaseView(l, x),
    timeline: toTimeline(x.timeline, true), // аудит: бүтэн actor (`LENDER:<userId>`)
    merchantName: x.merchantName,
    review: {
      reasons: l.decisionReasons.map((r) => ({ code: r.code, severity: r.severity })), dtiRatio: l.dtiRatio, affordability: l.affordability,
      comment: l.decisionComment, settlementRef: l.settlementRef, applicationId: l.applicationId,
    },
  };
}

export function toLeaseListItem(l: LeaseRecord, x: { storeName: string; now: Date }): PosLeaseListItem {
  return {
    id: l.id, leaseNo: l.leaseNo, status: effectiveStatus(l, x.now), createdAt: iso(l.createdAt), storeId: l.storeId, storeName: x.storeName, planCode: l.planCode,
    goodsName: l.goodsName, goodsPrice: l.goodsPrice, financedAmount: l.quote.financedAmount, monthlyPayment: l.quote.monthlyPayment, termMonths: l.quote.termMonths,
    buyerName: buyerFullName(l), buyerRegisterMasked: l.buyerRegisterMasked, buyerPhoneMasked: maskPhone(l.buyerPhone), publicReason: publicReason(l),
  };
}
