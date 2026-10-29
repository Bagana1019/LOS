import type {
  Address, GoodsCategory, MerchantStatus, PosDecision, PosLeaseStatus, PosOtpPurpose, PosPolicyOverride, PosQuote, PosReasonCode, PosReasonSeverity,
} from '@los/contracts';

// Домэйн бичлэгүүд = docs/05 §7 хүснэгтүүд. Persistence давхарга (memory/prisma) эдгээрийг л хадгалж буцаана.
// Мөнгө `number` (MNT, 2 орон), хувь бутархай; огноо `Date`.
export interface AuditStamp { createdAt: Date; updatedAt: Date; createdBy: string | null; updatedBy: string | null }

/**
 * Optimistic lock: `version` нь хадгалагдсан мөрийн тоолуур (≥ 1, insert = 1). `save*` нь ЗӨВХӨН уншсан version-тай тэнцүү үед шинэчилж +1 болгоно,
 * үгүй бол DomainError('CONCURRENT_UPDATE') (docs/05 §4).
 */
export interface MerchantRecord extends AuditStamp {
  id: string; orgId: string; version: number; code: string; name: string; legalName: string | null; companyRegisterNo: string | null; category: GoodsCategory | null;
  contactName: string; phone: string; email: string | null; branchId: string; status: MerchantStatus; statusReason: string | null;
  commissionRate: number; maxTicketAmount: number; dailyLimitAmount: number | null;
  settlementBankCode: string; settlementAccountEncrypted: string; settlementAccountLast4: string; settlementHolderName: string;
  contractNo: string | null; contractSignedAt: Date | null;
}

export interface StoreRecord extends AuditStamp {
  id: string; orgId: string; version: number; merchantId: string; code: string; name: string; address: Address; phone: string | null; isActive: boolean;
}

export interface PlanRecord extends AuditStamp {
  id: string; orgId: string; version: number; merchantId: string | null; code: string; name: string; productId: string | null;
  goodsCategories: GoodsCategory[]; minAmount: number; maxAmount: number; termOptions: number[];
  annualRate: number; feeRate: number; minDownPaymentRate: number; commissionRate: number | null;
  policy: PosPolicyOverride; validFrom: Date | null; validTo: Date | null; isActive: boolean;
}

export interface LeaseReason { code: PosReasonCode; severity: PosReasonSeverity }
export interface LeaseAffordability { maxMonthlyPayment: number; maxFinancedAmount: number; suggestedMinDownPayment: number | null }

export interface LeaseRecord extends AuditStamp {
  id: string; orgId: string; branchId: string; leaseNo: string; version: number;
  merchantId: string; storeId: string; planId: string; planCode: string; planName: string;
  status: PosLeaseStatus;
  idempotencyKey: string; requestHash: string;
  buyerRegisterEncrypted: string; buyerRegisterHash: string; buyerRegisterMasked: string; buyerPhone: string;
  buyerLastName: string | null; buyerFirstName: string | null;
  goodsCategory: GoodsCategory; goodsName: string; goodsSerialNo: string | null; goodsPrice: number;
  /** Үнийн саналын бүрэн snapshot (хүү, шимтгэл, төлбөр — гэрээний үеийн нөхцөл). */
  quote: PosQuote;
  decision: PosDecision | null; decisionReasons: LeaseReason[]; dtiRatio: number | null; affordability: LeaseAffordability | null;
  /** PII-гүй хураангуй (хар жагсаалт/ PEP/ ФИКО/ орлого байгаа эсэх ...), back-office-д л. */
  screeningSummary: Record<string, unknown> | null;
  decidedAt: Date | null; decidedBy: 'SYSTEM' | 'REVIEWER' | null; decisionComment: string | null;
  consentVerifiedAt: Date | null; consentTextVersion: string | null;
  expiresAt: Date | null; acceptedAt: Date | null; deliveredAt: Date | null; deliveredBy: string | null;
  settledAt: Date | null; settlementRef: string | null; cancelledAt: Date | null; cancelReason: string | null;
  applicationId: string | null;
}

export interface LeaseEventRecord {
  id: string; leaseId: string; at: Date; action: string; fromStatus: PosLeaseStatus | null; toStatus: PosLeaseStatus | null;
  /** `SYSTEM` | `BUYER` | `MERCHANT:<userId>` | `LENDER:<userId>` */
  actor: string; data: Record<string, unknown> | null;
}
export type TimelineInput = Omit<LeaseEventRecord, 'id'>;

export interface OtpRecord {
  id: string; orgId: string; leaseId: string; purpose: PosOtpPurpose; codeHash: string; expiresAt: Date; attempts: number;
  sentToMasked: string; sentAt: Date; verifiedAt: Date | null;
}

/** Dashboard-д хүрэлцэх хөнгөн мөр (PII-гүй). */
export interface LeaseDashboardRow {
  id: string; status: PosLeaseStatus; storeId: string; planCode: string; decision: PosDecision | null;
  createdAt: Date; decidedAt: Date | null; decidedBy: 'SYSTEM' | 'REVIEWER' | null; expiresAt: Date | null; acceptedAt: Date | null; deliveredAt: Date | null; settledAt: Date | null;
  goodsPrice: number; financedAmount: number; merchantCommissionAmount: number; merchantNetAmount: number;
}
