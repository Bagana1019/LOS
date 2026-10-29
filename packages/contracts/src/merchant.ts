import { z } from 'zod';
import { CTX_HEADERS } from './auth';
// Мерчант POS портал (B2B2C) — docs/05-merchant-pos.md. Web ↔ gateway ↔ origination ↔ kyc-ийн цорын ганц гэрээ.
// Мөнгө: MNT, хувь: бутархай (0.2399 = 23.99%) — docs/03 "numeric(7,4)" дүрэм.

// ───────────── Enum ─────────────
export const MerchantStatus = ['PENDING', 'ACTIVE', 'SUSPENDED', 'TERMINATED'] as const;
export type MerchantStatus = (typeof MerchantStatus)[number];

/** Мерчантын хэрэглэгчийн дүр — gateway `X-Roles`-д лизингийн байгууллагын дүрүүдтэй (UserRole) хамт ирнэ. */
export const MerchantRole = ['MERCHANT_ADMIN', 'MERCHANT_STAFF'] as const;
export type MerchantRole = (typeof MerchantRole)[number];

export const GoodsCategory = ['COMPUTER', 'PHONE_TABLET', 'HOME_APPLIANCE', 'ELECTRONICS', 'FURNITURE', 'GAMES', 'SPORT_OUTDOOR', 'OTHER'] as const;
export type GoodsCategory = (typeof GoodsCategory)[number];

/** POS лизингийн төлөв. Шилжилтийн дүрэм: calc `POS_LEASE_TRANSITIONS`. */
export const PosLeaseStatus = ['DRAFT', 'REFERRED', 'APPROVED', 'DECLINED', 'ACCEPTED', 'DELIVERED', 'SETTLED', 'CANCELLED', 'EXPIRED'] as const;
export type PosLeaseStatus = (typeof PosLeaseStatus)[number];

export const PosDecision = ['APPROVE', 'REFER', 'DECLINE'] as const;
export type PosDecision = (typeof PosDecision)[number];

export const PosReasonSeverity = ['DECLINE', 'REFER', 'INFO'] as const;
export type PosReasonSeverity = (typeof PosReasonSeverity)[number];

/** Дотоод шалтгааны код — зөвхөн лизингийн байгууллагын ажилтан харна (мерчантад ил гаргахгүй). */
export const PosReasonCode = [
  'DPD_EXCEEDED', 'FICO_TOO_LOW', 'UNDERAGE', 'AGE_AT_MATURITY_EXCEEDED', 'DTI_EXCEEDED_HARD',
  'BLACKLISTED', 'PEP', 'INCOME_UNVERIFIED', 'DTI_EXCEEDED', 'FICO_LOW', 'DPD_WATCH',
  'TOO_MANY_ACTIVE_LOANS', 'AMOUNT_ABOVE_AUTO_LIMIT', 'IDENTITY_NOT_FOUND', 'PHONE_MISMATCH', 'CREDIT_DATA_UNAVAILABLE',
  'PHONE_UNVERIFIED', // kyc утас иргэнийх эсэхийг тогтоож чадаагүй (phoneMatches=null) → зөвшөөрлийн суваг баталгаажаагүй, гараар хянана
  'BIRTH_DATE_MISSING', // иргэн олдсон ч төрсөн огноо байхгүй → нас шалгаж чадахгүй, гараар хянана
] as const;
export type PosReasonCode = (typeof PosReasonCode)[number];

/** Мерчантад харуулах ерөнхий шалтгаан (зээлийн мэдээллийн нууцлал — POS-BR-6). */
export const PosPublicReason = ['AFFORDABILITY', 'CREDIT_POLICY', 'ELIGIBILITY', 'MANUAL_REVIEW'] as const;
export type PosPublicReason = (typeof PosPublicReason)[number];

export const PosOtpPurpose = ['CONSENT', 'ACCEPT'] as const;
export type PosOtpPurpose = (typeof PosOtpPurpose)[number];

/** Сервер-удирдсан UI: тухайн төлөвт мерчант юу хийж болохыг сервер хэлнэ. */
export const PosLeaseAction = ['SUBMIT', 'RESEND_CONSENT_OTP', 'REQUEST_ACCEPT_OTP', 'ACCEPT', 'DELIVER', 'CANCEL'] as const;
export type PosLeaseAction = (typeof PosLeaseAction)[number];

export const MerchantErrorCode = [
  'VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'MERCHANT_NOT_ACTIVE', 'STORE_NOT_ACTIVE', 'STORE_SCOPE_VIOLATION',
  'PLAN_NOT_AVAILABLE', 'GOODS_CATEGORY_NOT_ALLOWED', 'TERM_NOT_ALLOWED', 'AMOUNT_OUT_OF_RANGE', 'DOWN_PAYMENT_TOO_LOW', 'DOWN_PAYMENT_TOO_HIGH',
  'TICKET_LIMIT_EXCEEDED', 'DAILY_LIMIT_EXCEEDED', 'INVALID_TRANSITION', 'CONCURRENT_UPDATE', 'OFFER_EXPIRED',
  'OTP_INVALID', 'OTP_EXPIRED', 'OTP_ATTEMPTS_EXCEEDED', 'OTP_RESEND_TOO_SOON', 'OTP_NOT_REQUESTED', 'CONSENT_REQUIRED',
  'SCREENING_UNAVAILABLE', 'SMS_UNAVAILABLE', 'DUPLICATE_CODE', 'IDEMPOTENCY_CONFLICT',
] as const;
export type MerchantErrorCode = (typeof MerchantErrorCode)[number];

/** Бүх алдааны хариуны бие. */
export const MerchantErrorBody = z.object({ code: z.enum(MerchantErrorCode), message: z.string(), details: z.record(z.unknown()).optional() });
export type MerchantErrorBody = z.infer<typeof MerchantErrorBody>;

// ───────────── Gateway → service толгой (CLAUDE.md §3.2.9-ийн өргөтгөл) ─────────────
export const GATEWAY_HEADERS = CTX_HEADERS;

// ───────────── Нийтлэг primitive ─────────────
const trimmed = (s: z.ZodString) => z.preprocess((v) => (typeof v === 'string' ? v.trim() : v), s);
/** Монголын иргэний регистр: 2 кирилл үсэг + 8 цифр. */
export const RegisterNo = z.preprocess((v) => (typeof v === 'string' ? v.trim().toUpperCase() : v), z.string().regex(/^[А-ЯӨҮЁ]{2}\d{8}$/u, 'Регистрийн дугаар буруу'));
/** Монголын 8 оронтой гар утас. */
export const MnMobile = z.preprocess((v) => (typeof v === 'string' ? v.replace(/\s+/g, '') : v), z.string().regex(/^[6-9]\d{7}$/, 'Утасны дугаар буруу'));
export const Money = z.number().finite().nonnegative().max(1_000_000_000_000).multipleOf(0.01);
export const PositiveMoney = Money.positive();
export const Rate = z.number().finite().min(0).max(1);
/** Оролтын хувь: DB-ийн numeric(7,4)-тэй нийцүүлж 4 орноос илүү оронг татгалзана (хариуны/тооцоолсон `Rate`-д хамаарахгүй). */
export const RateInput = Rate.multipleOf(0.0001);
const Uuid = z.string().uuid();
const IsoDateTime = z.string().datetime({ offset: true });
export const Paged = <T extends z.ZodTypeAny>(item: T) => z.object({ items: z.array(item), total: z.number().int().nonnegative(), page: z.number().int().positive(), pageSize: z.number().int().positive() });
const PageQuery = { page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) };

// ───────────── Бодлого (шууд шийдвэрийн параметр; plan.policy-оор дарагдана) ─────────────
// Анхдагч утга нь DEMO (docs/01 §8). BR hardcode хийхгүй — plan бүр дарж болно.
export const PosPolicy = z.object({
  maxDti: RateInput, // BR-1: ӨОХ дээд
  referDti: RateInput, // maxDti-аас дээш, энэ хүртэл → REFER; үүнээс дээш → DECLINE
  minAge: z.number().int().min(16).max(100),
  maxAgeAtMaturity: z.number().int().min(18).max(100),
  declineDpd: z.number().int().min(1), // хугацаа хэтрэлт ≥ N хоног → DECLINE
  referDpd: z.number().int().min(1),
  declineFico: z.number().int(), // FICO < → DECLINE
  referFico: z.number().int(), // FICO < → REFER
  maxActiveLoansAuto: z.number().int().min(0),
  autoApproveMaxAmount: Money, // санхүүжилтийн дүн энээс дээш бол REFER
  autoDeclineEnabled: z.boolean(), // false бол DECLINE → REFER болгоно
  offerTtlMinutes: z.number().int().min(1).max(24 * 60),
});
export type PosPolicy = z.infer<typeof PosPolicy>;
export const PosPolicyOverride = PosPolicy.partial();
export type PosPolicyOverride = z.infer<typeof PosPolicyOverride>;
export const POS_POLICY_DEFAULTS: PosPolicy = {
  maxDti: 0.55, referDti: 0.65, minAge: 18, maxAgeAtMaturity: 65, declineDpd: 90, referDpd: 30,
  declineFico: 450, referFico: 550, maxActiveLoansAuto: 3, autoApproveMaxAmount: 10_000_000,
  autoDeclineEnabled: true, offerTtlMinutes: 30,
};

// ───────────── kyc үйлчилгээний гэрээ: origination → kyc `POST /api/inquiry/pos-screening` ─────────────
export const PosScreeningRequest = z.object({ leaseId: z.string(), registerNo: RegisterNo, phone: MnMobile, consentVerifiedAt: IsoDateTime });
export type PosScreeningRequest = z.infer<typeof PosScreeningRequest>;
export const PosScreeningResponse = z.object({
  identity: z.object({ found: z.boolean(), lastName: z.string().nullable(), firstName: z.string().nullable(), birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(), phoneMatches: z.boolean().nullable() }),
  blacklist: z.object({ hit: z.boolean(), reasonCode: z.string().nullable() }),
  pep: z.boolean(),
  cib: z.object({ available: z.boolean(), activeLoanCount: z.number().int().nonnegative(), monthlyDebtService: Money, maxDpdDays: z.number().int().nonnegative(), ficoScore: z.number().int().nullable() }),
  income: z.object({ monthlyAmount: Money.nullable(), source: z.enum(['NDSH', 'NONE']), months: z.number().int().nonnegative() }),
  fetchedAt: IsoDateTime,
});
export type PosScreeningResponse = z.infer<typeof PosScreeningResponse>;

// ───────────── Мерчант (лизингийн байгууллагын админ) ─────────────
const Address = z.object({ city: z.string().max(100).optional(), district: z.string().max(100).optional(), khoroo: z.string().max(100).optional(), detail: trimmed(z.string().min(2).max(300)) });
export type Address = z.infer<typeof Address>;
export const MerchantCode = z.preprocess((v) => (typeof v === 'string' ? v.trim().toUpperCase() : v), z.string().regex(/^[A-Z0-9-]{2,32}$/, 'Код: A-Z, 0-9, "-" (2–32)'));
const SettlementAccount = z.object({ bankCode: z.string().min(2).max(16), accountNo: z.string().regex(/^\d{6,20}$/, 'Дансны дугаар буруу'), holderName: trimmed(z.string().min(2).max(200)) });

export const MerchantCreate = z.object({
  code: MerchantCode,
  name: trimmed(z.string().min(2).max(200)),
  legalName: trimmed(z.string().min(2).max(200)).optional(),
  companyRegisterNo: z.string().regex(/^\d{7}$/, 'Байгууллагын регистр 7 оронтой').optional(),
  category: z.enum(GoodsCategory).optional(),
  contactName: trimmed(z.string().min(2).max(200)),
  phone: MnMobile,
  email: z.string().email().max(200).optional(),
  branchId: z.string().min(1), // харьцаа хариуцсан салбар (BR-12)
  commissionRate: RateInput.max(0.2), // мерчантаас авах шимтгэл (санхүүжилтийн дүнгээс)
  maxTicketAmount: PositiveMoney, // нэг лизингийн санхүүжилтийн дээд
  dailyLimitAmount: PositiveMoney.nullable().default(null),
  settlement: SettlementAccount,
  contractNo: z.string().max(64).optional(),
  contractSignedAt: IsoDateTime.optional(),
});
export type MerchantCreate = z.infer<typeof MerchantCreate>;
export const MerchantUpdate = MerchantCreate.omit({ code: true }).partial();
export type MerchantUpdate = z.infer<typeof MerchantUpdate>;
export const MerchantStatusChange = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED', 'TERMINATED']), reason: trimmed(z.string().min(3).max(500)) });
export type MerchantStatusChange = z.infer<typeof MerchantStatusChange>;

export const MerchantView = z.object({
  id: Uuid, code: z.string(), name: z.string(), legalName: z.string().nullable(), companyRegisterNo: z.string().nullable(), category: z.enum(GoodsCategory).nullable(),
  contactName: z.string(), phone: z.string(), email: z.string().nullable(), branchId: z.string(), status: z.enum(MerchantStatus),
  commissionRate: Rate, maxTicketAmount: Money, dailyLimitAmount: Money.nullable(),
  settlement: z.object({ bankCode: z.string(), accountMasked: z.string(), holderName: z.string() }),
  contractNo: z.string().nullable(), contractSignedAt: IsoDateTime.nullable(), createdAt: IsoDateTime, updatedAt: IsoDateTime,
});
export type MerchantView = z.infer<typeof MerchantView>;
export const MerchantListQuery = z.object({ status: z.enum(MerchantStatus).optional(), q: z.string().max(100).optional(), ...PageQuery });
export type MerchantListQuery = z.infer<typeof MerchantListQuery>;

export const StoreCreate = z.object({ code: MerchantCode, name: trimmed(z.string().min(2).max(200)), address: Address, phone: MnMobile.optional(), isActive: z.boolean().default(true) });
export type StoreCreate = z.infer<typeof StoreCreate>;
export const StoreUpdate = StoreCreate.omit({ code: true }).partial();
export type StoreUpdate = z.infer<typeof StoreUpdate>;
export const StoreView = z.object({ id: Uuid, merchantId: Uuid, code: z.string(), name: z.string(), address: Address, phone: z.string().nullable(), isActive: z.boolean(), createdAt: IsoDateTime });
export type StoreView = z.infer<typeof StoreView>;

// ───────────── Лизингийн хөтөлбөр (plan) ─────────────
export const PlanBase = z.object({
  code: MerchantCode,
  name: trimmed(z.string().min(2).max(200)),
  merchantId: Uuid.nullable().default(null), // null → бүх мерчантад
  productId: z.string().nullable().default(null), // origination.product (Модуль 5) — string ID, FK биш
  goodsCategories: z.array(z.enum(GoodsCategory)).min(1),
  minAmount: PositiveMoney, // санхүүжилтийн дүнгийн доод/дээд
  maxAmount: PositiveMoney,
  termOptions: z.array(z.number().int().min(1).max(60)).min(1).max(12),
  annualRate: RateInput, // жилийн хүү
  feeRate: RateInput.max(0.2).default(0), // худалдан авагчаас авах олголтын шимтгэл (санхүүжилтийн дүнгээс; зээлд нэмэгдэнэ)
  minDownPaymentRate: RateInput.max(0.9).default(0),
  commissionRate: RateInput.max(0.2).nullable().default(null), // null → мерчантын commissionRate
  policy: PosPolicyOverride.default({}),
  validFrom: IsoDateTime.nullable().default(null),
  validTo: IsoDateTime.nullable().default(null),
  isActive: z.boolean().default(true),
});
export const PlanCreate = PlanBase.refine((p) => p.minAmount <= p.maxAmount, { message: 'minAmount ≤ maxAmount', path: ['maxAmount'] })
  .refine((p) => new Set(p.termOptions).size === p.termOptions.length, { message: 'Хугацаа давхцсан', path: ['termOptions'] });
export type PlanCreate = z.infer<typeof PlanCreate>;
export const PlanUpdate = PlanBase.omit({ code: true }).partial();
export type PlanUpdate = z.infer<typeof PlanUpdate>;
export const PlanView = PlanBase.extend({ id: Uuid, termOptions: z.array(z.number().int()), policy: PosPolicy.partial(), createdAt: IsoDateTime });
export type PlanView = z.infer<typeof PlanView>;

// ───────────── Үнийн санал (quote) ─────────────
export const PosQuoteRequest = z.object({ planCode: MerchantCode, goodsPrice: PositiveMoney, downPayment: Money, termMonths: z.number().int().min(1).max(60), goodsCategory: z.enum(GoodsCategory).optional() });
export type PosQuoteRequest = z.infer<typeof PosQuoteRequest>;
export const PosQuote = z.object({
  planCode: z.string(), goodsPrice: Money, downPayment: Money, downPaymentRate: Rate, financedAmount: Money, feeRate: Rate, feeAmount: Money, principal: Money,
  termMonths: z.number().int(), annualRate: Rate, monthlyPayment: Money, totalRepayment: Money, totalInterestAndFees: Money, totalCostToBuyer: Money, effectiveAnnualRate: z.number(),
  merchantCommissionRate: Rate, merchantCommissionAmount: Money, merchantNetAmount: Money,
});
export type PosQuote = z.infer<typeof PosQuote>;

// ───────────── Лизинг үүсгэх / удирдах (мерчант портал) ─────────────
export const PosLeaseCreate = z.object({
  planCode: MerchantCode,
  storeId: Uuid.optional(), // MERCHANT_STAFF-д толгойн store; MERCHANT_ADMIN сонгоно
  goods: z.object({ category: z.enum(GoodsCategory), name: trimmed(z.string().min(2).max(200)), serialNo: trimmed(z.string().min(1).max(64)).optional(), price: PositiveMoney }),
  downPayment: Money,
  termMonths: z.number().int().min(1).max(60),
  buyer: z.object({ registerNo: RegisterNo, phone: MnMobile }),
});
export type PosLeaseCreate = z.infer<typeof PosLeaseCreate>;
export const OtpCode = z.string().regex(/^\d{6}$/, 'Баталгаажуулах код 6 оронтой');
export const PosLeaseSubmit = z.object({ otp: OtpCode.optional() }); // зөвшөөрөл аль хэдийн баталгаажсан бол (дахин оролдлого) шаардахгүй
export type PosLeaseSubmit = z.infer<typeof PosLeaseSubmit>;
export const PosLeaseAccept = z.object({ otp: OtpCode });
export type PosLeaseAccept = z.infer<typeof PosLeaseAccept>;
export const PosLeaseDeliver = z.object({ serialNo: trimmed(z.string().min(1).max(64)).optional() });
export type PosLeaseDeliver = z.infer<typeof PosLeaseDeliver>;
export const PosLeaseCancel = z.object({ reason: trimmed(z.string().min(3).max(300)) });
export type PosLeaseCancel = z.infer<typeof PosLeaseCancel>;
export const OtpSent = z.object({ purpose: z.enum(PosOtpPurpose), phoneMasked: z.string(), expiresAt: IsoDateTime, resendAvailableAt: IsoDateTime });
export type OtpSent = z.infer<typeof OtpSent>;

const TimelineEntry = z.object({ at: IsoDateTime, action: z.string(), fromStatus: z.enum(PosLeaseStatus).nullable(), toStatus: z.enum(PosLeaseStatus).nullable(), actor: z.string() });
export const PosLeaseView = z.object({
  id: Uuid, leaseNo: z.string(), status: z.enum(PosLeaseStatus), merchantId: Uuid, storeId: Uuid, storeName: z.string(), planCode: z.string(), planName: z.string(),
  goods: z.object({ category: z.enum(GoodsCategory), name: z.string(), serialNo: z.string().nullable(), price: Money }),
  quote: PosQuote,
  buyer: z.object({ registerMasked: z.string(), phoneMasked: z.string(), fullName: z.string().nullable() }),
  decision: z.object({
    result: z.enum(PosDecision).nullable(), publicReason: z.enum(PosPublicReason).nullable(), suggestedMinDownPayment: Money.nullable(),
    decidedAt: IsoDateTime.nullable(), decidedBy: z.enum(['SYSTEM', 'REVIEWER']).nullable(), decisionSeconds: z.number().nonnegative().nullable(),
  }),
  consentVerifiedAt: IsoDateTime.nullable(), expiresAt: IsoDateTime.nullable(), acceptedAt: IsoDateTime.nullable(), deliveredAt: IsoDateTime.nullable(), settledAt: IsoDateTime.nullable(),
  cancelledAt: IsoDateTime.nullable(), cancelReason: z.string().nullable(),
  allowedActions: z.array(z.enum(PosLeaseAction)), timeline: z.array(TimelineEntry), createdAt: IsoDateTime,
});
export type PosLeaseView = z.infer<typeof PosLeaseView>;
/** Лизинг үүсгэхэд буцах хариу: лизинг + худалдан авагчийн утсанд явсан зөвшөөрлийн кодын мэдээлэл. */
export const PosLeaseWithOtp = z.object({ lease: PosLeaseView, otp: OtpSent });
export type PosLeaseWithOtp = z.infer<typeof PosLeaseWithOtp>;
/** Лизингийн байгууллагын харагдац: дотоод шалтгаан, DTI, чадамж нэмэгдэнэ. */
export const PosLeaseAdminView = PosLeaseView.extend({
  merchantName: z.string(),
  review: z.object({
    reasons: z.array(z.object({ code: z.enum(PosReasonCode), severity: z.enum(PosReasonSeverity) })), dtiRatio: z.number().nullable(),
    affordability: z.object({ maxMonthlyPayment: z.number(), maxFinancedAmount: z.number(), suggestedMinDownPayment: z.number().nullable() }).nullable(),
    comment: z.string().nullable(), settlementRef: z.string().nullable(), applicationId: z.string().nullable(),
  }),
});
export type PosLeaseAdminView = z.infer<typeof PosLeaseAdminView>;

export const PosLeaseListItem = z.object({
  id: Uuid, leaseNo: z.string(), status: z.enum(PosLeaseStatus), createdAt: IsoDateTime, storeId: Uuid, storeName: z.string(), planCode: z.string(),
  goodsName: z.string(), goodsPrice: Money, financedAmount: Money, monthlyPayment: Money, termMonths: z.number().int(),
  buyerName: z.string().nullable(), buyerRegisterMasked: z.string(), buyerPhoneMasked: z.string(), publicReason: z.enum(PosPublicReason).nullable(),
});
export type PosLeaseListItem = z.infer<typeof PosLeaseListItem>;
const StatusCsv = z.preprocess((v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v), z.array(z.enum(PosLeaseStatus)).optional());
export const PosLeaseListQuery = z.object({ status: StatusCsv, storeId: Uuid.optional(), q: z.string().max(100).optional(), from: IsoDateTime.optional(), to: IsoDateTime.optional(), ...PageQuery });
export type PosLeaseListQuery = z.infer<typeof PosLeaseListQuery>;
export const PosLeaseAdminListQuery = PosLeaseListQuery.extend({ merchantId: Uuid.optional() });
export type PosLeaseAdminListQuery = z.infer<typeof PosLeaseAdminListQuery>;

// Лизингийн байгууллагын үйлдэл
export const PosLeaseReview = z.object({ decision: z.enum(['APPROVE', 'DECLINE']), comment: trimmed(z.string().min(3).max(500)) });
export type PosLeaseReview = z.infer<typeof PosLeaseReview>;
export const PosLeaseSettle = z.object({ settlementRef: trimmed(z.string().min(3).max(100)) });
export type PosLeaseSettle = z.infer<typeof PosLeaseSettle>;

// ───────────── Merchant Dashboard ─────────────
export const MerchantDashboardQuery = z.object({ from: IsoDateTime.optional(), to: IsoDateTime.optional(), storeId: Uuid.optional() });
export type MerchantDashboardQuery = z.infer<typeof MerchantDashboardQuery>;
export const MerchantDashboard = z.object({
  range: z.object({ from: IsoDateTime, to: IsoDateTime }),
  totals: z.object({
    requests: z.number().int(), approved: z.number().int(), referred: z.number().int(), declined: z.number().int(), accepted: z.number().int(), delivered: z.number().int(), settled: z.number().int(), cancelledOrExpired: z.number().int(),
    approvalRate: z.number().nullable(), conversionRate: z.number().nullable(), avgDecisionSeconds: z.number().nullable(),
    financedAmount: Money, goodsSalesAmount: Money, commissionAmount: Money, awaitingSettlementNet: Money, settledNet: Money,
  }),
  daily: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), requests: z.number().int(), approved: z.number().int(), financedAmount: Money })),
  byStore: z.array(z.object({ storeId: Uuid, storeName: z.string(), requests: z.number().int(), approved: z.number().int(), financedAmount: Money })),
  byPlan: z.array(z.object({ planCode: z.string(), requests: z.number().int(), approved: z.number().int(), financedAmount: Money })),
  todo: z.object({ awaitingOtp: z.number().int(), awaitingAcceptance: z.number().int(), awaitingDelivery: z.number().int(), referred: z.number().int() }),
  limits: z.object({ maxTicketAmount: Money, dailyLimitAmount: Money.nullable(), dailyUsedAmount: Money }),
  recent: z.array(PosLeaseListItem),
});
export type MerchantDashboard = z.infer<typeof MerchantDashboard>;

export const MerchantProfile = z.object({
  merchant: z.object({ id: Uuid, code: z.string(), name: z.string(), status: z.enum(MerchantStatus), maxTicketAmount: Money, dailyLimitAmount: Money.nullable() }),
  stores: z.array(z.object({ id: Uuid, code: z.string(), name: z.string() })),
  currentStoreId: Uuid.nullable(),
  role: z.enum(MerchantRole),
  plans: z.array(PlanView.pick({ id: true, code: true, name: true, goodsCategories: true, minAmount: true, maxAmount: true, termOptions: true, annualRate: true, feeRate: true, minDownPaymentRate: true, validFrom: true, validTo: true })),
});
export type MerchantProfile = z.infer<typeof MerchantProfile>;
