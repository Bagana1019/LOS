// PrismaBsaRepository-ийн нийтлэг туслахууд: транзакцийн контекст, мөр ↔ domain record хөрвүүлэлт (шифрлэлт/тайлалт энд), enum-ийн
// унших шалгалт, алдааны хөрвүүлэлт. PII-г зөвхөн ЭНЭ ФАЙЛЫН mapper-ууд `cipher`-ээр шифрлэнэ/тайлна.
import { BsaDtiRole, BsaRuleMatchType, BsaRuleSource, BsaStatus, ImportStatus, BsaChannel, TxnDirection, type BsaSummary } from '@los/contracts';
import type { BsaCategoryDef, BsaRuleDef } from '../../classify/classify.types';
import type { PiiCipher } from '../infra.ports';
import {
  ImportFormat,
  type BsaAnalysisEventRecord, type BsaAnalysisRecord, type BsaCustomerSnapshot, type BsaImportJobRecord, type BsaTransactionRecord,
  type ImportIssue, type Page, type PageRequest, type TenantScope,
} from './bsa.repository';
import { fromDbDate, resolvePage } from './bsa.validation';
import {
  Prisma, type BsaAnalysisEventRow, type BsaAnalysisRow, type BsaCategoryRow, type BsaImportJobRow, type BsaRuleRow, type BsaTransactionRow, type PrismaClient,
} from './prisma.service';

/** Prisma-ийн клиент эсвэл interactive транзакцийн клиент */
export type Db = Prisma.TransactionClient;

export interface PrismaBsaRepositoryOptions {
  /** Тестэд тогтмол цаг. Анхдагч: системийн цаг */
  now?: () => Date;
  /** Interactive транзакцийн дээд хугацаа (мс). Том импорт (5k+ мөр) Prisma-ийн анхдагч 5с-д багтахгүй байж болно */
  transactionTimeoutMs?: number;
  transactionMaxWaitMs?: number;
  /** createMany нэг INSERT-ийн мөрийн тоо: 27 багана × 1000 = 27k bind < PostgreSQL-ийн 32767 хязгаар */
  insertChunkSize?: number;
}
export const PRISMA_BSA_REPOSITORY_DEFAULTS = { transactionTimeoutMs: 30_000, transactionMaxWaitMs: 5_000, insertChunkSize: 1_000 } as const;
export const BSA_REPOSITORY_OPTIONS = Symbol('BSA_REPOSITORY_OPTIONS');

export interface Ctx {
  db: Db;
  /** null = аль хэдийн транзакц дотор (nested дуудлага нэгдэнэ) */
  root: PrismaClient | null;
  cipher: PiiCipher;
  now: () => Date;
  opts: Required<Omit<PrismaBsaRepositoryOptions, 'now'>>;
}

/** Транзакц дотор биш бол шинэ interactive транзакц нээж, дотор бол үргэлжлүүлнэ */
export function inTx<T>(ctx: Ctx, fn: (db: Db) => Promise<T>): Promise<T> {
  return ctx.root
    ? ctx.root.$transaction(fn, { timeout: ctx.opts.transactionTimeoutMs, maxWait: ctx.opts.transactionMaxWaitMs })
    : fn(ctx.db);
}

// ───────────────────────── Нийтлэг ─────────────────────────

export const dec = (d: Prisma.Decimal): number => d.toNumber();
export const decOrNull = (d: Prisma.Decimal | null): number | null => (d === null ? null : d.toNumber());
export const dateOrNull = (d: Date | null): string | null => (d === null ? null : fromDbDate(d));

/** DB-д enum-ийн гадуурх утга байвал (гар засвар, хуучин өгөгдөл) чимээгүй буруу төрлөөр өнгөрөөхгүй */
function readEnum<T extends string>(list: readonly T[], value: string, field: string): T {
  if (!(list as readonly string[]).includes(value)) throw new Error(`bsa persistence: unexpected value in ${field}`);
  return value as T;
}

/** Json? баганад null бичихэд Prisma.DbNull шаардлагатай */
export const jsonOrDbNull = (v: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull => (v === null || v === undefined ? Prisma.DbNull : (v as Prisma.InputJsonValue));

export function scopeWhere(scope?: TenantScope): { orgId?: string; branchId?: string } {
  return scope ? { orgId: scope.orgId, ...(scope.branchId ? { branchId: scope.branchId } : {}) } : {};
}

export function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function pageOf<T, R>(
  page: PageRequest | undefined,
  count: () => Promise<number>,
  find: (p: { skip: number; take: number }) => Promise<R[]>,
  map: (r: R) => T,
): Promise<Page<T>> {
  const { limit, offset } = resolvePage(page);
  const [total, rows] = await Promise.all([count(), find({ skip: offset, take: limit })]);
  return { items: rows.map(map), total, limit, offset };
}

/** Prisma-ийн мэдэгдэж буй алдааны код шалгах */
export const isPrismaCode = (e: unknown, code: string): boolean => e instanceof Prisma.PrismaClientKnownRequestError && e.code === code;

// ───────────────────────── PII шифрлэлт ─────────────────────────

export const enc = (ctx: Ctx, plain: string | null): string | null => (plain === null ? null : ctx.cipher.encrypt(plain));
export const decr = (ctx: Ctx, cipherText: string | null): string | null => (cipherText === null ? null : ctx.cipher.decrypt(cipherText));
export const encJson = (ctx: Ctx, v: unknown): string => ctx.cipher.encrypt(JSON.stringify(v));
export const decJson = <T>(ctx: Ctx, cipherText: string | null): T | null => (cipherText === null ? null : (JSON.parse(ctx.cipher.decrypt(cipherText)) as T));

// ───────────────────────── Mapper-ууд ─────────────────────────

export function toAnalysis(ctx: Ctx, r: BsaAnalysisRow): BsaAnalysisRecord {
  return {
    id: r.id, orgId: r.orgId, branchId: r.branchId, applicationId: r.applicationId, customerId: r.customerId, borrowerId: r.borrowerId,
    status: readEnum(BsaStatus, r.status, 'bsa_analysis.status'), version: r.version,
    periodFrom: dateOrNull(r.periodFrom), periodTo: dateOrNull(r.periodTo), periodMonths: r.periodMonths,
    proposedMonthlyPayment: decOrNull(r.proposedMonthlyPayment), costOfGoodsRate: decOrNull(r.costOfGoodsRate),
    summary: (r.summaryJson ?? null) as BsaSummary | null,
    customer: decJson<BsaCustomerSnapshot>(ctx, r.customerSnapshotEncrypted),
    registerNoHash: r.registerNoHash,
    ownAccounts: decJson<string[]>(ctx, r.ownAccountsEncrypted) ?? [],
    analyzedAt: r.analyzedAt, pushedToLosAt: r.pushedToLosAt, createdAt: r.createdAt, updatedAt: r.updatedAt, createdBy: r.createdBy, updatedBy: r.updatedBy,
  };
}

export function toJob(ctx: Ctx, r: BsaImportJobRow): BsaImportJobRecord {
  return {
    id: r.id, orgId: r.orgId, branchId: r.branchId, analysisId: r.analysisId, fileId: r.fileId, fileName: ctx.cipher.decrypt(r.fileNameEncrypted),
    mimeType: r.mimeType, sizeBytes: r.sizeBytes, sha256: r.sha256, bankCode: r.bankCode, format: readEnum(ImportFormat, r.format, 'bsa_import_job.format'),
    accountNo: decr(ctx, r.accountNoEncrypted), iban: decr(ctx, r.ibanEncrypted), holderName: decr(ctx, r.holderNameEncrypted),
    periodFrom: dateOrNull(r.periodFrom), periodTo: dateOrNull(r.periodTo), status: readEnum(ImportStatus, r.status, 'bsa_import_job.status'),
    rowsTotal: r.rowsTotal, rowsDone: r.rowsDone, errors: (r.errorsJson ?? []) as unknown as ImportIssue[], warnings: (r.warningsJson ?? []) as unknown as ImportIssue[],
    parserOk: r.parserOk, verifierOk: r.verifierOk, qrVerified: r.qrVerified, attempts: r.attempts, startedAt: r.startedAt, finishedAt: r.finishedAt,
    createdAt: r.createdAt, updatedAt: r.updatedAt, createdBy: r.createdBy, updatedBy: r.updatedBy,
  };
}

export function toTxn(ctx: Ctx, r: BsaTransactionRow): BsaTransactionRecord {
  return {
    id: r.id, analysisId: r.analysisId, importJobId: r.importJobId, seq: r.seq, txnDate: fromDbDate(r.txnDate), txnTime: r.txnTime,
    direction: readEnum(TxnDirection, r.direction, 'bsa_transaction.direction'), amount: dec(r.amount), balanceAfter: decOrNull(r.balanceAfter),
    description: ctx.cipher.decrypt(r.descriptionEncrypted), counterpartyAccount: decr(ctx, r.counterpartyAccountEncrypted),
    counterpartyName: decr(ctx, r.counterpartyNameEncrypted), channel: readEnum(BsaChannel, r.channel, 'bsa_transaction.channel'),
    categoryCode: r.categoryCode, categoryGroup: r.categoryGroup, confidence: dec(r.confidence), isOwnTransfer: r.isOwnTransfer,
    manualOverride: r.manualOverride, overrideBy: r.overrideBy, statementKey: r.statementKey, dedupeKey: r.dedupeKey,
  };
}

export function toEvent(r: BsaAnalysisEventRow): BsaAnalysisEventRecord {
  return { id: r.id, analysisId: r.analysisId, at: r.at, actorId: r.actorId, action: r.action, detail: (r.detailJson ?? null) as Record<string, unknown> | null };
}

export function toCategory(r: BsaCategoryRow): BsaCategoryDef {
  return {
    code: r.code, direction: readEnum(TxnDirection, r.direction, 'bsa_category.direction'), groupCode: r.groupCode, name: r.name, weight: dec(r.weight),
    dtiRole: readEnum(BsaDtiRole, r.dtiRole, 'bsa_category.dti_role'), isActive: r.isActive,
  };
}

export function toRule(r: BsaRuleRow): BsaRuleDef & { id: string } {
  return {
    id: r.id, direction: readEnum(TxnDirection, r.direction, 'bsa_rule.direction'), matchType: readEnum(BsaRuleMatchType, r.matchType, 'bsa_rule.match_type'), pattern: r.pattern,
    categoryCode: r.categoryCode, priority: r.priority, source: readEnum(BsaRuleSource, r.source, 'bsa_rule.source'),
  };
}
