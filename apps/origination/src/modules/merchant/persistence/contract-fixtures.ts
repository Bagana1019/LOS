import { randomUUID } from 'node:crypto';
import type { DomainEvent, PosQuote } from '@los/contracts';
import type { LeaseRecord, MerchantRecord, OtpRecord, PlanRecord, StoreRecord, TimelineInput } from '../domain/records';

// Repository contract test-ийн өгөгдлийн үйлдвэрүүд. Бүх ID нь жинхэнэ uuid (Postgres `uuid` багана), код/дугаар нь тоолуураар давтагдахгүй.
// Огноо нь тогтмол (T0-оос), ms нарийвчлалтай — хоёр хэрэгжүүлэлтэд яг ижил буцах ёстой.

export const ORG = 'org-1';
export const OTHER_ORG = 'org-2';
export const T0 = new Date('2026-10-20T03:00:00.000Z');
/** T0 + minutes (+ ms) */
export const at = (minutes: number, ms = 0): Date => new Date(T0.getTime() + minutes * 60_000 + ms);

let counter = 0;
const next = () => ++counter;
const pad = (n: number, w = 4) => String(n).padStart(w, '0');

export function makeMerchant(over: Partial<MerchantRecord> = {}): MerchantRecord {
  const n = next();
  return {
    id: randomUUID(), orgId: ORG, version: 1, code: `MRC${pad(n)}`, name: `Merchant ${n}`, legalName: `Merchant ${n} LLC`, companyRegisterNo: '1234567', category: 'ELECTRONICS',
    contactName: 'Бат-Эрдэнэ', phone: '99112233', email: `m${n}@example.mn`, branchId: 'branch-1', status: 'ACTIVE', statusReason: null,
    commissionRate: 0.035, maxTicketAmount: 15_000_000, dailyLimitAmount: 50_000_000.5,
    settlementBankCode: 'KHAN', settlementAccountEncrypted: 'enc:v1:abcdef==', settlementAccountLast4: '1234', settlementHolderName: 'Номин Электроникс ХХК',
    contractNo: `CN-${pad(n)}`, contractSignedAt: at(-60 * 24, 123),
    createdAt: at(0), updatedAt: at(0), createdBy: 'user-admin', updatedBy: null,
    ...over,
  };
}

export function makeStore(merchantId: string, over: Partial<StoreRecord> = {}): StoreRecord {
  const n = next();
  return {
    id: randomUUID(), orgId: ORG, version: 1, merchantId, code: `ST${pad(n)}`, name: `Store ${n}`,
    address: { city: 'Улаанбаатар', district: 'Баянзүрх', khoroo: '5-р хороо', detail: 'Номин ТЦ, 2 давхар "A" тасаг' }, phone: '77001122', isActive: true,
    createdAt: at(0), updatedAt: at(0), createdBy: 'user-admin', updatedBy: null,
    ...over,
  };
}

export function makePlan(over: Partial<PlanRecord> = {}): PlanRecord {
  const n = next();
  return {
    id: randomUUID(), orgId: ORG, version: 1, merchantId: null, code: `PLAN${pad(n)}`, name: `Plan ${n}`, productId: null,
    goodsCategories: ['COMPUTER', 'PHONE_TABLET'], minAmount: 300_000, maxAmount: 10_000_000, termOptions: [3, 6, 12], annualRate: 0.2399, feeRate: 0.01, minDownPaymentRate: 0.1,
    commissionRate: null, policy: {}, validFrom: null, validTo: null, isActive: true,
    createdAt: at(0), updatedAt: at(0), createdBy: 'user-admin', updatedBy: null,
    ...over,
  };
}

/** PosQuote snapshot. Дүнгүүд өөр хоорондоо тохирох албагүй (repository зөвхөн хадгална), харин financedAmount нь денормалчилсан баганы эх сурвалж. */
export function makeQuote(over: Partial<PosQuote> = {}): PosQuote {
  return {
    planCode: 'PLAN0001', goodsPrice: 2_500_000, downPayment: 500_000, downPaymentRate: 0.2, financedAmount: 2_000_000, feeRate: 0.01, feeAmount: 20_000, principal: 2_020_000,
    termMonths: 12, annualRate: 0.2399, monthlyPayment: 190_000.55, totalRepayment: 2_280_006.6, totalInterestAndFees: 280_006.6, totalCostToBuyer: 2_780_006.6, effectiveAnnualRate: 0.3423,
    merchantCommissionRate: 0.03, merchantCommissionAmount: 60_000, merchantNetAmount: 1_940_000,
    ...over,
  };
}

export interface LeaseRefs { orgId?: string; merchantId: string; storeId: string; planId: string; branchId?: string; planCode?: string }

/** Бүх nullable талбар null, өдөр хоосон (DRAFT) лизинг. */
/** DB-ийн `pos_lease_lifecycle_check`: төлөв нь холбогдох цагийн тэмдэгтэй нийцнэ — тест өөрөөр заагаагүй бол төлөвөөс тооцно. */
function lifecycleStamps(over: Partial<LeaseRecord>): Partial<LeaseRecord> {
  const st = over.status;
  const stamps: Partial<LeaseRecord> = {};
  if (st && ['ACCEPTED', 'DELIVERED', 'SETTLED'].includes(st) && !('acceptedAt' in over)) stamps.acceptedAt = at(3);
  if (st && ['DELIVERED', 'SETTLED'].includes(st) && !('deliveredAt' in over)) stamps.deliveredAt = at(4);
  if (st === 'SETTLED' && !('settledAt' in over)) stamps.settledAt = at(5);
  if (st === 'CANCELLED' && !('cancelledAt' in over)) stamps.cancelledAt = at(3);
  return stamps;
}

export function makeLease(refs: LeaseRefs, over: Partial<LeaseRecord> = {}): LeaseRecord {
  const n = next();
  return {
    id: randomUUID(), orgId: refs.orgId ?? ORG, branchId: refs.branchId ?? 'branch-1', leaseNo: `POS-2610-${String(n).padStart(6, '0')}`, version: 1,
    merchantId: refs.merchantId, storeId: refs.storeId, planId: refs.planId, planCode: refs.planCode ?? 'PLAN0001', planName: 'Зөөврийн компьютер 12 сар', status: 'DRAFT',
    idempotencyKey: `idem-${randomUUID()}`, requestHash: 'a'.repeat(64),
    buyerRegisterEncrypted: 'enc:v1:reg==', buyerRegisterHash: `hash-${n}`, buyerRegisterMasked: 'УЕ******01', buyerPhone: '99112233', buyerLastName: null, buyerFirstName: null,
    goodsCategory: 'COMPUTER', goodsName: 'Lenovo IdeaPad 3', goodsSerialNo: null, goodsPrice: 2_500_000,
    quote: makeQuote({ planCode: refs.planCode ?? 'PLAN0001' }),
    decision: null, decisionReasons: [], dtiRatio: null, affordability: null, screeningSummary: null,
    decidedAt: null, decidedBy: null, decisionComment: null, consentVerifiedAt: null, consentTextVersion: null,
    expiresAt: null, acceptedAt: null, deliveredAt: null, deliveredBy: null, settledAt: null, settlementRef: null, cancelledAt: null, cancelReason: null, applicationId: null,
    createdAt: at(1), updatedAt: at(1), createdBy: 'user-cashier', updatedBy: null,
    ...lifecycleStamps(over),
    ...over,
  };
}

/** Бүх nullable талбар бөглөгдсөн лизинг (round-trip шалгалтад). */
export function makeFullLease(refs: LeaseRefs, over: Partial<LeaseRecord> = {}): LeaseRecord {
  return makeLease(refs, {
    status: 'SETTLED', version: 7,
    buyerLastName: 'Сүхбаатар', buyerFirstName: 'Золзаяа', goodsSerialNo: 'SN-ABC/123 "x"', goodsName: 'MacBook Air 13" M3 🙂 — 16GB',
    decision: 'APPROVE', decisionReasons: [{ code: 'BLACKLISTED', severity: 'REFER' }, { code: 'DTI_EXCEEDED', severity: 'REFER' }, { code: 'FICO_LOW', severity: 'INFO' }], dtiRatio: 0.5432,
    affordability: { maxMonthlyPayment: 123_456.78, maxFinancedAmount: 1_234_567.89, suggestedMinDownPayment: 765_000 },
    screeningSummary: { blacklistHit: true, pep: false, ficoScore: 612, income: { monthly: 2_500_000, months: 6 }, notes: ['а', 'b', null] },
    decidedAt: at(2, 345), decidedBy: 'REVIEWER', decisionComment: 'Батлав. 100% итгэлтэй_биш\nмөр 2', consentVerifiedAt: at(1, 500), consentTextVersion: '2026-10-v1',
    expiresAt: at(35, 999), acceptedAt: at(5, 1), deliveredAt: at(6, 2), deliveredBy: 'user-cashier', settledAt: at(60 * 24, 3), settlementRef: 'TRX-2026-10-0001', cancelledAt: null, cancelReason: null,
    applicationId: 'app-0001', updatedBy: 'user-admin',
    quote: makeQuote({ planCode: refs.planCode ?? 'PLAN0001', financedAmount: 2_000_000.01, monthlyPayment: 190_000.55, effectiveAnnualRate: 0.34231234 }),
    ...over,
  });
}

export function makeTimeline(leaseId: string, over: Partial<TimelineInput> = {}): TimelineInput {
  return { leaseId, at: at(1), action: 'CREATED', fromStatus: null, toStatus: 'DRAFT', actor: 'MERCHANT:user-cashier', data: null, ...over };
}

export function makeOtp(leaseId: string, over: Partial<OtpRecord> = {}): OtpRecord {
  return {
    id: randomUUID(), orgId: ORG, leaseId, purpose: 'CONSENT', codeHash: 'c'.repeat(64), expiresAt: at(6), attempts: 0, sentToMasked: '99****33', sentAt: at(1), verifiedAt: null,
    ...over,
  };
}

const eventBase = (over: { orgId?: string } = {}) => ({
  eventId: randomUUID(), occurredAt: at(1, 7).toISOString(), version: 1 as const, orgId: over.orgId ?? ORG, actorId: 'user-admin', correlationId: `corr-${randomUUID()}`,
});

export function merchantStatusChanged(merchantId: string, over: { from?: string; to?: string; reason?: string; orgId?: string } = {}): DomainEvent {
  return { ...eventBase(over), type: 'MerchantStatusChanged', merchantId, from: over.from ?? 'PENDING', to: over.to ?? 'ACTIVE', reason: over.reason ?? 'Гэрээ байгуулсан' };
}

export function leaseDecided(l: Pick<LeaseRecord, 'id' | 'leaseNo' | 'merchantId'>, over: { orgId?: string } = {}): DomainEvent {
  return {
    ...eventBase(over), type: 'PosLeaseDecided', leaseId: l.id, leaseNo: l.leaseNo, merchantId: l.merchantId, decision: 'APPROVE', decidedBy: 'SYSTEM', financedAmount: 2_000_000, decisionSeconds: 12.5,
  };
}

export function leaseCancelled(l: Pick<LeaseRecord, 'id' | 'leaseNo' | 'merchantId'>, over: { orgId?: string } = {}): DomainEvent {
  return { ...eventBase(over), type: 'PosLeaseCancelled', leaseId: l.id, leaseNo: l.leaseNo, merchantId: l.merchantId, fromStatus: 'DRAFT', reason: 'Худалдан авагч татгалзсан' };
}
