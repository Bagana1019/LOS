import type { InquiryItemView } from '@los/contracts';
import { formatMnt, formatNumber } from '../../lib/format';
import { t } from '../../lib/i18n';

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
