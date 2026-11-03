import { z } from 'zod';
import { InquirySource, ManualIncomeType } from './enums';
import { normalizeRegisterNo } from './customer';

// Модуль 3 · Лавлагаа (FR-3). kyc `/api/inquiry…` (origination → kyc, sync REST) ба origination `/api/applications/:id/inquiries…`-ийн гэрээ.
// Модуль 4 · Орлого (FR-4): kyc `/api/ndsh/salaries` ба origination `/api/applications/:id/income…`.
// Регистр зөвхөн хүсэлтийн body-д (kyc хадгалахгүй, лог-д бичихгүй — CLAUDE.md §6.5).

/** Зээлдэгч бүрт татах 11 лавлагаа (docs/03 InquirySource). */
export const INQUIRY_SOURCES = InquirySource;
export const InquiryWarningLevel = ['NONE', 'WARNING', 'RED'] as const;
export type InquiryWarningLevel = (typeof InquiryWarningLevel)[number];

/** Лавлагаа авах оролцогчид (FR-3): үндсэн, хамтран зээлдэгч, батлан даагч. Барьцаалагчаас лавлагаа авахгүй. */
export const INQUIRY_BORROWER_ROLES = ['PRIMARY', 'CO_BORROWER', 'GUARANTOR'] as const;

export const InquiryStatus = ['MISSING', 'FRESH', 'STALE'] as const;
export type InquiryStatus = (typeof InquiryStatus)[number];

const Id = z.string().trim().min(1).max(64);

/** FR-3.4 · хар жагсаалтын тулгалтыг origination хийж (өөрийн жагсаалт) kyc-д дамжуулна; kyc `BLACKLIST` мөрийг хадгална. Хориг байхгүй. */
export const InquiryBlacklistResult = z.object({
  hit: z.boolean(),
  reasons: z.array(z.object({ reasonCode: z.string(), listType: z.string() })).default([]),
});
export type InquiryBlacklistResult = z.infer<typeof InquiryBlacklistResult>;

export const InquiryFetchRequest = z.object({
  applicationId: Id,
  customerId: Id,
  registerNo: z.string().trim().min(1).transform(normalizeRegisterNo),
  /** `inquiry.stale_days` (FR-3.5) — kyc `expires_at`-ийг үүгээр тооцно */
  staleDays: z.number().int().positive().max(3650).default(30),
  /** Өгөхгүй бол 11-ийг бүгдийг */
  sources: z.array(z.enum(InquirySource)).min(1).optional(),
  blacklist: InquiryBlacklistResult.optional(),
});
export type InquiryFetchRequest = z.infer<typeof InquiryFetchRequest>;

/** kyc-ийн нэг лавлагаа. `summary` = summary_json (snake_case түлхүүр, docs/03); `detail` = гадаад системийн хариу (шифрлэгдэж хадгалагдана). */
export const InquiryRecord = z.object({
  id: z.string(),
  applicationId: z.string(),
  customerId: z.string(),
  source: z.enum(InquirySource),
  fetchedAt: z.string(),
  fetchedBy: z.string().nullable(),
  expiresAt: z.string().nullable(),
  warningLevel: z.enum(InquiryWarningLevel),
  summary: z.record(z.unknown()),
  detail: z.record(z.unknown()).nullable(),
});
export type InquiryRecord = z.infer<typeof InquiryRecord>;

/** Эх сурвалж тус бүрийн алдаа (бусад нь амжилттай хадгалагдсан). */
export const InquiryFetchFailure = z.object({ source: z.enum(InquirySource), code: z.string(), message: z.string() });
export type InquiryFetchFailure = z.infer<typeof InquiryFetchFailure>;

export const InquiryFetchResponse = z.object({ items: z.array(InquiryRecord), failures: z.array(InquiryFetchFailure) });
export type InquiryFetchResponse = z.infer<typeof InquiryFetchResponse>;

export const UnregisteredLoan = z.object({
  id: z.string(),
  customerId: z.string(),
  lenderName: z.string(),
  amount: z.number(),
  monthlyPayment: z.number(),
  note: z.string().nullable(),
});
export type UnregisteredLoan = z.infer<typeof UnregisteredLoan>;

/** FR-3.2 · ЗМС-д бүртгэлгүй зээл гараар. */
export const UnregisteredLoanInput = z.object({
  lenderName: z.string().trim().min(1, 'Заавал бөглөнө').max(200),
  amount: z.number().nonnegative().max(1e12),
  monthlyPayment: z.number().nonnegative().max(1e12),
  note: z.string().trim().max(500).optional(),
});
export type UnregisteredLoanInput = z.infer<typeof UnregisteredLoanInput>;
export const KycUnregisteredLoanRequest = UnregisteredLoanInput.extend({ applicationId: Id, customerId: Id });
export type KycUnregisteredLoanRequest = z.infer<typeof KycUnregisteredLoanRequest>;

/** kyc · `GET /api/inquiry?applicationId=&customerId=` — (харилцагч × эх сурвалж)-ийн хамгийн сүүлийн мөр + бүртгэлгүй зээл. */
export const InquiryListQuery = z.object({ applicationId: Id, customerId: Id.optional() });
export const InquiryListResponse = z.object({ items: z.array(InquiryRecord), unregisteredLoans: z.array(UnregisteredLoan) });
export type InquiryListResponse = z.infer<typeof InquiryListResponse>;

/**
 * Тооцоололд (Sosco Score, идэвхтэй өрийн төлбөр) хэрэгтэй ЗМС/FICO хураангуй. `null` = мэдэгдэхгүй (лавлагаа татаагүй) — зохиомол утга өгөхгүй.
 * `existingDebtServiceMonthly` = ЗМС идэвхтэй зээлийн сарын төлбөр + гараар оруулсан бүртгэлгүй зээлийн сарын төлбөр.
 */
export const CreditHistorySummary = z.object({
  ficoScore: z.number().nullable(),
  activeLoanCount: z.number().nullable(),
  overdueHistoryMonths: z.number().nullable(),
  existingDebtServiceMonthly: z.number().nullable(),
});
export type CreditHistorySummary = z.infer<typeof CreditHistorySummary>;

// ── origination · UI ──────────────────────────────────────────────────────────────────

export const InquiryFetchBody = z.object({
  /** Өгөхгүй бол лавлагаа авах бүх оролцогч */
  customerId: Id.optional(),
  sources: z.array(z.enum(InquirySource)).min(1).optional(),
});
export type InquiryFetchBody = z.infer<typeof InquiryFetchBody>;

export const InquiryItemView = z.object({
  source: z.enum(InquirySource),
  status: z.enum(InquiryStatus),
  fetchedAt: z.string().nullable(),
  /** fetchedAt + `inquiry.stale_days` */
  expiresAt: z.string().nullable(),
  warningLevel: z.enum(InquiryWarningLevel),
  summary: z.record(z.unknown()),
  detail: z.record(z.unknown()).nullable(),
});
export type InquiryItemView = z.infer<typeof InquiryItemView>;

export const InquiryBorrowerView = z.object({
  customerId: z.string(),
  role: z.enum(INQUIRY_BORROWER_ROLES),
  displayName: z.string(),
  registerNoMasked: z.string(),
  /** 11 лавлагаа бүгд байгаа ба хуучраагүй */
  complete: z.boolean(),
  hasStale: z.boolean(),
  missing: z.array(z.enum(InquirySource)),
  items: z.array(InquiryItemView),
  unregisteredLoans: z.array(UnregisteredLoan),
  /** ЗМС идэвхтэй зээл + бүртгэлгүй зээлийн сарын нийт төлбөр */
  monthlyDebtPayment: z.number(),
});
export type InquiryBorrowerView = z.infer<typeof InquiryBorrowerView>;

export const InquiryStepInfo = z.object({
  status: z.string().nullable(),
  /** `INQUIRY_MISSING` | `INQUIRY_STALE` | `NO_BORROWER` | null */
  reason: z.string().nullable(),
});

export const InquiriesResponse = z.object({
  staleDays: z.number(),
  borrowers: z.array(InquiryBorrowerView),
  complete: z.boolean(),
  step: InquiryStepInfo,
  /** `failures` нь зөвхөн татах дуудлагын хариуд */
  failures: z.array(z.object({ customerId: z.string(), source: z.enum(InquirySource).nullable(), code: z.string(), message: z.string() })).default([]),
});
export type InquiriesResponse = z.infer<typeof InquiriesResponse>;

export const InquiryErrorCode = ['APPLICATION_NOT_EDITABLE', 'INQUIRY_BORROWER_NOT_FOUND', 'REGISTER_UNAVAILABLE', 'XYP_UNAVAILABLE', 'INTEGRATION_NOT_IMPLEMENTED', 'UNREGISTERED_LOAN_NOT_FOUND'] as const;

// ── Орлого (FR-4) ──────────────────────────────────────────────────────────────────────

/** kyc · НДШ (`POST /api/ndsh/salaries`) */
export const NdshSalaryRequest = z.object({ registerNo: z.string().trim().min(1).transform(normalizeRegisterNo) });
export const NdshSalaryRow = z.object({
  employer: z.string(),
  year: z.number().int(),
  month: z.number().int().min(1).max(12),
  salary: z.number().nonnegative(),
  contributionPaid: z.number().nonnegative().nullable(),
});
export type NdshSalaryRow = z.infer<typeof NdshSalaryRow>;
export const NdshSalaryResponse = z.object({ fetchedAt: z.string(), items: z.array(NdshSalaryRow) });
export type NdshSalaryResponse = z.infer<typeof NdshSalaryResponse>;

const YearMonthStr = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Сар YYYY-MM хэлбэртэй');
const Money = z.number().nonnegative().max(1e12);

export const IncomeFetchNdshBody = z.object({ customerId: Id });
export type IncomeFetchNdshBody = z.infer<typeof IncomeFetchNdshBody>;
export const IncomeSalaryInput = z.object({
  customerId: Id,
  employer: z.string().trim().max(200).optional(),
  year: z.number().int().min(1990).max(2100),
  month: z.number().int().min(1).max(12),
  salary: z.number().positive().max(1e12),
  contributionPaid: Money.optional(),
});
export type IncomeSalaryInput = z.infer<typeof IncomeSalaryInput>;
export const IncomeCalculateBody = z.object({ customerId: Id, periodFrom: YearMonthStr, periodTo: YearMonthStr });
export type IncomeCalculateBody = z.infer<typeof IncomeCalculateBody>;
export const IncomeManualInput = z.object({
  customerId: Id,
  type: z.enum(ManualIncomeType),
  monthlyAmount: z.number().positive().max(1e12),
  fileId: Id.optional(),
  note: z.string().trim().max(500).optional(),
});
export type IncomeManualInput = z.infer<typeof IncomeManualInput>;
export const IncomeExpensesBody = z.object({ householdExpenseMonthly: Money.optional(), businessExpenseMonthly: Money.optional() })
  .refine((b) => b.householdExpenseMonthly !== undefined || b.businessExpenseMonthly !== undefined, { message: 'Дор хаяж нэг зардал оруулна уу' });
export type IncomeExpensesBody = z.infer<typeof IncomeExpensesBody>;

export const IncomeSalaryView = z.object({
  id: z.string(), employer: z.string().nullable(), year: z.number(), month: z.number(), salary: z.number(), contributionPaid: z.number().nullable(), source: z.enum(['NDSH', 'MANUAL']),
});
export type IncomeSalaryView = z.infer<typeof IncomeSalaryView>;
export const IncomeManualView = z.object({ id: z.string(), type: z.enum(ManualIncomeType), monthlyAmount: z.number(), fileId: z.string().nullable(), note: z.string().nullable() });
export type IncomeManualView = z.infer<typeof IncomeManualView>;
export const IncomeSummaryView = z.object({
  periodFrom: z.string().nullable(),
  periodTo: z.string().nullable(),
  months: z.number().nullable(),
  salaryTotal: z.number().nullable(),
  avgSalaryMonthly: z.number().nullable(),
  businessNcfMonthly: z.number().nullable(),
  householdExpenseMonthly: z.number().nullable(),
  businessExpenseMonthly: z.number().nullable(),
});
export type IncomeSummaryView = z.infer<typeof IncomeSummaryView>;
export const IncomeBorrowerView = z.object({
  customerId: z.string(),
  role: z.enum(['PRIMARY', 'CO_BORROWER']),
  /** Орлого нэгтгэдэг эсэх (үндсэн зээлдэгч үргэлж; хамтран зээлдэгч `income_included`) */
  included: z.boolean(),
  displayName: z.string(),
  salaries: z.array(IncomeSalaryView),
  manual: z.array(IncomeManualView),
  manualMonthlyTotal: z.number(),
  summary: IncomeSummaryView,
  hasIncome: z.boolean(),
  /** FR-4.2 · Модуль 12 (BSA) ирэх хүртэл идэвхгүй */
  business: z.object({ available: z.boolean(), message: z.string() }),
});
export type IncomeBorrowerView = z.infer<typeof IncomeBorrowerView>;
export const IncomeBlocker = z.object({ code: z.enum(['INCOME_MISSING', 'NO_PRIMARY_BORROWER']), step: z.literal('income'), customerId: z.string().nullable(), message: z.string() });
export type IncomeBlocker = z.infer<typeof IncomeBlocker>;
export const IncomeOverviewResponse = z.object({
  borrowers: z.array(IncomeBorrowerView),
  blockers: z.array(IncomeBlocker),
  step: z.object({ status: z.string().nullable(), reason: z.string().nullable() }),
});
export type IncomeOverviewResponse = z.infer<typeof IncomeOverviewResponse>;
export const IncomeErrorCode = ['APPLICATION_NOT_EDITABLE', 'INCOME_BORROWER_NOT_FOUND', 'INVALID_PERIOD', 'SALARY_NOT_FOUND', 'MANUAL_INCOME_NOT_FOUND', 'NDSH_UNAVAILABLE'] as const;
