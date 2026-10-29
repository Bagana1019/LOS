import { z } from 'zod';
import { RepaymentType } from './enums';

// Харилцагчийн өөртөө үйлчлэх портал (apps/portal-bff) — docs/05-portal-bff.md.
// Нэг схем хоёр үүрэгтэй: (1) mobile/web ↔ portal-bff REST хариу, (2) portal-bff ↔ origination дотоод
// (`/api/internal/portal/*`) гэрээ. Дотоод талын хариуг portal-bff zod-оор дахин шалгаж, үл мэдэх талбарыг хасна.
// Мөнгө numeric(18,2) → number (2 орон). Хувь нь нэрэндээ нэгжтэй: `...Percent` (23.99 = 23.99%).

export const PortalCurrency = z.enum(['MNT', 'USD']);
export type PortalCurrency = z.infer<typeof PortalCurrency>;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const isoDateTime = z.string().datetime({ offset: true });
const money = z.number().finite();

/** Дотоод ID (loan = loan_application.id, payment, session…). URL-д ордог тул хатуу хязгаарлана. */
export const PortalId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export type PortalId = z.infer<typeof PortalId>;

/** Хоёр орноос илүүгүй, эерэг, боломжийн дээд хязгаартай мөнгөн дүн (хүсэлтийн талд). */
export const PortalAmountInput = z
  .number()
  .finite()
  .positive()
  .max(1_000_000_000_000)
  .refine((v) => Math.round(v * 100) / 100 === v, 'at most 2 decimal places');

/** Регистр: 2 кирилл үсэг + 8 цифр. Том үсэгт хөрвүүлнэ. */
export const PortalRegisterNo = z
  .string()
  .trim()
  .transform((s) => s.toUpperCase())
  .pipe(z.string().regex(/^[А-ЯЁӨҮ]{2}\d{8}$/u, 'register format: 2 Cyrillic letters + 8 digits'));

/** Монгол утасны дугаар: 8 орон; +976 / 976 угтвар, зай, зураасыг хасна. */
export const PortalPhone = z
  .string()
  .trim()
  .transform((s) => s.replace(/[\s-]/g, '').replace(/^(\+976|976)(?=\d{8}$)/, ''))
  .pipe(z.string().regex(/^\d{8}$/, 'phone: 8 digits'));

// ───────────── Нэвтрэлт (OTP → JWT) ─────────────
export const PortalOtpRequest = z.object({ registerNo: PortalRegisterNo, phone: PortalPhone }).strict();
export type PortalOtpRequest = z.infer<typeof PortalOtpRequest>;

export const PortalOtpChallenge = z.object({
  challengeId: z.string(),
  maskedDestination: z.string(),
  expiresInSec: z.number().int(),
  resendAfterSec: z.number().int(),
});
export type PortalOtpChallenge = z.infer<typeof PortalOtpChallenge>;

export const PortalOtpVerify = z
  .object({ challengeId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/), code: z.string().regex(/^\d{6}$/) })
  .strict();
export type PortalOtpVerify = z.infer<typeof PortalOtpVerify>;

export const PortalRefreshRequest = z.object({ refreshToken: z.string().min(20).max(256) }).strict();
export type PortalRefreshRequest = z.infer<typeof PortalRefreshRequest>;

export const PortalTokens = z.object({
  tokenType: z.literal('Bearer'),
  accessToken: z.string(),
  expiresInSec: z.number().int(),
  refreshToken: z.string(),
  refreshExpiresInSec: z.number().int(),
});
export type PortalTokens = z.infer<typeof PortalTokens>;

export const PortalProfile = z.object({ displayName: z.string(), phoneMasked: z.string() });
export type PortalProfile = z.infer<typeof PortalProfile>;

/** origination дотоод: нэвтрэх үед регистр+утас → харилцагч (идэвхтэй/хаагдсан зээлтэй). */
export const PortalCustomerLookup = z.object({ customerId: PortalId, displayName: z.string() });
export type PortalCustomerLookup = z.infer<typeof PortalCustomerLookup>;

// ───────────── Зээл, үлдэгдэл ─────────────
export const PortalLoanStatus = z.enum(['ACTIVE', 'CLOSED']);
export type PortalLoanStatus = z.infer<typeof PortalLoanStatus>;

export const PortalNextInstallment = z.object({
  seq: z.number().int().positive(),
  dueDate: isoDate,
  principal: money,
  interest: money,
  total: money,
  /** Хэсэгчлэн төлсөн бол үлдсэн төлөх дүн (total − paid). */
  amountDue: money,
});
export type PortalNextInstallment = z.infer<typeof PortalNextInstallment>;

export const PortalLoanSummary = z.object({
  loanId: PortalId,
  contractNo: z.string(),
  productName: z.string(),
  currency: PortalCurrency,
  status: PortalLoanStatus,
  principalAmount: money,
  annualInterestRatePercent: z.number().finite(),
  termMonths: z.number().int().positive(),
  disbursedAt: isoDate.nullable(),
  maturityDate: isoDate.nullable(),
  outstandingPrincipal: money,
  overdueAmount: money,
  overdueDays: z.number().int().nonnegative(),
  nextInstallment: PortalNextInstallment.nullable(),
});
export type PortalLoanSummary = z.infer<typeof PortalLoanSummary>;

export const PortalLoanDetail = PortalLoanSummary.extend({
  repaymentType: z.enum(RepaymentType),
  firstPaymentDate: isoDate.nullable(),
  contractAvailable: z.boolean(),
});
export type PortalLoanDetail = z.infer<typeof PortalLoanDetail>;

export const PortalLoanBalance = z.object({
  loanId: PortalId,
  currency: PortalCurrency,
  asOf: isoDateTime,
  outstandingPrincipal: money,
  accruedInterest: money,
  accruedPenalty: money,
  overdue: z.object({ principal: money, interest: money, penalty: money, total: money, days: z.number().int().nonnegative() }),
  nextInstallment: PortalNextInstallment.nullable(),
  /** Зээлийг өнөөдөр бүрэн хаах дүн (үндсэн + хүү + торгууль). */
  payoff: z.object({ amount: money, validUntil: isoDate }),
});
export type PortalLoanBalance = z.infer<typeof PortalLoanBalance>;

// ───────────── Эргэн төлөлтийн хуваарь (FR-7.2 баганууд) ─────────────
export const PortalScheduleRowStatus = z.enum(['PAID', 'PARTIALLY_PAID', 'DUE', 'OVERDUE', 'UPCOMING']);
export type PortalScheduleRowStatus = z.infer<typeof PortalScheduleRowStatus>;

export const PortalScheduleRow = z.object({
  seq: z.number().int().positive(),
  dueDate: isoDate,
  days: z.number().int().nonnegative(),
  principal: money,
  interest: money,
  total: money,
  /** Төлбөрийн дараах зээлийн үлдэгдэл (ЭТХ-ийн «үлдэгдэл» багана). */
  balance: money,
  paidAmount: money,
  paidAt: isoDate.nullable(),
  status: PortalScheduleRowStatus,
});
export type PortalScheduleRow = z.infer<typeof PortalScheduleRow>;

export const PortalSchedule = z.object({
  loanId: PortalId,
  currency: PortalCurrency,
  generatedAt: isoDateTime,
  rows: z.array(PortalScheduleRow),
  totals: z.object({ principal: money, interest: money, total: money, paid: money }),
});
export type PortalSchedule = z.infer<typeof PortalSchedule>;

// ───────────── Гэрээ ─────────────
export const PortalContractInfo = z.object({
  loanId: PortalId,
  contractNo: z.string(),
  signed: z.boolean(),
  signedAt: isoDateTime.nullable(),
  fileName: z.string(),
  mime: z.literal('application/pdf'),
  sizeBytes: z.number().int().nonnegative().nullable(),
});
export type PortalContractInfo = z.infer<typeof PortalContractInfo>;

// ───────────── Төлбөр ─────────────
export const PortalPaymentMethod = z.enum(['QPAY', 'SOCIALPAY', 'BANK_ACCOUNT']);
export type PortalPaymentMethod = z.infer<typeof PortalPaymentMethod>;

export const PortalPaymentAmountType = z.enum(['INSTALLMENT', 'OVERDUE', 'PAYOFF', 'CUSTOM']);
export type PortalPaymentAmountType = z.infer<typeof PortalPaymentAmountType>;

export const PortalPaymentStatus = z.enum(['PENDING', 'PAID', 'FAILED', 'EXPIRED', 'CANCELLED']);
export type PortalPaymentStatus = z.infer<typeof PortalPaymentStatus>;

/** `amount` нь зөвхөн CUSTOM үед; бусад төрөлд сервер дүнг өөрөө тодорхойлно (клиентэд итгэхгүй). */
export const PortalCreatePayment = z
  .object({ amountType: PortalPaymentAmountType, amount: PortalAmountInput.optional(), method: PortalPaymentMethod })
  .strict()
  .superRefine((v, ctx) => {
    if (v.amountType === 'CUSTOM' && v.amount === undefined) {
      ctx.addIssue({ code: 'custom', path: ['amount'], message: 'amount is required for CUSTOM' });
    }
    if (v.amountType !== 'CUSTOM' && v.amount !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['amount'], message: 'amount is only allowed for CUSTOM' });
    }
  });
export type PortalCreatePayment = z.infer<typeof PortalCreatePayment>;

/** portal-bff → origination: дүн тодорхойлогдсон тушаал. Idempotency-Key толгойгоор дамжина. */
export const PortalCreatePaymentCommand = z.object({
  loanId: PortalId,
  method: PortalPaymentMethod,
  amountType: PortalPaymentAmountType,
  amount: PortalAmountInput,
  currency: PortalCurrency,
});
export type PortalCreatePaymentCommand = z.infer<typeof PortalCreatePaymentCommand>;

export const PortalPaymentCheckout = z.object({
  qrText: z.string().max(4096).nullable(),
  deeplinks: z.array(z.object({ name: z.string(), description: z.string().nullable(), link: z.string().max(2048) })).max(32),
  webUrl: z.string().regex(/^https:\/\//, 'https only').max(2048).nullable(),
});
export type PortalPaymentCheckout = z.infer<typeof PortalPaymentCheckout>;

export const PortalPayment = z.object({
  paymentId: PortalId,
  loanId: PortalId,
  method: PortalPaymentMethod,
  amountType: PortalPaymentAmountType,
  amount: money,
  currency: PortalCurrency,
  status: PortalPaymentStatus,
  createdAt: isoDateTime,
  expiresAt: isoDateTime.nullable(),
  paidAt: isoDateTime.nullable(),
  /** Зээлийн дансанд (Core) тусгагдсан цаг; PAID боловч null бол тусгал хүлээгдэж байна. */
  postedAt: isoDateTime.nullable(),
  failureReason: z.string().nullable(),
  /** Зөвхөн PENDING үед. */
  checkout: PortalPaymentCheckout.nullable(),
});
export type PortalPayment = z.infer<typeof PortalPayment>;

/** Хуудаслалтын cursor: тунгалаг (opaque) тэмдэгт мөр. Хариу ба хүсэлтэд ижил хэлбэр — буцаасан cursor-ыг шууд дахин илгээж болно. */
export const PortalCursor = z.string().regex(/^[A-Za-z0-9_=.-]{1,256}$/);
export type PortalCursor = z.infer<typeof PortalCursor>;

export const PortalPaymentList = z.object({ items: z.array(PortalPayment), nextCursor: PortalCursor.nullable() });
export type PortalPaymentList = z.infer<typeof PortalPaymentList>;

export const PortalPaymentListQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: PortalCursor.optional(),
  })
  .strict();
export type PortalPaymentListQuery = z.infer<typeof PortalPaymentListQuery>;

export const PortalPaymentMethodLimit = z.object({
  method: PortalPaymentMethod,
  minAmount: money,
  maxAmount: money,
});
export type PortalPaymentMethodLimit = z.infer<typeof PortalPaymentMethodLimit>;

export const PortalPaymentOptions = z.object({
  loanId: PortalId,
  currency: PortalCurrency,
  installment: z.object({ seq: z.number().int().positive(), dueDate: isoDate, amount: money }).nullable(),
  overdue: z.object({ amount: money, days: z.number().int().nonnegative() }).nullable(),
  payoff: z.object({ amount: money, validUntil: isoDate }),
  methods: z.array(PortalPaymentMethodLimit),
});
export type PortalPaymentOptions = z.infer<typeof PortalPaymentOptions>;

// ───────────── Алдааны гэрээ ─────────────
export const PortalErrorCode = z.enum([
  'INVALID_REQUEST',
  'PAYLOAD_TOO_LARGE',
  'NOT_FOUND',
  'UNAUTHENTICATED',
  'RATE_LIMITED',
  'OTP_INVALID',
  'OTP_EXPIRED',
  'OTP_ATTEMPTS_EXCEEDED',
  'LOAN_NOT_FOUND',
  'PAYMENT_NOT_FOUND',
  'CONTRACT_NOT_AVAILABLE',
  'LOAN_NOT_PAYABLE',
  'NO_OVERDUE',
  'AMOUNT_OUT_OF_RANGE',
  'METHOD_NOT_AVAILABLE',
  'IDEMPOTENCY_KEY_REQUIRED',
  'IDEMPOTENCY_KEY_REUSED',
  'REQUEST_IN_PROGRESS',
  'DOWNSTREAM_UNAVAILABLE',
  'DOWNSTREAM_INVALID_RESPONSE',
  'INTERNAL',
]);
export type PortalErrorCode = z.infer<typeof PortalErrorCode>;

export const PortalErrorBody = z.object({
  error: z.object({
    code: PortalErrorCode,
    /** Харилцагчид харуулах монгол мессеж. Логик код дээр `code`-оор салгана. */
    message: z.string(),
    correlationId: z.string(),
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
});
export type PortalErrorBody = z.infer<typeof PortalErrorBody>;
