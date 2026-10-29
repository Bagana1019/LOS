import { ReportKey } from '@los/contracts';
import type { ReportColumn, ReportDefinitionView, ReportFilterDef, ReportResult, ReportRow } from '@los/contracts';

// Цэвэр логик (React, antd, i18n-ээс хамааралгүй) — vitest-ээр тестлэнэ.
// Текст шаардлагатай газар `Translate` дамжуулна (component нь `t`-ийг өгнө).
// FR-13.3 (9 тайлан, Excel), FR-1.3 (шүүх, эрэмбэлэх, 10/20/50/100), NFR-3 (хүрээ), NFR-4/5 (экспорт нь хувийн мэдээлэл гаргах үйлдэл).

export type Translate = (key: string, params?: Record<string, string | number>) => string;
export type SortDir = 'asc' | 'desc';
export type Cell = ReportRow[string];
/** Шүүлтийн түлхүүр → утга (хоосон утгыг хадгалахгүй). Түлхүүр нь `ReportFilterDef.key` = `ReportQuery`-н талбар. */
export type FilterValues = Record<string, string>;
export type QueryParams = Record<string, string | number>;

export const EMPTY = '—';
export const PAGE_SIZES = [10, 20, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 20;
/** `ReportQuery`: search/branchId/officerId дээд тал нь 100 тэмдэгт. */
export const MAX_TEXT_LENGTH = 100;
const MAX_PAGE = 1_000_000;

export const isReportKey = (key: string): key is ReportKey => (ReportKey as readonly string[]).includes(key);

/** YYYY-MM-DD бөгөөд бодит календарийн өдөр (contracts-ийн `ymd`-тэй ижил: 2026-02-31 → false). */
export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// ── тоо, мөнгө, огноо ───────────────────────────────────────────────────────────────
const group = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** 1,234,567.5 — Intl-ээс хамаарахгүй тул тестэд тогтвортой. Сүүлийн тэг хасагдана. */
export function formatNumberValue(n: number, maxFractionDigits = 2): string {
  if (!Number.isFinite(n)) return EMPTY;
  const fixed = Math.abs(n).toFixed(maxFractionDigits);
  const [int, rawFrac = ''] = fixed.split('.');
  const frac = rawFrac.replace(/0+$/, '');
  const body = group(int) + (frac ? `.${frac}` : '');
  return n < 0 && Number(fixed) !== 0 ? `-${body}` : body;
}

/** `formatMoney` (lib/i18n)-тэй ижил харагдана: 1,250,000 ₮ · 120.5 USD. */
export function formatMoneyValue(n: number, currency = 'MNT'): string {
  if (!Number.isFinite(n)) return EMPTY;
  return `${formatNumberValue(n, 2)} ${currency === 'MNT' ? '₮' : currency}`;
}

/** Хувь баганы утга = харьцаа (0.25 = 25%): ×100 хийж харуулна. */
export function formatPercentValue(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return EMPTY;
  return `${formatNumberValue(ratio * 100, 2)}%`;
}

/** Instant (ISO) → Asia/Ulaanbaatar (UTC+8, DST-гүй) "YYYY-MM-DD HH:mm". */
export function formatDateTimeUb(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms + 8 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ');
}

export const exportFileName = (key: string, asOf?: string | null): string => (asOf && isIsoDate(asOf) ? `LOS_${key}_${asOf.replace(/-/g, '')}.xlsx` : `LOS_${key}.xlsx`);

// ── баганы утгыг харуулах ───────────────────────────────────────────────────────────
export const currencyOf = (row: ReportRow, fallback = 'MNT'): string => (typeof row.currency === 'string' && row.currency ? row.currency : fallback);

export const statusLabel = (column: Pick<ReportColumn, 'options'>, value: string): string => column.options?.find((o) => o.value === value)?.label ?? value;

/** Мөнгө, тоо, хувь баганыг баруун тийш, бусдыг зүүн тийш. */
export const columnAlign = (type: ReportColumn['type']): 'left' | 'right' => (type === 'money' || type === 'number' || type === 'percent' ? 'right' : 'left');

/** Баганы өргөн (Excel-ийн тэмдэгтийн тоо) → пиксел. */
export const columnPixelWidth = (width: number | undefined): number => Math.min(360, Math.max(80, Math.round((width ?? 14) * 9 + 24)));
export const tableScrollWidth = (columns: readonly Pick<ReportColumn, 'width'>[]): number => columns.reduce((s, c) => s + columnPixelWidth(c.width), 0);

export function formatCell(column: ReportColumn, value: Cell | undefined, row: ReportRow, tr?: Translate): string {
  if (value === null || value === undefined || value === '') return EMPTY;
  if (typeof value === 'boolean') return tr ? tr(value ? 'report.common.yes' : 'report.common.no') : String(value);
  switch (column.type) {
    case 'money': return typeof value === 'number' ? formatMoneyValue(value, currencyOf(row)) : String(value);
    case 'number': return typeof value === 'number' ? formatNumberValue(value) : String(value);
    case 'percent': return typeof value === 'number' ? formatPercentValue(value) : String(value);
    case 'status': return statusLabel(column, String(value));
    default: return String(value);
  }
}

/** antd `Tag` өнгө: status кодоор (кодууд тайланд давхцахгүй, давхцсан нь ижил утгатай). Үл мэдэгдэх → 'default'. */
export const STATUS_COLORS: Record<string, string> = {
  // зээл/хүсэлтийн төлөв
  DRAFT: 'default', SUBMITTED: 'blue', IN_APPROVAL: 'geekblue', APPROVED: 'green', RETURNED: 'orange', DISBURSING: 'cyan', ACTIVE: 'green', CLOSED: 'default', MIGRATED: 'purple',
  // хугацаа хэтрэлтийн ангилал (DPD)
  CURRENT: 'green', DPD_1_30: 'gold', DPD_31_60: 'orange', DPD_61_90: 'red', DPD_90_PLUS: 'volcano',
  // барьцаа
  OK: 'green', EXPIRING: 'orange', EXPIRED: 'red', RELEASED: 'default', CLEAR: 'green', ENCUMBERED: 'orange', DISPUTED: 'red',
  // олголт, дансны төлөв, алхам
  SENT_TO_CORE: 'blue', DORMANT: 'gold', PENDING: 'default', STALE: 'orange',
};
export const statusColor = (value: string): string => STATUS_COLORS[value] ?? 'default';

// ── нийлбэр ─────────────────────────────────────────────────────────────────────────
/** Нийлбэртэй (money/number) баганууд — `totals` дотор түлхүүр нь байгаа багана. */
export const totalKeysOf = (columns: readonly ReportColumn[], totals: ReportResult['totals']): string[] =>
  totals ? columns.filter((c) => (c.type === 'money' || c.type === 'number') && totals[c.key] !== undefined).map((c) => c.key) : [];

/** `totals` байгаа үед бүх шүүлттэй мөр нэг валюттай. Одоогийн хуудас хоосон бол шүүлтийн валют, үгүй бол MNT. */
export const totalsCurrency = (rows: readonly ReportRow[], fallback?: string | null): string => (rows[0] ? currencyOf(rows[0], fallback || 'MNT') : fallback || 'MNT');

export function formatTotal(column: ReportColumn, value: number, currency: string): string {
  return column.type === 'money' ? formatMoneyValue(value, currency) : formatNumberValue(value);
}

// ── хуудаслалт ба эрэмбэ ────────────────────────────────────────────────────────────
export const lastPage = (total: number, pageSize: number): number => Math.max(1, Math.ceil(total / pageSize));

export interface SortState { sortBy: string | null; sortDir: SortDir }

/** Эрэмбийн төлөв: сонгоогүй бол тайлангийн анхдагч эрэмбэ. */
export function effectiveSort(state: SortState, def: Pick<ReportDefinitionView, 'defaultSort'>): { sortBy: string; sortDir: SortDir } | null {
  if (state.sortBy) return { sortBy: state.sortBy, sortDir: state.sortDir };
  return def.defaultSort ? { sortBy: def.defaultSort.sortBy, sortDir: def.defaultSort.sortDir } : null;
}

/**
 * antd-ийн эрэмбийн үйлдэл → шинэ эрэмбэ. antd нь идэвхтэй баганыг 3 дахь дарахад эрэмбийг цуцалдаг (order=undefined);
 * тайланд "эрэмбэгүй" төлөв байхгүй (үргэлж анхдагч эрэмбэтэй) тул тэр үед чиглэлийг эсрэгээр нь буцаана.
 */
export function nextSort(current: SortState, def: Pick<ReportDefinitionView, 'defaultSort'>, columnKey: string | undefined, order: 'ascend' | 'descend' | null | undefined): SortState {
  if (!columnKey) return current;
  if (order === 'ascend') return { sortBy: columnKey, sortDir: 'asc' };
  if (order === 'descend') return { sortBy: columnKey, sortDir: 'desc' };
  const active = effectiveSort(current, def);
  if (active?.sortBy === columnKey) return { sortBy: columnKey, sortDir: active.sortDir === 'asc' ? 'desc' : 'asc' };
  return { sortBy: columnKey, sortDir: 'asc' };
}

export const toAntdOrder = (active: { sortBy: string; sortDir: SortDir } | null, columnKey: string): 'ascend' | 'descend' | null =>
  active?.sortBy === columnKey ? (active.sortDir === 'asc' ? 'ascend' : 'descend') : null;

// ── шүүлт ба URL ────────────────────────────────────────────────────────────────────
export interface ReportViewState extends SortState {
  page: number;
  pageSize: number;
  filters: FilterValues;
}

export interface ParamReader { get(name: string): string | null }

/** Шүүлтийн утгыг тайлангийн тодорхойлолтоор баталгаажуулна. Буруу/хоосон бол null (URL-аас орж ирсэн утгад итгэхгүй). */
export function normalizeFilterValue(filter: Pick<ReportFilterDef, 'type' | 'options'>, raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  switch (filter.type) {
    case 'date': return isIsoDate(v) ? v : null;
    case 'number': return Number.isFinite(Number(v)) ? v : null;
    case 'select': return !filter.options || filter.options.some((o) => o.value === v) ? v : null;
    default: return v.slice(0, MAX_TEXT_LENGTH);
  }
}

export function parseFilters(params: ParamReader, filters: readonly ReportFilterDef[]): FilterValues {
  const out: FilterValues = {};
  for (const f of filters) {
    const v = normalizeFilterValue(f, params.get(f.key));
    if (v) out[f.key] = v;
  }
  return out;
}

const toInt = (v: string | null): number | null => (v !== null && /^\d{1,9}$/.test(v) ? Number(v) : null);

/** URL-ийн query → харагдацын төлөв. Буруу page/pageSize/sort/шүүлтийг анхдагч руу буцаана (backend 400 өгөхөөс өмнө). */
export function parseViewState(params: ParamReader, def: Pick<ReportDefinitionView, 'columns' | 'filters'>): ReportViewState {
  const page = toInt(params.get('page'));
  const pageSize = toInt(params.get('pageSize'));
  const sortBy = params.get('sortBy');
  const sortable = sortBy !== null && def.columns.some((c) => c.key === sortBy && c.sortable);
  return {
    page: page !== null && page >= 1 && page <= MAX_PAGE ? page : 1,
    pageSize: pageSize !== null && (PAGE_SIZES as readonly number[]).includes(pageSize) ? pageSize : DEFAULT_PAGE_SIZE,
    sortBy: sortable ? sortBy : null,
    sortDir: sortable && params.get('sortDir') === 'desc' ? 'desc' : 'asc',
    filters: parseFilters(params, def.filters),
  };
}

/** Харагдацын төлөв → URL (анхдагч утгыг оруулахгүй). */
export function toSearchParams(state: ReportViewState): URLSearchParams {
  const sp = new URLSearchParams();
  if (state.page > 1) sp.set('page', String(state.page));
  if (state.pageSize !== DEFAULT_PAGE_SIZE) sp.set('pageSize', String(state.pageSize));
  if (state.sortBy) {
    sp.set('sortBy', state.sortBy);
    sp.set('sortDir', state.sortDir);
  }
  for (const [k, v] of Object.entries(state.filters)) if (v) sp.set(k, v);
  return sp;
}

/**
 * Харагдацын төлөв → API-н query (`GET /reports/:key` = ReportQuery; paging=false үед `/export` = ReportExportQuery).
 * Зөвхөн тайлангийн тодорхойлолтод байгаа шүүлтийг явуулна.
 */
export function buildReportQuery(state: ReportViewState, def: Pick<ReportDefinitionView, 'filters'>, opts: { paging: boolean }): QueryParams {
  const q: QueryParams = {};
  if (opts.paging) {
    q.page = state.page;
    q.pageSize = state.pageSize;
  }
  if (state.sortBy) {
    q.sortBy = state.sortBy;
    q.sortDir = state.sortDir;
  }
  for (const f of def.filters) {
    const v = state.filters[f.key];
    if (v) q[f.key] = v;
  }
  return q;
}

/** Шүүлтийн форм дахь алдаа (i18n түлхүүр). Эхлэх огноо дуусах огнооноос хойно бол backend 400 INVALID_DATE_RANGE өгөх тул өмнө нь саатуулна. */
export function validateFilters(values: FilterValues): string | null {
  const { dateFrom, dateTo } = values;
  if (dateFrom && dateTo && dateFrom > dateTo) return 'report.filters.error.dateRange';
  return null;
}

/** Хоосон биш шүүлтүүдийг л үлдээнэ (формын draft → хэрэглэх утга). */
export function compactFilters(values: Record<string, string | undefined | null>, filters: readonly ReportFilterDef[]): FilterValues {
  const out: FilterValues = {};
  for (const f of filters) {
    const v = normalizeFilterValue(f, values[f.key]);
    if (v) out[f.key] = v;
  }
  return out;
}

export const sameFilters = (a: FilterValues, b: FilterValues): boolean => {
  const ak = Object.keys(a);
  return ak.length === Object.keys(b).length && ak.every((k) => a[k] === b[k]);
};

// ── алдаа ───────────────────────────────────────────────────────────────────────────
/** Backend-ийн алдааны `code` → i18n түлхүүр (report.error.*). */
export const ERROR_KEYS = {
  VALIDATION_FAILED: 'report.error.VALIDATION_FAILED',
  INVALID_FILTER: 'report.error.INVALID_FILTER',
  INVALID_SORT: 'report.error.INVALID_SORT',
  INVALID_DATE_RANGE: 'report.error.INVALID_DATE_RANGE',
  REPORT_NOT_FOUND: 'report.error.REPORT_NOT_FOUND',
  FORBIDDEN: 'report.error.FORBIDDEN',
  BRANCH_REQUIRED: 'report.error.BRANCH_REQUIRED',
  UNAUTHENTICATED: 'report.error.UNAUTHENTICATED',
  EXPORT_TOO_LARGE: 'report.error.EXPORT_TOO_LARGE',
  INTEGRATION_NOT_CONFIGURED: 'report.error.INTEGRATION_NOT_CONFIGURED',
  INTEGRATION_NOT_IMPLEMENTED: 'report.error.INTEGRATION_NOT_IMPLEMENTED',
  EXPORT_BUSY: 'report.error.EXPORT_BUSY',
  REPORT_BUSY: 'report.error.REPORT_BUSY',
  REPORT_TIMEOUT: 'report.error.REPORT_TIMEOUT',
} as const;
type ErrorCode = keyof typeof ERROR_KEYS;

/** Эдгээр код дээр серверийн мессеж динамик өгөгдөлтэй (мөрийн тоо, шүүлтийн нэр) тул түүнийг түрүүлж харуулна. */
const SERVER_MESSAGE_FIRST = new Set<string>(['EXPORT_TOO_LARGE', 'INVALID_FILTER', 'INVALID_SORT']);
/** Тохиргоо/хэрэгжилтийн асуудал — алдаа биш, анхааруулга хэлбэрээр. */
const WARNING_CODES = new Set<string>(['INTEGRATION_NOT_CONFIGURED', 'INTEGRATION_NOT_IMPLEMENTED']);
/**
 * Серверийн ачаалал/хугацааны хамгаалалт (429 олон экспорт/dashboard зэрэг, 504 query хэт удаан). Автоматаар дахин оролдохгүй
 * (ачаалалтай серверийг улам дарамтлахгүй), гэхдээ хэрэглэгч "Дахин оролдох" товчоор гараар оролдож болно.
 */
const OVERLOAD_CODES = new Set<string>(['EXPORT_BUSY', 'REPORT_BUSY', 'REPORT_TIMEOUT']);
/**
 * `apiDownload` нь алдааны биеийг уншдаггүй (code=null) тул Excel татах үед HTTP статусаас кодыг сэргээнэ.
 * 422 = зөвхөн EXPORT_TOO_LARGE, 429 = EXPORT_BUSY (олон экспорт зэрэг), 501 = зөвхөн INTEGRATION_NOT_IMPLEMENTED, 504 = REPORT_TIMEOUT (энэ API-д).
 */
const STATUS_CODES: Record<number, ErrorCode> = { 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 404: 'REPORT_NOT_FOUND', 422: 'EXPORT_TOO_LARGE', 429: 'EXPORT_BUSY', 501: 'INTEGRATION_NOT_IMPLEMENTED', 504: 'REPORT_TIMEOUT' };

export interface DescribedError {
  code: string | null;
  message: string;
  /** VALIDATION_FAILED үед талбар бүрийн тайлбар. */
  issues: string[];
  severity: 'error' | 'warning';
  /** Түр зуурын (сүлжээ, сервер) алдаа — дахин оролдоход утгатай. */
  retryable: boolean;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const hasKey = (code: string): code is ErrorCode => Object.prototype.hasOwnProperty.call(ERROR_KEYS, code);

export function describeError(error: unknown, tr: Translate): DescribedError {
  const e = (typeof error === 'object' && error !== null ? error : {}) as { status?: unknown; code?: unknown; message?: unknown; issues?: unknown };
  const status = typeof e.status === 'number' ? e.status : null;
  const serverMessage = str(e.message);
  const rawCode = typeof e.code === 'string' ? e.code : null;
  const code: string | null = rawCode ?? (status !== null ? STATUS_CODES[status] ?? null : null);
  const result = (message: string, issues: string[] = []): DescribedError => ({
    code, message, issues, severity: code !== null && WARNING_CODES.has(code) ? 'warning' : 'error', retryable: isTransientError(error) || (code !== null && OVERLOAD_CODES.has(code)),
  });

  if (code !== null && hasKey(code)) {
    if (SERVER_MESSAGE_FIRST.has(code) && serverMessage && rawCode !== null) return result(serverMessage);
    const issues = code === 'VALIDATION_FAILED' && Array.isArray(e.issues)
      ? e.issues.flatMap((i: unknown) => {
          const issue = i as { path?: unknown; message?: unknown } | null;
          const text = str(issue?.message);
          if (!text) return [];
          const path = str(issue?.path);
          return [path ? `${path}: ${text}` : text];
        })
      : [];
    return result(tr(ERROR_KEYS[code]), issues);
  }
  if (status !== null && status >= 500) return result(tr('report.error.SERVER'));
  if (error instanceof TypeError) return result(tr('report.error.NETWORK')); // fetch холбогдож чадаагүй
  if (status !== null && serverMessage) return result(serverMessage);
  return result(tr('report.error.UNKNOWN'));
}

/** Сүлжээний болон серверийн (5xx) алдаа — автоматаар дахин оролдоно. Интеграцийн тохиргоо/хэрэгжилт (501/503 + код) нь байнгын, ачаалал/timeout (OVERLOAD_CODES) нь серверийг дарамтлахгүйн тулд дахин оролдохгүй. */
export function isTransientError(error: unknown): boolean {
  const e = (typeof error === 'object' && error !== null ? error : {}) as { status?: unknown; code?: unknown };
  if (typeof e.code === 'string' && (WARNING_CODES.has(e.code) || OVERLOAD_CODES.has(e.code))) return false;
  if (typeof e.status === 'number') return e.status >= 500 && e.status !== 501;
  return error instanceof TypeError;
}

/** react-query `retry`: түр зуурын алдааг нэг удаа дахин оролдоно. */
export const retryTransient = (failureCount: number, error: unknown): boolean => failureCount < 1 && isTransientError(error);

/** Хуудас хэтэрсэн (шүүлт өөрчлөгдсөний дараа) бол сүүлийн хуудас руу; үгүй бол null. */
export function pageCorrection(result: Pick<ReportResult, 'rows' | 'total' | 'page' | 'pageSize'> | undefined): number | null {
  if (!result || result.rows.length > 0 || result.total === 0 || result.page <= 1) return null;
  const last = lastPage(result.total, result.pageSize);
  return result.page > last ? last : null;
}
