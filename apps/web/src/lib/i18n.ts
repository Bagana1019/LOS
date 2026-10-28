import { mn } from '@los/ui';

/** t('payment.title') · t('payment.due', { date: '2026-10-28' }) — {date} placeholder-ийг солино. Түлхүүр олдохгүй бол түлхүүрийг буцаана. */
export function t(key: string, params?: Record<string, string | number>): string {
  const raw = mn[key] ?? key;
  return params ? raw.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? `{${k}}`)) : raw;
}

export const formatMoney = (n: number, currency = 'MNT') => `${new Intl.NumberFormat('mn-MN', { maximumFractionDigits: 2 }).format(n)} ${currency === 'MNT' ? '₮' : currency}`;
