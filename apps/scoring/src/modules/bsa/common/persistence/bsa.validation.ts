// Repository-ийн оролтын баталгаажуулалт ба нормчлол. PrismaBsaRepository, InMemoryBsaRepository ХОЁУЛАА энэ файлыг ашиглана →
// бөөрөнхийлөлт, enum шалгалт, алдааны код хоёр хэрэгжүүлэлтэд ижил (нэг гэрээ). Enum-ийн эх сурвалж @los/contracts (zod enum).
// АНХААР (PII): алдааны мессежид зөвхөн талбарын зам + zod кодыг оруулна — оролтын утгыг ХЭЗЭЭ Ч оруулахгүй.
import { z } from 'zod';
import { BsaDtiRole, BsaRuleMatchType, BsaRuleSource, BsaStatus, BsaSummary, ImportStatus, BsaChannel, TxnDirection } from '@los/contracts';
import { BsaInvalidError, DEFAULT_PAGE_SIZE, ImportFormat, MAX_PAGE_SIZE, type IsoDate, type PageRequest } from './bsa.repository';

/** numeric(18,2) тутамд багтах, цент нь Number.MAX_SAFE_INTEGER-ээс бага байх дээд хязгаар (90 их наяд) */
export const MAX_MONEY = 9e13;

// ───────────────────────── Тоо, огноо, тэмдэгт ─────────────────────────

/**
 * Аравтын мөрөөр бөөрөнхийлнө, 0.5 → тэгээс холдох (PostgreSQL numeric, decimal.js-тэй ижил). 1.005 → 1.01 (binary Math.round биш).
 * Prisma Decimal ба in-memory хоёр ижил үр дүн өгөхийн тулд хадгалахаас өмнө ЗААВАЛ дуудна.
 */
export function roundTo(n: number, digits: number): number {
  const abs = Math.abs(n);
  const s = String(abs);
  const r = s.includes('e') ? Number(abs.toFixed(digits)) : Number(`${Math.round(Number(`${s}e${digits}`))}e-${digits}`);
  return n < 0 && r !== 0 ? -r : r;
}
export const roundMoney = (n: number): number => roundTo(n, 2);

/** `YYYY-MM-DD` мөн үнэн хуанлийн өдөр эсэх (2026-02-30 → false) */
export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
export const toDbDate = (s: IsoDate): Date => new Date(`${s}T00:00:00.000Z`);
export const fromDbDate = (d: Date): IsoDate => d.toISOString().slice(0, 10);

/** Дансны дугаар/IBAN: хоосон зай хасч том үсэг. Хоосон бол '' */
export const normalizeAccount = (s: string): string => s.replace(/\s+/g, '').toUpperCase();
/** Регистр: хоосон зай хасч том үсэг (кирилл 'уб90010203' → 'УБ90010203') — hash-ийн өмнө */
export const normalizeRegisterNo = (s: string): string => s.replace(/\s+/g, '').toUpperCase();

/** Тогтмол, locale-оос үл хамаарах харьцуулалт (UTF-16 кодын нэгжээр) — SQL collation-д найдахгүй эрэмбэд */
export const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** JSON-ээр дамжуулж jsonb-ийн хоёр талын хөрвөлтийг (undefined хасах, Date → ISO) in-memory-д ч ижил болгоно */
export function toJson<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

// ───────────────────────── zod схемүүд ─────────────────────────

const id = (max = 128) => z.string().min(1).max(max);
const nullableId = (max = 128) => id(max).nullish().transform((v) => v ?? null);
const money = z.number().min(0).max(MAX_MONEY).transform(roundMoney);
const nullableMoney = money.nullish().transform((v) => v ?? null);
const isoDate = z.string().refine(isIsoDate, 'date');
const nullableDate = isoDate.nullish().transform((v) => v ?? null);
const nullableText = (max: number) => z.string().max(max).nullish().transform((v) => v ?? null);
const nonNegInt = z.number().int().min(0).max(2_147_483_647);

const declaredAccount = z.object({
  bankCode: nullableText(32),
  accountNo: z.string().min(1).max(64),
  iban: nullableText(64),
  holderName: nullableText(256),
  source: z.enum(['MANUAL', 'STATEMENT']),
});
const customerSnapshot = z.object({
  registerNo: z.string().min(1).max(32),
  lastName: nullableText(128),
  firstName: nullableText(128),
  phone: nullableText(32),
  gender: nullableText(16),
  note: nullableText(2000),
  declaredAccounts: z.array(declaredAccount).max(200).default([]),
});
const accountList = z
  .array(z.string().max(64))
  .max(500)
  .transform((a) => mergeAccounts([], a));

const rate01 = z.number().min(0).max(1).transform((n) => roundTo(n, 4));
const periodMonths = z.number().int().min(0).max(1200);

const analysisFields = {
  branchId: nullableId(),
  borrowerId: nullableId(),
  periodFrom: nullableDate,
  periodTo: nullableDate,
  periodMonths: periodMonths.nullish().transform((v) => v ?? null),
  proposedMonthlyPayment: nullableMoney,
  costOfGoodsRate: rate01.nullish().transform((v) => v ?? null),
  customer: customerSnapshot.nullish().transform((v) => v ?? null),
  ownAccounts: accountList.default([]),
};
const periodOrder = (v: { periodFrom?: string | null; periodTo?: string | null }): boolean =>
  !v.periodFrom || !v.periodTo || v.periodFrom <= v.periodTo;

export const newAnalysisSchema = z
  .object({ orgId: id(), applicationId: id(), customerId: id(), createdBy: nullableId(), ...analysisFields })
  .refine(periodOrder, { path: ['periodTo'], message: 'period' });

export const analysisPatchSchema = z
  .object({
    branchId: id().nullable(),
    borrowerId: id().nullable(),
    status: z.enum(BsaStatus),
    periodFrom: isoDate.nullable(),
    periodTo: isoDate.nullable(),
    periodMonths: periodMonths.nullable(),
    proposedMonthlyPayment: money.nullable(),
    costOfGoodsRate: rate01.nullable(),
    summary: BsaSummary.nullable(),
    customer: customerSnapshot.nullable(),
    ownAccounts: accountList,
    analyzedAt: z.date().nullable(),
    pushedToLosAt: z.date().nullable(),
  })
  .partial()
  .strict()
  .refine(periodOrder, { path: ['periodTo'], message: 'period' });

const importIssue = z.object({
  code: z.string().min(1).max(64),
  message: z.string().max(1000),
  severity: z.enum(['ERROR', 'WARNING']).optional(),
  seq: nonNegInt.optional(),
  page: nonNegInt.optional(),
  line: nonNegInt.optional(),
});

export const newJobSchema = z.object({
  analysisId: id(),
  fileId: id(512),
  fileName: z.string().min(1).max(512),
  mimeType: z.string().min(1).max(128),
  sizeBytes: nonNegInt,
  sha256: z.string().regex(/^[0-9a-fA-F]{64}$/).transform((s) => s.toLowerCase()),
  format: z.enum(ImportFormat),
  bankCode: nullableId(32),
  createdBy: nullableId(),
});

export const jobPatchSchema = z
  .object({
    status: z.enum(ImportStatus),
    bankCode: id(32).nullable(),
    format: z.enum(ImportFormat),
    accountNo: z.string().max(64).nullable(),
    iban: z.string().max(64).nullable(),
    holderName: z.string().max(256).nullable(),
    periodFrom: isoDate.nullable(),
    periodTo: isoDate.nullable(),
    rowsTotal: nonNegInt,
    rowsDone: nonNegInt,
    errors: z.array(importIssue).max(5000),
    warnings: z.array(importIssue).max(5000),
    parserOk: z.boolean().nullable(),
    verifierOk: z.boolean().nullable(),
    qrVerified: z.boolean().nullable(),
    attempts: nonNegInt,
    startedAt: z.date().nullable(),
    finishedAt: z.date().nullable(),
  })
  .partial()
  .strict()
  .refine(periodOrder, { path: ['periodTo'], message: 'period' });

const confidence = z.number().min(0).max(100).transform(roundMoney);
const txnTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/);

export const newTxnSchema = z.object({
  seq: z.number().int().min(1).max(2_147_483_647),
  txnDate: isoDate,
  txnTime: txnTime.nullish().transform((v) => v ?? null),
  direction: z.enum(TxnDirection),
  amount: money,
  balanceAfter: z.number().min(-MAX_MONEY).max(MAX_MONEY).transform(roundMoney).nullish().transform((v) => v ?? null),
  description: z.string(),
  counterpartyAccount: z.string().nullish().transform((v) => v ?? null),
  counterpartyName: z.string().nullish().transform((v) => v ?? null),
  channel: z.enum(BsaChannel).default('OTHER'),
  categoryCode: nullableId(64),
  categoryGroup: nullableId(16),
  confidence: confidence.default(0),
  isOwnTransfer: z.boolean().default(false),
  statementKey: id(),
  dedupeKey: id(),
});
export type NormalizedTxn = z.output<typeof newTxnSchema>;

export const classificationUpdateSchema = z.object({
  id: id(),
  categoryCode: id(64),
  categoryGroup: id(16),
  confidence,
  channel: z.enum(BsaChannel),
  isOwnTransfer: z.boolean(),
});

export const txnFilterSchema = z
  .object({
    analysisId: id(),
    importJobId: id().optional(),
    dateFrom: isoDate.optional(),
    dateTo: isoDate.optional(),
    direction: z.enum(TxnDirection).optional(),
    categoryCodes: z.array(id(64)).max(200).optional(),
    channel: z.union([z.enum(BsaChannel), z.array(z.enum(BsaChannel)).max(5)]).optional(),
    ownTransfer: z.boolean().optional(),
    manualOverride: z.boolean().optional(),
    amountMin: money.optional(),
    amountMax: money.optional(),
    text: z.string().max(200).optional(),
    sort: z.enum(['DATE_ASC', 'DATE_DESC', 'AMOUNT_ASC', 'AMOUNT_DESC']).optional(),
  })
  .strict();

export const analysisFilterSchema = z
  .object({
    orgId: id(),
    branchId: nullableId().optional(),
    status: z.union([z.enum(BsaStatus), z.array(z.enum(BsaStatus)).max(4)]).optional(),
    applicationId: id().optional(),
    customerId: id().optional(),
    registerNo: z.string().min(1).max(32).optional(),
    createdBy: id().optional(),
    createdFrom: z.date().optional(),
    createdTo: z.date().optional(),
  })
  .strict();

export const jobFilterSchema = z
  .object({
    orgId: id().optional(),
    branchId: nullableId().optional(),
    analysisId: id().optional(),
    status: z.union([z.enum(ImportStatus), z.array(z.enum(ImportStatus)).max(4)]).optional(),
    bankCode: id(32).optional(),
  })
  .strict();

export const newEventSchema = z.object({
  analysisId: id(),
  action: z.string().min(1).max(64),
  actorId: nullableId(),
  detail: z.record(z.unknown()).nullish().transform((v) => (v ? toJson(v) : null)),
  at: z.date().optional(),
});

export const newRuleSchema = z.object({
  direction: z.enum(TxnDirection),
  matchType: z.enum(BsaRuleMatchType),
  pattern: z.string().min(1).max(1000),
  categoryCode: id(64),
  priority: z.number().int().min(-1_000_000).max(1_000_000),
  source: z.enum(BsaRuleSource),
});

/** BsaCategoryDef-ийн DB-д бичигдэх хэлбэр — seed/admin-д (энэ unit-д зөвхөн унших); dtiRole зэргийг шалгахад */
export const categoryDefSchema = z.object({
  code: id(64),
  direction: z.enum(TxnDirection),
  groupCode: id(16),
  name: z.string().min(1).max(256),
  weight: z.number().min(0).max(1).transform((n) => roundTo(n, 4)),
  dtiRole: z.enum(BsaDtiRole),
  isActive: z.boolean(),
});

// ───────────────────────── Ажиллуулагч ─────────────────────────

/** zod-оор шалгана; алдаа → BsaInvalidError(талбарын зам, zod код). Оролтын утга мессежид орохгүй */
export function validate<S extends z.ZodTypeAny>(schema: S, input: unknown, label: string): z.output<S> {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  throw new BsaInvalidError([label, ...issue.path].join('.'), issue.code);
}

/** Хоосон зай хасч, том үсгээр, давхардалгүй, дарааллыг хадгалж нэгтгэнэ. Хоосон мөр хасагдана */
export function mergeAccounts(existing: readonly string[], added: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...existing, ...added]) {
    const a = normalizeAccount(raw);
    if (a !== '' && !seen.has(a)) {
      seen.add(a);
      out.push(a);
    }
  }
  return out;
}

export function resolvePage(page?: PageRequest): { limit: number; offset: number } {
  const limit = page?.limit ?? DEFAULT_PAGE_SIZE;
  const offset = page?.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1) throw new BsaInvalidError('page.limit', 'invalid_type');
  if (!Number.isInteger(offset) || offset < 0) throw new BsaInvalidError('page.offset', 'invalid_type');
  return { limit: Math.min(limit, MAX_PAGE_SIZE), offset };
}

export const asArray = <T>(v: T | readonly T[] | undefined): T[] | undefined => (v === undefined ? undefined : Array.isArray(v) ? [...v] : [v as T]);
