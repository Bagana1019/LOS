import { ApiError } from '../../lib/api';
import { t } from '../../lib/i18n';

/** BR-11 жишээ: `{PREFIX}{BRANCH}{YYMMDD}{SEQ:2}` → B10026021501 (origination `formatContractNo`-той ижил дүрэм; зөвхөн урьдчилан харахад). */
export function previewContractNo(pattern: string, prefix: string, branch: string, date: Date, seq: number): string {
  const yy = String(date.getFullYear() % 100).padStart(2, '0');
  const yymmdd = `${yy}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  return pattern
    .replace(/\{PREFIX\}/g, prefix)
    .replace(/\{BRANCH\}/g, branch)
    .replace(/\{YYMMDD\}/g, yymmdd)
    .replace(/\{SEQ(?::(\d+))?\}/g, (_m, w: string | undefined) => String(seq).padStart(w ? Number(w) : 0, '0'));
}

export type JsonParse = { ok: true; value: unknown } | { ok: false };
export function parseJsonInput(text: string): JsonParse {
  try { return { ok: true, value: JSON.parse(text) as unknown }; } catch { return { ok: false }; }
}

export const showValue = (v: unknown): string => (typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? '');

/** Салбарын кодын шалгалт: хоосон бол нэмэхгүй; давхардал/хэлбэр алдааг буцаана. */
export function validateBranchCodes(codes: Record<string, string>): string | null {
  const vals = Object.values(codes).filter(Boolean);
  if (vals.some((c) => !/^[A-Za-z0-9]{1,12}$/.test(c))) return t('admin.branches.codes.hint');
  if (new Set(vals.map((c) => c.toUpperCase())).size !== vals.length) return 'Давхардсан код байна';
  return null;
}

export const errorText = (e: unknown): string => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : t('admin.common.load_error'));
