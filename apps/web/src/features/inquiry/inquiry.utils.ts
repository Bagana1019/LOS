import type { InquiryItemView } from '@los/contracts';
import { formatMnt, formatNumber } from '../../lib/format';
import { hasMessage, t } from '../../lib/i18n';

const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Эх сурвалж бүрийн summary_json-оос (snake_case) богино тайлбар. Мэдэгдэхгүй бол хоосон мөр. */
export function summaryLines(item: Pick<InquiryItemView, 'source' | 'status' | 'summary'>): string[] {
  if (item.status === 'MISSING') return [];
  const s = item.summary;
  switch (item.source) {
    case 'CIB':
      return [
        t('inquiry.summary.activeLoans', { n: formatNumber(n(s.active_loan_count) ?? 0) }),
        t('inquiry.summary.monthlyPayment', { amount: formatMnt(n(s.monthly_payment) ?? 0) }),
        t('inquiry.summary.outstanding', { amount: formatMnt(n(s.outstanding) ?? 0) }),
      ];
    case 'FICO': return [t('inquiry.summary.fico', { n: formatNumber(n(s.fico_score) ?? 0) })];
    case 'DTI': return [t('inquiry.summary.dti', { n: String(n(s.dti) ?? '—') })];
    case 'LIVESTOCK': return [t('inquiry.summary.heads', { n: formatNumber(n(s.total_heads) ?? 0) })];
    case 'XYP_PROPERTY':
    case 'XYP_VEHICLE':
    case 'XYP_LEGAL': return [t('inquiry.summary.count', { n: formatNumber(n(s.count) ?? 0) })];
    case 'XYP_PENSION': return [s.is_pensioner ? t('inquiry.summary.pension', { amount: formatMnt(n(s.monthly_pension) ?? 0) }) : t('inquiry.summary.no')];
    case 'XYP_CRIMINAL': return [s.has_record ? t('inquiry.summary.yes') : t('inquiry.summary.no')];
    case 'XYP_COURT_DEBT': return [s.has_debt ? t('inquiry.summary.courtDebt', { amount: formatMnt(n(s.total_amount) ?? 0) }) : t('inquiry.summary.no')];
    case 'BLACKLIST': return [s.hit ? t('inquiry.summary.hit') : t('inquiry.summary.clear')];
    default: return [];
  }
}

export const statusColor = (status: InquiryItemView['status']): string => (status === 'FRESH' ? 'success' : status === 'STALE' ? 'warning' : 'default');
export const warningColor = (level: InquiryItemView['warningLevel']): string => (level === 'RED' ? 'error' : level === 'WARNING' ? 'warning' : 'default');

// ── Дэлгэрэнгүй (таб бүр) ───────────────────────────────────────────────────────────
type Scalar = string | number | boolean | null;
export interface DetailTable { key: string; rows: Record<string, Scalar>[]; columns: string[] }
export interface DetailView { fields: { key: string; value: Scalar }[]; tables: DetailTable[] }

const isScalar = (v: unknown): v is Scalar => v === null || ['string', 'number', 'boolean'].includes(typeof v);
const flat = (o: Record<string, unknown>): Record<string, Scalar> => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, isScalar(v) ? v : JSON.stringify(v)]));

/** Лавлагааны `detail`-ийг (гадаад системийн хариу) нэг түвшний талбар + хүснэгт болгон хуваана. Массив → хүснэгт, объект → түүний талбарууд (`parent.key`). */
export function detailView(detail: Record<string, unknown> | null | undefined): DetailView {
  const view: DetailView = { fields: [], tables: [] };
  if (!detail) return view;
  for (const [key, v] of Object.entries(detail)) {
    if (isScalar(v)) view.fields.push({ key, value: v });
    else if (Array.isArray(v)) {
      const rows = v.map((x) => (x && typeof x === 'object' && !Array.isArray(x) ? flat(x as Record<string, unknown>) : { value: isScalar(x) ? x : JSON.stringify(x) }));
      if (rows.length) view.tables.push({ key, rows, columns: [...new Set(rows.flatMap((r) => Object.keys(r)))] });
    } else for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) view.fields.push({ key: `${key}.${k2}`, value: isScalar(v2) ? v2 : JSON.stringify(v2) });
  }
  return view;
}

/** Талбарын нэр: `inquiry.field.<key>` орчуулга байвал түүгээр, үгүй бол түлхүүрээр. */
export const fieldLabel = (key: string): string => (hasMessage(`inquiry.field.${key}`) ? t(`inquiry.field.${key}`) : key);

const MONEY_KEY = /(amount|outstanding|payment|disbursed|pension|total|salary)/i;
export function formatDetailValue(key: string, v: Scalar): string {
  if (v === null || v === '') return '—';
  if (typeof v === 'boolean') return v ? t('inquiry.summary.yes') : t('inquiry.summary.no');
  if (typeof v === 'number') return MONEY_KEY.test(key) && !/count/i.test(key) ? formatMnt(v) : formatNumber(v);
  return v;
}
