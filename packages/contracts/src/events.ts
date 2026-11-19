import { z } from 'zod';
import { AmlRiskLevel, AmlSubjectType, ScreeningList, ScreeningStatus } from './compliance';
import { MakerCheckerEvents } from './maker-checker';
import { ESignProvider, SigningFailureReason } from './enums';
// Event каталог — CLAUDE.md §4. Нэр: <Aggregate><PastTenseVerb>, version заавал.
const base = z.object({
  eventId: z.string().uuid(), occurredAt: z.string().datetime(), version: z.literal(1),
  orgId: z.string(), actorId: z.string().nullable(), correlationId: z.string(),
});
// N4 (DWH fact dimensions): additive optional fields — v1 payloads already in the stream stay valid. Ids/codes/amounts/rates only, no PII.
// interestRatePercent = annual % as stored on loan_application (23.99); customerId = primary borrower.
export const ApplicationSubmitted = base.extend({ type: z.literal('ApplicationSubmitted'), applicationId: z.string(), amount: z.number(), productId: z.string(),
  branchId: z.string().optional(), officerId: z.string().nullable().optional(), customerId: z.string().nullable().optional(),
  interestRatePercent: z.number().nullable().optional(), termMonths: z.number().int().nullable().optional() });
export const ApplicationApproved = base.extend({ type: z.literal('ApplicationApproved'), applicationId: z.string(), contractNo: z.string() });
export const ApplicationReturned = base.extend({ type: z.literal('ApplicationReturned'), applicationId: z.string(), levelNo: z.number(), comment: z.string() });
export const ApplicationStatusChanged = base.extend({ type: z.literal('ApplicationStatusChanged'), applicationId: z.string(), from: z.string(), to: z.string() });
export const DisbursementApproved = base.extend({ type: z.literal('DisbursementApproved'), applicationId: z.string(), amount: z.number(), coreLoanId: z.string().nullable(),
  branchId: z.string().optional(), productId: z.string().nullable().optional(), customerId: z.string().nullable().optional() });
export const KycCompleted = base.extend({ type: z.literal('KycCompleted'), applicationId: z.string(), customerId: z.string(), blacklisted: z.boolean() });
export const StatementImported = base.extend({ type: z.literal('StatementImported'), analysisId: z.string(), applicationId: z.string(), rows: z.number(), status: z.enum(['COMPLETED','FAILED']),
  /** N4: INT-4 BsaSummary snapshot at import time (COMPLETED only); monthlyIncome = totalMonthlyIncome, pendingSuspiciousCount = unresolved suspicions */
  customerId: z.string().optional(), periodMonths: z.number().int().optional(), monthlyIncome: z.number().optional(), netCashFlowMonthly: z.number().optional(),
  dtiPercent: z.number().optional(), dtiLevel: z.enum(['LOW','MEDIUM','HIGH']).optional(), pendingSuspiciousCount: z.number().int().min(0).optional() });
export const ScoringCompleted = base.extend({ type: z.literal('ScoringCompleted'), applicationId: z.string(), selectedMethod: z.string(), soscoScore: z.number().nullable(), dtiPercent: z.number().nullable(),
  /** N4: selected method's ӨТЧХ (B/C, ratio e.g. 1.31; null for A) and collateral LTV (fraction 0.62; null without collateral) */
  dscr: z.number().nullable().optional(), ltv: z.number().nullable().optional() });
// valuationId…assetType нь нэмэлт (optional) талбарууд — origination барьцааны үнэлгээг event-ээр давхар синк хийхэд хэрэглэнэ (Модуль 6).
export const ValuationCompleted = base.extend({ type: z.literal('ValuationCompleted'), collateralId: z.string(), applicationId: z.string(), marketValue: z.number(), collateralValue: z.number(),
  valuationId: z.string().optional(), assetType: z.string().optional(), source: z.enum(['INTERNAL', 'EXTERNAL_LICENSED']).optional(), haircutRate: z.number().optional(), valuedAt: z.string().datetime().optional(), validUntil: z.string().datetime().nullable().optional(), externalRequired: z.boolean().optional() });
// relatedEntity…fileId нь нэмэлт (optional) — origination checklist-ийг дахин тооцоход хэрэглэнэ (Модуль 9).
export const DocumentUploaded = base.extend({ type: z.literal('DocumentUploaded'), documentId: z.string(), applicationId: z.string().nullable(), kind: z.string(), relatedEntity: z.enum(['BORROWER', 'COLLATERAL', 'APPLICATION']).optional(), relatedId: z.string().nullable().optional(), checklistKey: z.string().nullable().optional(), fileId: z.string().optional() });
export const DocumentRemoved = base.extend({ type: z.literal('DocumentRemoved'), documentId: z.string(), applicationId: z.string().nullable(), kind: z.string(), relatedEntity: z.enum(['BORROWER', 'COLLATERAL', 'APPLICATION']).optional(), relatedId: z.string().nullable().optional(), checklistKey: z.string().nullable().optional() });
export const CollateralChanged = base.extend({ type: z.literal('CollateralChanged'), applicationId: z.string(), collateralId: z.string(), assetType: z.string(), change: z.enum(['ADDED', 'UPDATED', 'REMOVED', 'VALUED', 'OWNERSHIP_CHECKED', 'ENCUMBRANCE_CHECKED', 'DOCUMENT_CHANGED', 'PLEDGE_REGISTERED', 'RELEASED']) });
// CLAUDE.md §3.2.8: нийтлэг тохиргоо өөрчлөгдөхөд бусад сервис projection-аа шинэчилнэ
export const SettingsChanged = base.extend({ type: z.literal('SettingsChanged'), key: z.string(), productId: z.string().nullable() });
export const AmlScreeningCompleted = base.extend({ type: z.literal('AmlScreeningCompleted'), screeningId: z.string(), customerId: z.string(), applicationId: z.string().nullable(), status: z.enum(ScreeningStatus), blocking: z.boolean(), riskScore: z.number(), riskLevel: z.enum(AmlRiskLevel), hitCount: z.number() });
export const AmlHitReviewed = base.extend({ type: z.literal('AmlHitReviewed'), screeningId: z.string(), hitId: z.string(), customerId: z.string(), applicationId: z.string().nullable(), list: z.enum(ScreeningList), decision: z.enum(['CONFIRMED','FALSE_POSITIVE']), screeningStatus: z.enum(ScreeningStatus), blocking: z.boolean(), riskScore: z.number(), riskLevel: z.enum(AmlRiskLevel) });
// origination → kyc: хар жагсаалтын projection. Регистр plain-ээр явахгүй — HMAC hash (64 жижиг hex; plain регистр schema-д няцна).
// changedAt нь нэг entry-д хатуу өсөх ёстой: kyc зөвхөн илүү шинэ changedAt-тай event-ийг хэрэглэнэ.
export const BlacklistEntryChanged = base.extend({ type: z.literal('BlacklistEntryChanged'), entryId: z.string(), registerNoHash: z.string().regex(/^[0-9a-f]{64}$/), customerType: z.enum(AmlSubjectType), name: z.string(), listType: z.string(), severity: z.enum(['BLACK', 'GREY']).default('BLACK'), reasonCode: z.string(), isActive: z.boolean(), changedAt: z.string().datetime() });
export type AmlScreeningCompleted = z.infer<typeof AmlScreeningCompleted>;
export type AmlHitReviewed = z.infer<typeof AmlHitReviewed>;
export type BlacklistEntryChanged = z.infer<typeof BlacklistEntryChanged>;
// FR-11.4 Цахим гарын үсэг (dms гаргана → origination, dwh). correlationId нь origination-ы эхлүүлсэн хүсэлтийнхтэй ижил.
export const ContractSigningRequested = base.extend({ type: z.literal('ContractSigningRequested'), signingRequestId: z.string(), applicationId: z.string(), contractId: z.string(), contractNo: z.string(), linkExpiresAt: z.string().datetime() });
export const ContractSigned = base.extend({ type: z.literal('ContractSigned'), signingRequestId: z.string(), applicationId: z.string(), contractId: z.string(), contractNo: z.string(), provider: z.enum(ESignProvider), signedFileId: z.string(), signatureFileId: z.string(), originalSha256: z.string(), signedSha256: z.string(), signedAt: z.string().datetime(), verificationCode: z.string() });
export const ContractSigningFailed = base.extend({ type: z.literal('ContractSigningFailed'), signingRequestId: z.string(), applicationId: z.string(), contractId: z.string(), contractNo: z.string(), reason: z.enum(SigningFailureReason) });
export const BorrowersChanged = base.extend({ type: z.literal('BorrowersChanged'), applicationId: z.string(), change: z.enum(['ADDED','UPDATED','REMOVED','PRIMARY_CHANGED']), customerId: z.string(), role: z.enum(['PRIMARY','CO_BORROWER','GUARANTOR','PLEDGOR']), borrowers: z.array(z.object({ customerId: z.string(), role: z.enum(['PRIMARY','CO_BORROWER','GUARANTOR','PLEDGOR']), incomeIncluded: z.boolean() })) });
export const PaymentReceived = base.extend({ type: z.literal('PaymentReceived'), paymentId: z.string(), applicationId: z.string(), provider: z.enum(['QPAY','SOCIALPAY','BANK_TRANSFER']), amount: z.number(), currency: z.string(), paidAt: z.string().datetime(), unallocatedAmount: z.number(), scheduleRowIds: z.array(z.string()) });
// Мерчант POS (docs/05-merchant-pos.md §7) — PII-гүй: дэлгэрэнгүйг origination-аас leaseId-аар авна.
export const PosLeaseDecided = base.extend({ type: z.literal('PosLeaseDecided'), leaseId: z.string(), leaseNo: z.string(), merchantId: z.string(), decision: z.enum(['APPROVE', 'REFER', 'DECLINE']), decidedBy: z.enum(['SYSTEM', 'REVIEWER']), financedAmount: z.number(), decisionSeconds: z.number() });
export const PosLeaseAccepted = base.extend({ type: z.literal('PosLeaseAccepted'), leaseId: z.string(), leaseNo: z.string(), merchantId: z.string(), financedAmount: z.number(), principal: z.number(), termMonths: z.number().int(), annualRate: z.number(), monthlyPayment: z.number() });
export const PosLeaseDelivered = base.extend({ type: z.literal('PosLeaseDelivered'), leaseId: z.string(), leaseNo: z.string(), merchantId: z.string(), netAmount: z.number(), commissionAmount: z.number() });
export const PosLeaseSettled = base.extend({ type: z.literal('PosLeaseSettled'), leaseId: z.string(), leaseNo: z.string(), merchantId: z.string(), netAmount: z.number(), settlementRef: z.string() });
export const PosLeaseCancelled = base.extend({ type: z.literal('PosLeaseCancelled'), leaseId: z.string(), leaseNo: z.string(), merchantId: z.string(), fromStatus: z.string(), reason: z.string() });
export const MerchantStatusChanged = base.extend({ type: z.literal('MerchantStatusChanged'), merchantId: z.string(), from: z.string(), to: z.string(), reason: z.string() });
export const DomainEvent = z.discriminatedUnion('type', [ApplicationSubmitted, ApplicationApproved, ApplicationReturned, ApplicationStatusChanged, DisbursementApproved, KycCompleted, StatementImported, ScoringCompleted, ValuationCompleted, DocumentUploaded, DocumentRemoved, CollateralChanged, SettingsChanged, BorrowersChanged, PaymentReceived, ...MakerCheckerEvents, PosLeaseDecided, PosLeaseAccepted, PosLeaseDelivered, PosLeaseSettled, PosLeaseCancelled, MerchantStatusChanged,
  ContractSigningRequested, ContractSigned, ContractSigningFailed, AmlScreeningCompleted, AmlHitReviewed, BlacklistEntryChanged]);
export type DomainEvent = z.infer<typeof DomainEvent>;
export const EVENT_STREAM = 'los:events';
