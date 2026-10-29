// BSA-FR-4 / BSA-BR-5: ангиллын үр дүнгээс @los/calc-ийн `BsaCategoryMonthly[]` (ангилал × сар) бэлтгэх.
//  - Өөрийн данс хоорондын шилжүүлэг (isOwnTransfer) ТЭЭЭГЭЭР хасагдана (тоолуурт ч орохгүй).
//  - Идэвхтэй ангилал бүр гүйлгээгүй ч (тэг дүнтэй) гарна — UI бүх ангиллыг харуулахад.
//  - Сарын түлхүүр = txnDate-ийн 'YYYY-MM'. Дүнг минор нэгжээр (BigInt) нэмж 2 орноор гаргана — float drift-гүй.
//  - Буруу өгөгдөл (үл мэдэгдэх/идэвхгүй ангилал, чиглэл зөрөх, буруу огноо/дүн) чимээгүй алгасагдахгүй: `issues`-д бүртгэгдэж,
//    aggregateCategoryMonthly нь BsaAggregationError шидэнэ (мөнгөн тооцоонд чимээгүй буруу байж болохгүй).
import type { BsaCategoryMonthly } from '@los/calc';
import type { BsaCategoryDef, ClassifiedTxn } from '../classify/classify.types';
import { fromMinor, MinorSum, toMinorOrNull } from '../classify/money';

export type AggregationIssueCode = 'UNKNOWN_CATEGORY' | 'INACTIVE_CATEGORY' | 'DIRECTION_MISMATCH' | 'INVALID_DATE' | 'INVALID_AMOUNT';

/** Нэг төрлийн алдааны нэгтгэл (20k мөр бүрт тусдаа бичлэг гаргахгүй). PII-гүй: ангиллын код, тоо, жишээ гүйлгээний key. */
export interface AggregationIssue {
  code: AggregationIssueCode;
  /** UNKNOWN_CATEGORY / INACTIVE_CATEGORY / DIRECTION_MISMATCH-д холбогдох ангиллын код */
  categoryCode?: string;
  count: number;
  firstTxnKey: string;
  message: string;
}

export interface AggregationResult {
  categories: BsaCategoryMonthly[];
  issues: AggregationIssue[];
}

export class BsaAggregationError extends Error {
  constructor(readonly issues: readonly AggregationIssue[]) {
    super(`BSA aggregation failed: ${issues.map((i) => `${i.code}${i.categoryCode ? `(${i.categoryCode})` : ''}×${i.count}`).join(', ')}`);
    this.name = 'BsaAggregationError';
  }
}

const ISO_DATE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Бодит хуанлийн 'YYYY-MM-DD' эсэх (2026-02-30 → false) */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const t = new Date(0);
  t.setUTCFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return t.getUTCDate() === Number(m[3]);
}

class IssueCollector {
  private readonly map = new Map<string, AggregationIssue>();
  add(code: AggregationIssueCode, txnKey: string, message: string, categoryCode?: string): void {
    const id = `${code}|${categoryCode ?? ''}`;
    const existing = this.map.get(id);
    if (existing) existing.count++;
    else this.map.set(id, { code, ...(categoryCode !== undefined ? { categoryCode } : {}), count: 1, firstTxnKey: txnKey, message });
  }
  list(): AggregationIssue[] {
    return [...this.map.values()];
  }
}

/** Гүйлгээнүүдийг ангилал × сараар нэгтгэнэ. Алдааг шидэхгүй, `issues`-д буцаана. */
export function aggregateCategoryMonthlyDetailed(classified: readonly ClassifiedTxn[], categories: readonly BsaCategoryDef[]): AggregationResult {
  const byCode = new Map(categories.map((c) => [c.code, c]));
  const buckets = new Map<string, { months: Map<string, MinorSum>; count: number }>();
  for (const c of categories) if (c.isActive) buckets.set(c.code, { months: new Map(), count: 0 });
  const issues = new IssueCollector();

  for (const { txn, result } of classified) {
    if (result.isOwnTransfer) continue; // BSA-BR-5
    const category = byCode.get(result.categoryCode);
    if (!category) {
      issues.add('UNKNOWN_CATEGORY', txn.key, `category "${result.categoryCode}" does not exist`, result.categoryCode);
      continue;
    }
    if (!category.isActive) {
      issues.add('INACTIVE_CATEGORY', txn.key, `category "${category.code}" is inactive; reclassify its transactions`, category.code);
      continue;
    }
    if (category.direction !== txn.direction) {
      issues.add('DIRECTION_MISMATCH', txn.key, `${txn.direction} transaction is assigned to ${category.direction} category "${category.code}"`, category.code);
      continue;
    }
    if (!isIsoDate(txn.txnDate)) {
      issues.add('INVALID_DATE', txn.key, 'transaction date is not a valid YYYY-MM-DD calendar date');
      continue;
    }
    const minor = toMinorOrNull(txn.amount);
    if (minor === null || minor < 0) {
      issues.add('INVALID_AMOUNT', txn.key, 'transaction amount must be a finite number >= 0');
      continue;
    }
    const bucket = buckets.get(category.code) as { months: Map<string, MinorSum>; count: number };
    const month = txn.txnDate.slice(0, 7);
    let sum = bucket.months.get(month);
    if (!sum) bucket.months.set(month, (sum = new MinorSum()));
    sum.add(minor);
    bucket.count++;
  }

  const rows: BsaCategoryMonthly[] = categories
    .filter((c) => c.isActive)
    .map((c) => {
      const bucket = buckets.get(c.code) as { months: Map<string, MinorSum>; count: number };
      const monthly: Record<string, number> = {};
      for (const month of [...bucket.months.keys()].sort()) monthly[month] = fromMinor((bucket.months.get(month) as MinorSum).value);
      return { code: c.code, name: c.name, direction: c.direction, groupCode: c.groupCode, weight: c.weight, dtiRole: c.dtiRole, monthly, txnCount: bucket.count };
    });
  return { categories: rows, issues: issues.list() };
}

/** `aggregateCategoryMonthlyDetailed`, гэхдээ ямар нэг алдаа байвал BsaAggregationError шидэнэ */
export function aggregateCategoryMonthly(classified: readonly ClassifiedTxn[], categories: readonly BsaCategoryDef[]): BsaCategoryMonthly[] {
  const { categories: rows, issues } = aggregateCategoryMonthlyDetailed(classified, categories);
  if (issues.length > 0) throw new BsaAggregationError(issues);
  return rows;
}

/**
 * BSA-BR-3: шинжилгээний хугацаанд (хоёр үзүүр оролцоно) орсон гүйлгээ. ISO бус огноотой гүйлгээг ХАДГАЛНА — aggregate нь INVALID_DATE
 * гэж мэдээлнэ (чимээгүй алдах биш). Хугацаа буруу бол RangeError.
 */
export function filterByPeriod<T extends { txn: { txnDate: string } }>(items: readonly T[], periodFrom: string, periodTo: string): T[] {
  if (!isIsoDate(periodFrom) || !isIsoDate(periodTo)) throw new RangeError('period must be YYYY-MM-DD calendar dates');
  if (periodFrom > periodTo) throw new RangeError(`period start ${periodFrom} is after period end ${periodTo}`);
  return items.filter(({ txn }) => !isIsoDate(txn.txnDate) || (txn.txnDate >= periodFrom && txn.txnDate <= periodTo));
}
