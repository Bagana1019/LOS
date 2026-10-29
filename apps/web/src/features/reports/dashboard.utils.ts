import { AgingBucket, ApplicationStatus } from '@los/contracts';
import type { DashboardSummary } from '@los/contracts';
import { EMPTY, formatMoneyValue, formatNumberValue, isIsoDate, type ParamReader, type Translate } from './reports.utils';

// Dashboard-ын цэвэр логик: шүүлт ↔ URL, KPI текст, диаграмын геометр/масштаб. Vitest-ээр тестлэнэ.
// FR-13.3 (KPI dashboard), NFR-3 (хүрээ — backend хэрэгжүүлнэ, UI нь үр дүнгийн `scope`-ыг харуулна).

export const CURRENCIES = ['MNT', 'USD'] as const;
export const DEFAULT_CURRENCY = 'MNT';

export interface DashboardFilters {
  asOf: string | null;
  currency: string;
  branchId: string | null;
}

export const DEFAULT_DASHBOARD_FILTERS: DashboardFilters = { asOf: null, currency: DEFAULT_CURRENCY, branchId: null };

/** URL → шүүлт. Буруу огноо/валютыг анхдагч руу буцаана. */
export function parseDashboardFilters(params: ParamReader): DashboardFilters {
  const asOf = (params.get('asOf') ?? '').trim();
  const currency = (params.get('currency') ?? '').trim().toUpperCase();
  const branchId = (params.get('branchId') ?? '').trim().slice(0, 100);
  return {
    asOf: isIsoDate(asOf) ? asOf : null,
    currency: (CURRENCIES as readonly string[]).includes(currency) ? currency : DEFAULT_CURRENCY,
    branchId: branchId || null,
  };
}

export function toDashboardSearchParams(f: DashboardFilters): URLSearchParams {
  const sp = new URLSearchParams();
  if (f.asOf) sp.set('asOf', f.asOf);
  if (f.currency !== DEFAULT_CURRENCY) sp.set('currency', f.currency);
  if (f.branchId) sp.set('branchId', f.branchId);
  return sp;
}

/** `GET /reports/dashboard/summary` query (DashboardQuery). */
export function buildDashboardQuery(f: DashboardFilters): Record<string, string> {
  return { currency: f.currency, ...(f.asOf ? { asOf: f.asOf } : {}), ...(f.branchId ? { branchId: f.branchId } : {}) };
}

export const sameDashboardFilters = (a: DashboardFilters, b: DashboardFilters): boolean => a.asOf === b.asOf && a.currency === b.currency && a.branchId === b.branchId;

// ── KPI текст ───────────────────────────────────────────────────────────────────────
/** Харьцаа → "12.5%"; null (хуваалт 0) → "—". */
export function formatRatio(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return EMPTY;
  return `${formatNumberValue(ratio * 100, 1)}%`;
}

export function formatHours(hours: number | null | undefined, tr: Translate): string {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return EMPTY;
  return tr('report.dashboard.hours', { value: formatNumberValue(hours, 1) });
}

/** Өмнөх үетэй харьцуулсан өөрчлөлт (харьцаа). Өмнөх үе 0 бол харьцуулах боломжгүй → null. */
export function changeRatio(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return (current - previous) / Math.abs(previous);
}

export type DeltaTone = 'up' | 'down' | 'flat';
export function deltaTone(ratio: number | null): DeltaTone | null {
  if (ratio === null) return null;
  const rounded = Math.round(ratio * 1000) / 10; // 0.1% нарийвчлал
  return rounded > 0 ? 'up' : rounded < 0 ? 'down' : 'flat';
}

/** "+12.5%" / "-3%" / "0%". */
export function formatDelta(ratio: number | null): string {
  if (ratio === null) return EMPTY;
  const pct = formatNumberValue(ratio * 100, 1);
  return ratio > 0 && pct !== '0' ? `+${pct}%` : `${pct === '-0' ? '0' : pct}%`;
}

export function scopeText(scope: DashboardSummary['scope'], tr: Translate): string {
  if (scope.officerId) return tr('report.dashboard.scope.officer', { officer: scope.officerId });
  if (scope.branchId) return tr('report.dashboard.scope.branch', { branch: scope.branchId });
  return tr('report.dashboard.scope.all');
}

/** Диаграмд үзүүлэх өгөгдөл огт байхгүй (хоосон систем / шинэ салбар). */
export const isMonthlyEmpty = (monthly: DashboardSummary['disbursements']['monthly']): boolean => monthly.every((m) => m.amount === 0 && m.count === 0);

export function isDashboardEmpty(s: DashboardSummary): boolean {
  return s.applications.byStatus.every((r) => r.count === 0) && isMonthlyEmpty(s.disbursements.monthly) && s.portfolio.activeLoanCount === 0;
}

// ── сарын олголтын багана диаграм (inline SVG) ──────────────────────────────────────
export const CHART_COLORS = {
  /** Нэг цувааны үндсэн өнгө (palette slot 1, blue). */
  accent: '#2a78d6',
  /** Hover хийсэн мөр, сонгосон сар. */
  accentStrong: '#184f95',
} as const;

/** Хугацаа хэтрэлтийн хүндрэл (CURRENT → 90+): статусын палитр (good → warning → serious → critical) + 90+ нь critical-ийн бараан алхам. */
export const AGING_COLORS: Record<(typeof AgingBucket)[number], string> = {
  CURRENT: '#0ca30c', DPD_1_30: '#fab219', DPD_31_60: '#ec835a', DPD_61_90: '#d03b3b', DPD_90_PLUS: '#8c1f1f',
};

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** "Цэвэр" тэнхлэгийн масштаб: 1/2/5 × 10^k алхамтай, 0-ээс эхэлнэ. */
export function niceScale(maxValue: number, tickCount = 4): { max: number; ticks: number[] } {
  if (!Number.isFinite(maxValue) || maxValue <= 0) return { max: 1, ticks: [0, 1] };
  const raw = maxValue / tickCount;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const frac = raw / pow;
  const step = (frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10) * pow;
  const count = Math.ceil(maxValue / step - 1e-9);
  const ticks = Array.from({ length: count + 1 }, (_, i) => Number((i * step).toPrecision(12)));
  return { max: ticks[ticks.length - 1], ticks };
}

/** Тэнхлэгийн шошго: 0 · 500 мянга · 1.5 сая · 2 тэрбум. */
export function formatCompact(n: number, tr: Translate): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${formatNumberValue(n / 1e9, 1)} ${tr('report.chart.unit.billion')}`;
  if (abs >= 1e6) return `${formatNumberValue(n / 1e6, 1)} ${tr('report.chart.unit.million')}`;
  if (abs >= 1e3) return `${formatNumberValue(n / 1e3, 1)} ${tr('report.chart.unit.thousand')}`;
  return formatNumberValue(n, 0);
}

/** 4px-ээр дугуйруулсан дээд талтай, суурь нь тэгш багана (marks spec: data-end rounded, baseline square). */
export function roundedTopBarPath(x: number, y: number, w: number, h: number, radius = 4): string {
  const r = Math.max(0, Math.min(radius, w / 2, h));
  const [X, Y, W, H, R] = [r2(x), r2(y), r2(w), r2(h), r2(r)];
  return `M${X},${r2(Y + H)} L${X},${r2(Y + R)} Q${X},${Y} ${r2(X + R)},${Y} L${r2(X + W - R)},${Y} Q${r2(X + W)},${Y} ${r2(X + W)},${r2(Y + R)} L${r2(X + W)},${r2(Y + H)} Z`;
}

export interface MonthBar {
  month: string; // YYYY-MM
  amount: number;
  count: number;
  /** Бүсийн (hover/focus хүрэх талбар) зүүн захын x ба өргөн. */
  bandX: number;
  bandWidth: number;
  /** Баганын геометр (plot-ын координат; y нь дээд ирмэг). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Баганын төвийн x (tooltip байрлуулах). */
  cx: number;
}

/** 12 сарын багана: бүс тутамд ≤ maxBarWidth өргөнтэй багана төвд. Дүн 0 бол өндөр 0 (багана зурагдахгүй). */
export function layoutMonthlyBars(monthly: DashboardSummary['disbursements']['monthly'], plot: { width: number; height: number }, scaleMax: number, maxBarWidth = 24): MonthBar[] {
  const n = Math.max(1, monthly.length);
  const band = plot.width / n;
  const width = Math.min(maxBarWidth, band * 0.6);
  return monthly.map((m, i) => {
    const height = scaleMax > 0 ? Math.max(0, (m.amount / scaleMax) * plot.height) : 0;
    const x = i * band + (band - width) / 2;
    return { month: m.month, amount: m.amount, count: m.count, bandX: r2(i * band), bandWidth: r2(band), x: r2(x), y: r2(plot.height - height), width: r2(width), height: r2(height), cx: r2(x + width / 2) };
  });
}

/** 'YYYY-MM' → { year, month }. Буруу бол null. */
export function monthParts(ym: string): { year: number; month: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return null;
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? { year: Number(m[1]), month } : null;
}

/** Тэнхлэгийн шошго: сар бүрт "N-р сар"; жилийг эхний багана болон 1-р сард нэмж харуулна. */
export function monthAxisLabel(ym: string, index: number, tr: Translate): { month: string; year: string | null } {
  const p = monthParts(ym);
  if (!p) return { month: ym, year: null };
  return { month: tr('report.chart.month', { month: p.month }), year: index === 0 || p.month === 1 ? String(p.year) : null };
}

// ── хэвтээ мөрт диаграм (aging, төлөвийн урсгал, топ бүтээгдэхүүн) ──────────────────
export interface BarRow {
  key: string;
  label: string;
  /** Мөрийн уртыг тодорхойлох утга. */
  value: number;
  /** 0..1 — хамгийн их утгад харьцуулсан урт. */
  ratio: number;
  color: string;
  primary: string;
  secondary: string;
}

const withRatios = <T extends { value: number }>(rows: T[]): Array<T & { ratio: number }> => {
  const max = Math.max(0, ...rows.map((r) => r.value));
  return rows.map((r) => ({ ...r, ratio: max > 0 ? r.value / max : 0 }));
};

const AGING_LABEL_KEYS = {
  CURRENT: 'report.aging.CURRENT', DPD_1_30: 'report.aging.DPD_1_30', DPD_31_60: 'report.aging.DPD_31_60', DPD_61_90: 'report.aging.DPD_61_90', DPD_90_PLUS: 'report.aging.DPD_90_PLUS',
} as const satisfies Record<(typeof AgingBucket)[number], string>;

/** 5 хувин үргэлж AgingBucket дарааллаар (backend өгөөгүй хувин 0). Урт = үндсэн үлдэгдэл. */
export function agingRows(aging: DashboardSummary['portfolio']['aging'], currency: string, tr: Translate): BarRow[] {
  const byBucket = new Map(aging.map((a) => [a.bucket, a]));
  return withRatios(AgingBucket.map((bucket) => {
    const a = byBucket.get(bucket);
    return {
      key: bucket, label: tr(AGING_LABEL_KEYS[bucket]), value: a?.principal ?? 0, color: AGING_COLORS[bucket],
      primary: formatMoneyValue(a?.principal ?? 0, currency), secondary: tr('report.dashboard.loans', { count: a?.loanCount ?? 0 }),
    };
  }));
}

const STATUS_LABEL_KEYS = {
  DRAFT: 'status.DRAFT', SUBMITTED: 'status.SUBMITTED', IN_APPROVAL: 'status.IN_APPROVAL', APPROVED: 'status.APPROVED', RETURNED: 'status.RETURNED',
  DISBURSING: 'status.DISBURSING', ACTIVE: 'status.ACTIVE', CLOSED: 'status.CLOSED', MIGRATED: 'status.MIGRATED',
} as const satisfies Record<(typeof ApplicationStatus)[number], string>;

/** Хүсэлтийн төлөв бүр ApplicationStatus дарааллаар. Урт = хүсэлтийн тоо. */
export function statusRows(byStatus: DashboardSummary['applications']['byStatus'], currency: string, tr: Translate): BarRow[] {
  const byCode = new Map(byStatus.map((s) => [s.status, s]));
  return withRatios(ApplicationStatus.map((status) => {
    const s = byCode.get(status);
    return {
      key: status, label: tr(STATUS_LABEL_KEYS[status]), value: s?.count ?? 0, color: CHART_COLORS.accent,
      primary: formatNumberValue(s?.count ?? 0, 0), secondary: formatMoneyValue(s?.amount ?? 0, currency),
    };
  }));
}

/** Топ бүтээгдэхүүн (backend-ийн дарааллаар). Урт = дүн. */
export function productRows(top: DashboardSummary['topProducts'], currency: string, tr: Translate): BarRow[] {
  return withRatios(top.map((p, i) => ({
    key: p.productId ?? `none-${i}`, label: p.productName, value: p.amount, color: CHART_COLORS.accent,
    primary: formatMoneyValue(p.amount, currency), secondary: tr('report.dashboard.applications', { count: p.count }),
  })));
}
