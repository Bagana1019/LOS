import { z } from 'zod';
import { BsaSummary } from './dto';
import { BsaChannel, BsaDtiRole, BsaRuleMatchType, BsaRuleSource, BsaStatus, ImportStatus, ReviewAction, ReviewStatus, SuspicionFlag, TxnDirection } from './enums';

// BSA (docs/02-bsa-requirements.md) — enum болон service хоорондын гэрээ. Enum-ийг өөр газар давтахгүй.

/** Хуулгын файлын хэлбэр (bsa_import_job.format). Persistence port болон REST хоёулаа энэ ганц эхийг ашиглана */
export const ImportFormat = ['PDF', 'IMAGE', 'CSV', 'TEXT'] as const;
export type ImportFormat = typeof ImportFormat[number];

/** BSA-BR-6: заавал дэмжих 7 банк */
export const BankCode = ['KHAN', 'GOLOMT', 'TDB', 'XAC', 'CAPITRON', 'STATE', 'MBANK'] as const;
export type BankCode = typeof BankCode[number];

/** BSA-FR-4.2: Бага/Дунд/Өндөр (завсар admin-д) */
export const DtiLevel = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type DtiLevel = typeof DtiLevel[number];

/**
 * BSA → Тооцоолол (scoring) руу өгөх оролт. `ScoreRequest` (businessNcfMonthly, existingDebtServiceMonthly,
 * householdExpenseMonthly) ба `SoscoInput` (dtiPercent, incomeReliability, pendingSuspiciousCount)-ийг
 * бөглөхөд хэрэглэнэ. docs/02 INT-4 / INT-5.
 */
export const BsaScoringInput = z.object({
  analysisId: z.string(),
  loanApplicationId: z.string(),
  borrowerId: z.string(),
  version: z.number().int(),
  status: z.enum(BsaStatus),
  periodMonths: z.number(),
  transactionCount: z.number().int(),
  /** Дайчилсан (жинлэсэн) бизнесийн орлого, сарын дундаж */
  businessIncomeMonthly: z.number(),
  businessExpenseMonthly: z.number(),
  /** ЦМУ = businessIncomeMonthly − businessExpenseMonthly (ScoreRequest.businessNcfMonthly) */
  businessNcfMonthly: z.number(),
  householdExpenseMonthly: z.number(),
  existingDebtServiceMonthly: z.number(),
  verifiedMonthlyIncome: z.number(),
  dtiIncomeMonthly: z.number(),
  /** % (6.8 = 6.8%) — BsaSummary.dtiPercent-тэй ижил нэгж */
  dtiPercent: z.number(),
  incomeReliability: z.number(),
  pendingSuspiciousCount: z.number().int(),
});
export type BsaScoringInput = z.infer<typeof BsaScoringInput>;


// ───────────────────────── REST DTO (BSA шинжилгээний application service-ийн хүсэлт/хариу) ─────────────────────────
// Controller-ууд эдгээр схемээр оролтыг шалгана; service-ууд зөвхөн шалгагдсан төрлийг хүлээн авна. Мөнгө/хувь нэгж BsaSummary-тай ижил.

const IsoDate = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'YYYY-MM-DD');
const Id = z.string().min(1).max(128);
const Money = z.number().finite().min(0).max(9e13);
/** BSA-BR-1: ББӨ 0..1 */
const Ratio = z.number().finite().min(0).max(1);

/** BSA-FR-1.1: харилцагчийн урьдчилан мэдэгдсэн данс (BSA-BR-5 «өөрийн данс»-д орно) */
export const BsaDeclaredAccountInput = z.object({
  bankCode: z.enum(BankCode).nullish(),
  accountNo: z.string().trim().min(4).max(64),
  iban: z.string().trim().max(64).nullish(),
  holderName: z.string().trim().max(200).nullish(),
});
export type BsaDeclaredAccountInput = z.infer<typeof BsaDeclaredAccountInput>;

export const BsaCustomerInput = z.object({
  registerNo: z.string().trim().min(4).max(32),
  lastName: z.string().trim().max(100).nullish(),
  firstName: z.string().trim().max(100).nullish(),
  phone: z.string().trim().max(32).nullish(),
  gender: z.string().trim().max(16).nullish(),
  note: z.string().trim().max(1000).nullish(),
  declaredAccounts: z.array(BsaDeclaredAccountInput).max(20).default([]),
});
export type BsaCustomerInput = z.infer<typeof BsaCustomerInput>;

/** BSA-BR-3: хугацаа = сарын тоо (БҮТЭН сар, зөвшөөрөгдсөн жагсаалтаас) ЭСВЭЛ [periodFrom, periodTo] — хоёуланг нь өгөхгүй */
const periodRefine = (v: { periodMonths?: number | null; periodFrom?: string | null; periodTo?: string | null }, ctx: z.RefinementCtx): void => {
  const hasMonths = v.periodMonths !== undefined && v.periodMonths !== null;
  const hasFrom = v.periodFrom !== undefined && v.periodFrom !== null;
  const hasTo = v.periodTo !== undefined && v.periodTo !== null;
  if (hasMonths && (hasFrom || hasTo)) ctx.addIssue({ code: 'custom', path: ['periodMonths'], message: 'periodMonths and periodFrom/periodTo are mutually exclusive' });
  if (hasFrom !== hasTo) ctx.addIssue({ code: 'custom', path: [hasFrom ? 'periodTo' : 'periodFrom'], message: 'periodFrom and periodTo must be given together' });
  if (hasFrom && hasTo && (v.periodFrom as string) > (v.periodTo as string)) {
    ctx.addIssue({ code: 'custom', path: ['periodFrom'], message: 'periodFrom must not be after periodTo' });
  }
};

const periodFields = {
  periodMonths: z.number().int().min(1).max(120).nullish(),
  periodFrom: IsoDate.nullish(),
  periodTo: IsoDate.nullish(),
};

/** INT-1 / INT-7: шинэ шинжилгээ (хувилбар) үүсгэх. `branchId`-г зөвхөн ADMIN өгч болно (бусад нь өөрийн салбар) */
export const BsaCreateAnalysisRequest = z
  .object({
    loanApplicationId: Id,
    customerId: Id,
    borrowerId: Id.nullish(),
    branchId: Id.nullish(),
    customer: BsaCustomerInput,
    ...periodFields,
    /** BSA-FR-4.8: ЭТХ-ээс санал болгосон сарын төлбөр */
    proposedMonthlyPayment: Money.nullish(),
    /** BSA-BR-1: өгөхгүй бол тохиргооны ББӨ */
    costOfGoodsRate: Ratio.nullish(),
  })
  .superRefine(periodRefine);
export type BsaCreateAnalysisRequest = z.infer<typeof BsaCreateAnalysisRequest>;

/** INT-6 / BSA-FR-4.1: параметр өөрчлөх → дахин тооцоо. `null` = хоослох (хугацаа/ББӨ-г анхдагч руу буцаах) */
export const BsaUpdateAnalysisParamsRequest = z
  .object({
    proposedMonthlyPayment: Money.nullish(),
    ...periodFields,
    costOfGoodsRate: Ratio.nullish(),
  })
  .superRefine(periodRefine);
export type BsaUpdateAnalysisParamsRequest = z.infer<typeof BsaUpdateAnalysisParamsRequest>;

/** BSA-FR-3.3 / 3.4 */
export const BsaSimilarBy = ['DESCRIPTION', 'COUNTERPARTY'] as const;
export type BsaSimilarBy = typeof BsaSimilarBy[number];
export const BsaReclassifyRequest = z.object({
  transactionIds: z.array(Id).min(1).max(1000),
  categoryCode: z.string().trim().min(1).max(64),
  applyToSimilar: z.boolean().default(false),
  similarBy: z.enum(BsaSimilarBy).default('DESCRIPTION'),
});
export type BsaReclassifyRequest = z.infer<typeof BsaReclassifyRequest>;

/** BSA-FR-3.5 (ADMIN) ба 3.4 (санал болгосон FEEDBACK дүрмийг админ баталгаажуулан хадгалах) */
export const BsaCreateRuleRequest = z.object({
  direction: z.enum(TxnDirection),
  matchType: z.enum(BsaRuleMatchType),
  pattern: z.string().trim().min(1).max(200),
  categoryCode: z.string().trim().min(1).max(64),
  priority: z.number().int().min(0).max(100_000),
  source: z.enum(BsaRuleSource).default('ADMIN'),
});
export type BsaCreateRuleRequest = z.infer<typeof BsaCreateRuleRequest>;

/** BSA-FR-2.1: нэг файлын хүлээн авалтын үр дүн (индекс = upload дахь дараалал; файлын нэр/PII буцаахгүй) */
export const BsaUploadOutcome = z.discriminatedUnion('status', [
  z.object({ index: z.number().int().min(0), status: z.literal('ACCEPTED'), jobId: z.string(), format: z.enum(ImportFormat) }),
  z.object({ index: z.number().int().min(0), status: z.literal('DUPLICATE'), existingJobId: z.string() }),
  z.object({ index: z.number().int().min(0), status: z.literal('REJECTED'), code: z.string(), message: z.string(), jobId: z.string().optional() }),
]);
export type BsaUploadOutcome = z.infer<typeof BsaUploadOutcome>;

/** BSA-FR-4.2 / 4.3 / 4.5: дэлгэрэнгүй тайлан. `BsaSummary` (INT-4)-д ОРОХГҮЙ нэмэлт хэсэг — шинжилгээний дэлгэц, тайланд */
export const BsaAnalysisWarning = z.object({ code: z.string(), message: z.string() });
export type BsaAnalysisWarning = z.infer<typeof BsaAnalysisWarning>;

export const BsaCoverageDetail = z.object({
  /** Шаардсан хамрах хугацаа (хуанлийн сараар): max(minStatementMonths, шинжилгээний сар) */
  requiredFrom: z.string(),
  requiredTo: z.string(),
  requiredMonths: z.number().int(),
  coveredMonths: z.number().int(),
  /** «N сарын хуулга дутуу» */
  shortfallMonths: z.number().int(),
  missingMonths: z.array(z.string()),
  gaps: z.array(z.object({ from: z.string(), to: z.string(), account: z.string().optional() })),
  accountGaps: z.array(z.object({ from: z.string(), to: z.string(), account: z.string().optional() })),
  overlaps: z.array(z.object({ from: z.string(), to: z.string(), accounts: z.array(z.string()) })),
});
export type BsaCoverageDetail = z.infer<typeof BsaCoverageDetail>;

export const BsaAnalysisDetails = z.object({
  analysisId: z.string(),
  computedAt: z.string().datetime(),
  period: z.object({
    from: z.string(),
    to: z.string(),
    months: z.number(),
    /** MONTHS: сарын тоогоор · EXPLICIT: огноогоор · AUTO: анхдагч (хуулгын сүүлийн огноо хүртэл) */
    mode: z.enum(['MONTHS', 'EXPLICIT', 'AUTO']),
    requestedMonths: z.number().int().nullable(),
    /** Хүссэн хугацаа хуулгын хамрах хугацаанаас хэтэрсэн тул богиносгосон */
    clamped: z.boolean(),
  }),
  coverage: BsaCoverageDetail,
  /** BSA-BR-7 */
  otherShare: z.array(z.object({ direction: z.enum(TxnDirection), otherAmount: z.number(), totalAmount: z.number(), share: z.number(), exceeded: z.boolean() })),
  warnings: z.array(BsaAnalysisWarning),
  transactions: z.object({ inPeriod: z.number().int(), ownTransfers: z.number().int(), outOfPeriod: z.number().int(), manualOverrides: z.number().int() }),
  dti: z.object({
    dtiRatio: z.number().nullable(),
    meetsLimit: z.boolean(),
    maxDti: z.number(),
    costOfGoodsRate: z.number(),
    proposedMonthlyPayment: z.number(),
    householdExpenseMonthly: z.number(),
  }),
  categories: z.array(
    z.object({
      code: z.string(),
      name: z.string(),
      direction: z.enum(TxnDirection),
      groupCode: z.string(),
      weight: z.number(),
      dtiRole: z.enum(BsaDtiRole),
      totalAmount: z.number(),
      monthlyAvg: z.number(),
      weightedMonthly: z.number(),
      monthsPresent: z.number().int(),
      txnCount: z.number().int(),
      share: z.number(),
    }),
  ),
  methodology: z.array(
    z.object({ step: z.number().int(), key: z.string(), label: z.string(), formula: z.string(), inputs: z.record(z.union([z.number(), z.string()])), value: z.number() }),
  ),
});
export type BsaAnalysisDetails = z.infer<typeof BsaAnalysisDetails>;


// ───────────────────────── REST (HTTP давхарга): query / body / хариу ─────────────────────────
// `apps/scoring`-ийн controller-ууд эдгээр схемээр `req.query` / `req.body` / `req.params`-ийг шалгана. Query-ийн утга үргэлж мөр тул
// preprocess-ээр тоо / boolean / жагсаалт болгоно. Бүх объект `.strict()`: үл мэдэгдэх түлхүүр (бичгийн алдаа) чимээгүй алдагдахгүй, 400 болно.

const blankToUndefined = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const queryNumber = (v: unknown): unknown => {
  const x = blankToUndefined(v);
  return typeof x === 'string' && /^-?\d+(\.\d+)?$/.test(x.trim()) ? Number(x) : x;
};

const queryBoolean = (v: unknown): unknown => {
  const x = blankToUndefined(v);
  if (typeof x !== 'string') return x;
  const s = x.trim().toLowerCase();
  return s === 'true' || s === '1' ? true : s === 'false' || s === '0' ? false : x;
};

/** `a,b` эсвэл давтсан `?x=a&x=b` -> ['a', 'b'] (хоосон хэсгийг хасна) */
const queryList = (v: unknown): unknown => {
  const x = blankToUndefined(v);
  if (x === undefined) return undefined;
  const parts = (Array.isArray(x) ? x : [x])
    .flatMap((p) => (typeof p === 'string' ? p.split(',') : [p]))
    .map((p) => (typeof p === 'string' ? p.trim() : p))
    .filter((p) => p !== '');
  return parts.length === 0 ? undefined : parts;
};

/** multipart текст талбар дахь JSON; задрахгүй бол эх мөрийг буцаана (схем татгалзана) */
const jsonText = (v: unknown): unknown => {
  const x = blankToUndefined(v);
  if (typeof x !== 'string') return x;
  try {
    return JSON.parse(x);
  } catch {
    return x;
  }
};

/** Жагсаалтын хуудаслалт: нэг хуудсанд анхдагч / дээд (техникийн хязгаар, бизнесийн босго БИШ) */
export const BSA_API_PAGE_SIZE_DEFAULT = 50;
export const BSA_API_PAGE_SIZE_MAX = 200;
/** Гүйлгээний жагсаалтын нэг хуудсын дээд (persistence MAX_PAGE_SIZE-тай нийцнэ) */
export const BSA_API_TXN_LIMIT_MAX = 1000;

const optionalText = (max: number, min = 1) => z.preprocess(blankToUndefined, z.string().trim().min(min).max(max).optional());
const optionalId = z.preprocess(blankToUndefined, Id.optional());
const optionalDate = z.preprocess(blankToUndefined, IsoDate.optional());
const optionalAmount = z.preprocess(queryNumber, Money.optional());
const optionalBool = z.preprocess(queryBoolean, z.boolean().optional());

const pageFields = {
  page: z.preprocess(queryNumber, z.number().int().min(1).max(1_000_000).default(1)),
  pageSize: z.preprocess(queryNumber, z.number().int().min(1).max(BSA_API_PAGE_SIZE_MAX).default(BSA_API_PAGE_SIZE_DEFAULT)),
};

/** Path параметр (шинжилгээ / ажлын id): UUID болон тоон id хоёуланд таарна, зам/удирдлагын тэмдэгт татгалзана */
export const BsaIdParam = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/, 'id');

/** GET /bsa/analyses (BSA-FR-6.1). `createdTo` нь тухайн өдрийг ОРУУЛНА (UTC) */
export const BsaAnalysisListQuery = z
  .object({
    status: z.preprocess(blankToUndefined, z.enum(BsaStatus).optional()),
    applicationId: optionalId,
    customerId: optionalId,
    /** BSA-FR-1.2: регистрээр хайх. АНХААР: PII URL-д орно — gateway query string-ийг логлохгүй байх */
    registerNo: optionalText(32, 4),
    /** ADMIN / APPROVER-д салбараар нарийвчлах (бусдад өөрийн салбар албадан) */
    branchId: optionalId,
    createdFrom: optionalDate,
    createdTo: optionalDate,
    ...pageFields,
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.createdFrom !== undefined && v.createdTo !== undefined && v.createdFrom > v.createdTo) {
      ctx.addIssue({ code: 'custom', path: ['createdFrom'], message: 'createdFrom must not be after createdTo' });
    }
  });
export type BsaAnalysisListQuery = z.infer<typeof BsaAnalysisListQuery>;

/** GET /bsa/jobs (BSA-FR-2.6): `status` нь `a,b` жагсаалт байж болно; `bank` = BankCode */
export const BsaJobListQuery = z
  .object({
    status: z.preprocess(queryList, z.array(z.enum(ImportStatus)).max(ImportStatus.length).optional()),
    bank: z.preprocess(blankToUndefined, z.enum(BankCode).optional()),
    analysisId: optionalId,
    branchId: optionalId,
    ...pageFields,
  })
  .strict();
export type BsaJobListQuery = z.infer<typeof BsaJobListQuery>;

/** GET /bsa/analyses/:id/imports */
export const BsaAnalysisImportsQuery = z
  .object({
    status: z.preprocess(queryList, z.array(z.enum(ImportStatus)).max(ImportStatus.length).optional()),
    ...pageFields,
  })
  .strict();
export type BsaAnalysisImportsQuery = z.infer<typeof BsaAnalysisImportsQuery>;

export const BsaTransactionSort = ['DATE_ASC', 'DATE_DESC', 'AMOUNT_ASC', 'AMOUNT_DESC'] as const;
export type BsaTransactionSort = typeof BsaTransactionSort[number];

/** GET /bsa/analyses/:id/transactions (BSA-FR-4.6). Бүх нөхцөл AND, хоёр захыг оролцуулна */
export const BsaTransactionListQuery = z
  .object({
    importJobId: optionalId,
    dateFrom: optionalDate,
    dateTo: optionalDate,
    direction: z.preprocess(blankToUndefined, z.enum(TxnDirection).optional()),
    /** `category=SALARY,BUSINESS_INCOME` эсвэл давтсан параметр */
    category: z.preprocess(queryList, z.array(z.string().min(1).max(64)).max(50).optional()),
    channel: z.preprocess(queryList, z.array(z.enum(BsaChannel)).max(BsaChannel.length).optional()),
    ownTransfer: optionalBool,
    manualOverride: optionalBool,
    amountMin: optionalAmount,
    amountMax: optionalAmount,
    /** Утга / харьцсан нэр / дансаар хайх (том жижиг үсэг үл ялгана) */
    text: optionalText(100),
    sort: z.preprocess(blankToUndefined, z.enum(BsaTransactionSort).default('DATE_ASC')),
    limit: z.preprocess(queryNumber, z.number().int().min(1).max(BSA_API_TXN_LIMIT_MAX).default(BSA_API_PAGE_SIZE_DEFAULT)),
    offset: z.preprocess(queryNumber, z.number().int().min(0).max(10_000_000).default(0)),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.dateFrom !== undefined && v.dateTo !== undefined && v.dateFrom > v.dateTo) {
      ctx.addIssue({ code: 'custom', path: ['dateFrom'], message: 'dateFrom must not be after dateTo' });
    }
    if (v.amountMin !== undefined && v.amountMax !== undefined && v.amountMin > v.amountMax) {
      ctx.addIssue({ code: 'custom', path: ['amountMin'], message: 'amountMin must not be greater than amountMax' });
    }
  });
export type BsaTransactionListQuery = z.infer<typeof BsaTransactionListQuery>;

/** GET /bsa/analyses/:id/history */
export const BsaHistoryQuery = z
  .object({
    limit: z.preprocess(queryNumber, z.number().int().min(1).max(BSA_API_PAGE_SIZE_MAX).default(BSA_API_PAGE_SIZE_DEFAULT)),
    offset: z.preprocess(queryNumber, z.number().int().min(0).max(10_000_000).default(0)),
  })
  .strict();
export type BsaHistoryQuery = z.infer<typeof BsaHistoryQuery>;

/** GET /bsa/analyses/:id/breakdown: гүйлгээгүй ангилалыг (txnCount = 0) оруулах эсэх */
export const BsaBreakdownQuery = z.object({ includeEmpty: z.preprocess(queryBoolean, z.boolean().default(false)) }).strict();
export type BsaBreakdownQuery = z.infer<typeof BsaBreakdownQuery>;

/** GET /bsa/categories */
export const BsaCategoryListQuery = z.object({ includeInactive: z.preprocess(queryBoolean, z.boolean().default(false)) }).strict();
export type BsaCategoryListQuery = z.infer<typeof BsaCategoryListQuery>;

/**
 * POST /bsa/analyses/:id/imports: файлын бус multipart талбар. `banks` нь файл бүрийн банкийг гараар заана (автомат таних дарагдана):
 * массив (`["KHAN", null, "TDB"]`, индекс = файлын дараалал) эсвэл индексээр объект (`{"0": "KHAN", "2": "TDB"}`), JSON мөр хэлбэрээр.
 */
export const BsaUploadBanks = z.union([
  z.array(z.enum(BankCode).nullable()).max(1000),
  z.record(z.string().regex(/^\d{1,4}$/), z.enum(BankCode)),
]);
export type BsaUploadBanks = z.infer<typeof BsaUploadBanks>;
export const BsaUploadFields = z.object({ banks: z.preprocess(jsonText, BsaUploadBanks.optional()) }).strict();
export type BsaUploadFields = z.infer<typeof BsaUploadFields>;

/** POST /bsa/jobs/:id/retry: `bankCode` өгвөл банкийг солино; `null` = автомат таниулах; өгөөгүй бол өмнөх хэвээр */
export const BsaRetryJobRequest = z.object({ bankCode: z.enum(BankCode).nullish() }).strict();
export type BsaRetryJobRequest = z.infer<typeof BsaRetryJobRequest>;

/**
 * POST /bsa/analyses/:id/recalculate (INT-6, BSA-FR-4.1). Талбар өгвөл параметрийг өөрчилж DTI-г дахин бодно (`null` = анхдагч руу буцаах);
 * хоосон биш бие өгөөгүй бол ангиллыг ч дахин хийж бүгдийг дахин тооцоолно.
 */
export const BsaRecalculateRequest = z
  .object({
    proposedMonthlyPayment: Money.nullish(),
    ...periodFields,
    costOfGoodsRate: Ratio.nullish(),
  })
  .strict()
  .superRefine(periodRefine);
export type BsaRecalculateRequest = z.infer<typeof BsaRecalculateRequest>;

/** POST /bsa/rules (ADMIN): `analysisId` өгвөл тэр шинжилгээг шинэ дүрмээр дахин ангилна */
export const BsaCreateRuleHttpRequest = BsaCreateRuleRequest.extend({ analysisId: Id.optional() }).strict();
export type BsaCreateRuleHttpRequest = z.infer<typeof BsaCreateRuleHttpRequest>;

/** POST /bsa/admin/retention/run (ADMIN): нэг гүйлтэд устгах шинжилгээний дээд тоо (өгөөгүй бол тохиргооны багц) */
export const BsaRetentionRunRequest = z.object({ limit: z.number().int().min(1).max(10_000).optional() }).strict();
export type BsaRetentionRunRequest = z.infer<typeof BsaRetentionRunRequest>;

/** Алдааны нэгдсэн хэлбэр (бүх 4xx/5xx). `message` монгол, оруулсан утга/PII-гүй; `issues` нь зөвхөн зам + zod код */
export const BsaApiError = z.object({
  statusCode: z.number().int(),
  code: z.string(),
  message: z.string(),
  details: z.record(z.unknown()).optional(),
  issues: z.array(z.object({ path: z.string(), code: z.string() })).optional(),
  correlationId: z.string().optional(),
});
export type BsaApiError = z.infer<typeof BsaApiError>;

/** POST /bsa/analyses/:id/imports-ийн хариу */
export const BsaUploadResponse = z.object({
  outcomes: z.array(BsaUploadOutcome),
  accepted: z.number().int(),
  duplicates: z.number().int(),
  rejected: z.number().int(),
});
export type BsaUploadResponse = z.infer<typeof BsaUploadResponse>;

/** BSA-FR-3.4: админ баталгаажуулах ёстой, ХАДГАЛАГДААГҮЙ санал болгосон дүрэм */
export const BsaSuggestedRule = z.object({
  direction: z.enum(TxnDirection),
  matchType: z.enum(BsaRuleMatchType),
  pattern: z.string(),
  categoryCode: z.string(),
  priority: z.number().int(),
  source: z.enum(BsaRuleSource),
});
export type BsaSuggestedRule = z.infer<typeof BsaSuggestedRule>;

/** POST /bsa/analyses/:id/reclassify-ийн хариу */
export const BsaReclassifyResponse = z.object({
  affected: z.number().int(),
  selected: z.number().int(),
  similar: z.number().int(),
  suggestedRule: BsaSuggestedRule.nullable(),
  summary: BsaSummary.nullable(),
  repushRequired: z.boolean(),
});
export type BsaReclassifyResponse = z.infer<typeof BsaReclassifyResponse>;

/** POST /bsa/analyses/:id/finalize («Системрүү татах», INT-4) */
export const BsaFinalizeResponse = z.object({
  summary: BsaSummary,
  warnings: z.array(BsaAnalysisWarning),
  pushedToLosAt: z.string().datetime(),
  firstTime: z.boolean(),
});
export type BsaFinalizeResponse = z.infer<typeof BsaFinalizeResponse>;

// ───────────────────────── M12c · Сэжигтэй гүйлгээ (BSA-FR-5), хамтран зээлдэгчийн нэгтгэл (BSA-BR-9) ─────────────────────────

/** BSA-FR-5.4: 8 дохионы босго (admin). Мөнгөн дүн төгрөгөөр, хугацаа цагаар. Анхдагч — DEMO (docs/DECISIONS.md) */
export const BsaSuspicionThresholds = z
  .object({
    /** Тойрог шилжүүлэг: орлого↔зарлагын дүнгийн харьцангуй зөрүү (0.02 = 2%) */
    circularAmountTolerance: z.number().min(0).max(1),
    /** Тойрог шилжүүлэг: хугацааны зөрүү (цаг) */
    circularWindowHours: z.number().positive(),
    /** Данс хоорондын залилан: нэг харьцсан дансны тойрог хосын доод тоо */
    interAccountMinPairs: z.number().int().min(2),
    /** Хурдан бэлэн авалт: орлогын дараах цагийн зөрүү */
    quickCashWindowHours: z.number().positive(),
    /** Хурдан бэлэн авалт: орлогын доод дүн ба авалт/орлогын доод харьцаа */
    quickCashMinIncome: z.number().min(0),
    quickCashMinShare: z.number().min(0).max(1),
    /** Хуваан авалт: цонх (цаг), доод тоо, нийлбэрийн доод дүн */
    splitWindowHours: z.number().positive(),
    splitMinCount: z.number().int().min(2),
    splitMinTotal: z.number().min(0),
    /** Хамтарсан залилан: цонх (хоног), ялгаатай харьцсан дансны доод тоо, дүнгийн ойролцоо байдал, нийлбэрийн доод дүн */
    collusionWindowDays: z.number().positive(),
    collusionMinAccounts: z.number().int().min(3),
    collusionAmountTolerance: z.number().min(0).max(1),
    collusionMinTotal: z.number().min(0),
    /** Бүтэцлэгдсэн төлбөр: тайлагналын босго, түүнээс доош хувь, давтамж, цонх (хоног) */
    structuringThreshold: z.number().positive(),
    structuringBandRatio: z.number().min(0).max(1),
    structuringMinCount: z.number().int().min(2),
    structuringWindowDays: z.number().positive(),
    /** Мөрийтэй тоглоом: утга/харилцагчийн нэрэнд агуулагдах түлхүүр үгс (жижиг үсгээр) */
    gamblingKeywords: z.array(z.string().trim().min(1).max(64)).max(200),
  })
  .strict();
export type BsaSuspicionThresholds = z.infer<typeof BsaSuspicionThresholds>;

export const BsaSuspicionListQuery = z
  .object({
    status: z.enum(ReviewStatus).optional(),
    flag: z.enum(SuspicionFlag).optional(),
    offset: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type BsaSuspicionListQuery = z.infer<typeof BsaSuspicionListQuery>;

/** BSA-FR-5.2: нэг/бөөнөөр шийдвэрлэх. RECLASSIFY үед `categoryCode` заавал; EXCLUDE нь орлого/зардлыг «Сэжигтэй» ангилалд оруулж дайчлахгүй */
export const BsaResolveSuspicionsRequest = z
  .object({
    ids: z.array(Id).min(1).max(500),
    action: z.enum(ReviewAction),
    categoryCode: z.string().trim().min(1).max(64).optional(),
    comment: z.string().trim().max(1000).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.action === 'RECLASSIFY' && !v.categoryCode) ctx.addIssue({ code: 'custom', path: ['categoryCode'], message: 'required for RECLASSIFY' });
    if (v.action !== 'RECLASSIFY' && v.categoryCode) ctx.addIssue({ code: 'custom', path: ['categoryCode'], message: 'only for RECLASSIFY' });
  });
export type BsaResolveSuspicionsRequest = z.infer<typeof BsaResolveSuspicionsRequest>;

/** Нэг дохио (хос/бүлэг гүйлгээ). Гүйлгээнүүд нь далдалсан хэлбэрээр (дансны сүүл л харагдана) */
export const BsaSuspicionView = z.object({
  id: Id,
  flag: z.enum(SuspicionFlag),
  status: z.enum(ReviewStatus),
  action: z.enum(ReviewAction).nullable(),
  confidence: z.number().nullable(),
  comment: z.string().nullable(),
  resolvedBy: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  /** UI-д шууд харуулах товч (огноо, дүн) */
  firstDate: z.string(),
  totalAmount: z.number(),
  transactionIds: z.array(Id),
  transactions: z.array(
    z.object({
      id: Id, txnDate: z.string(), txnTime: z.string().nullable(), direction: z.enum(TxnDirection), amount: z.number(), description: z.string(),
      counterpartyAccount: z.string().nullable(), categoryCode: z.string().nullable(),
    }),
  ),
});
export type BsaSuspicionView = z.infer<typeof BsaSuspicionView>;

/** BSA-FR-5.1: нийт/хүлээгдэж буй/шийдвэрлэгдсэн + 8 дохионы тоо */
export const BsaSuspicionCounts = z.object({
  total: z.number().int(),
  pending: z.number().int(),
  resolved: z.number().int(),
  byFlag: z.record(z.enum(SuspicionFlag), z.object({ total: z.number().int(), pending: z.number().int() })),
});
export type BsaSuspicionCounts = z.infer<typeof BsaSuspicionCounts>;

export const BsaSuspicionListResponse = z.object({
  items: z.array(BsaSuspicionView),
  total: z.number().int(),
  offset: z.number().int(),
  limit: z.number().int(),
  counts: BsaSuspicionCounts,
});
export type BsaSuspicionListResponse = z.infer<typeof BsaSuspicionListResponse>;

/** BSA-BR-9 / BSA-FR-4.10: хүсэлтийн түвшний нэгтгэл (зээлдэгч бүрийн идэвхтэй шинжилгээ) */
export const BsaCombinedSummary = z.object({
  applicationId: z.string(),
  analysisCount: z.number().int(),
  /** Бүх шинжилгээ ANALYZED эсэх (үгүй бол нэгтгэл урьдчилсан) */
  allAnalyzed: z.boolean(),
  /** DTI орлого = Σ, өрийн үйлчилгээ = Σ */
  dtiIncome: z.number(),
  existingDebtServiceMonthly: z.number(),
  businessIncomeMonthly: z.number(),
  businessExpenseMonthly: z.number(),
  netCashFlowMonthly: z.number(),
  /** Орлогоор жигнэсэн дундаж */
  incomeReliability: z.number(),
  pendingSuspiciousCount: z.number().int(),
  dtiLevel: z.enum(DtiLevel),
  /** Нэгтгэсэн DTI % (өрийн үйлчилгээ + санал болгосон төлбөр) / нийт DTI орлого */
  dtiPercent: z.number(),
  members: z.array(z.object({ analysisId: z.string(), borrowerId: z.string(), status: z.enum(BsaStatus), dtiIncome: z.number(), existingDebtServiceMonthly: z.number() })),
});
export type BsaCombinedSummary = z.infer<typeof BsaCombinedSummary>;

// ───────────────────────── M12c · origination (LOS) талын гэрээ: /api/origination/applications/:id/bsa… ─────────────────────────

/** INT-1: хүсэлтийн зээлдэгчид BSA шинжилгээ үүсгэх. Регистр, нэр, данс, санал болгосон төлбөрийг LOS өөрөө дүүргэнэ */
export const BsaLosCreateAnalysisBody = z
  .object({
    customerId: z.string().min(1).max(128),
    periodMonths: z.number().int().min(1).max(120).nullish(),
    periodFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
    periodTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  })
  .strict();
export type BsaLosCreateAnalysisBody = z.infer<typeof BsaLosCreateAnalysisBody>;

export const BsaLosBorrowerRow = z.object({
  customerId: z.string(),
  role: z.enum(['PRIMARY', 'CO_BORROWER', 'GUARANTOR', 'COLLATERAL_OWNER']),
  displayName: z.string(),
  /** Хамгийн сүүлийн хувилбар; байхгүй бол null */
  analysisId: z.string().nullable(),
  status: z.enum(BsaStatus).nullable(),
  version: z.number().int().nullable(),
  dtiPercent: z.number().nullable(),
  pendingSuspiciousCount: z.number().int().nullable(),
});
export type BsaLosBorrowerRow = z.infer<typeof BsaLosBorrowerRow>;

export const BsaLosOverview = z.object({
  applicationId: z.string(),
  /** `loan_application.bsa_summary_json` — татагдаагүй бол null */
  summary: z.record(z.unknown()).nullable(),
  /** Санал болгосон сарын төлбөр (ЭТХ/нөхцөлөөс, INT-6) — тооцох боломжгүй бол null */
  proposedMonthlyPayment: z.number().nullable(),
  borrowers: z.array(BsaLosBorrowerRow),
  /** Scoring түр ажиллахгүй бол false (хадгалагдсан хураангуйг л харуулна) */
  available: z.boolean(),
  editable: z.boolean(),
});
export type BsaLosOverview = z.infer<typeof BsaLosOverview>;

export const BsaLosPushResponse = z.object({
  summary: z.record(z.unknown()),
  warnings: z.array(z.string()),
  /** INT-9: PDF тайлан 8-р алхамд орсон эсэх */
  reportAttached: z.boolean(),
});
export type BsaLosPushResponse = z.infer<typeof BsaLosPushResponse>;
