import { hasMessage, t } from '../../lib/i18n';

export interface DescribedCustomerError { code: string | null; message: string; customerId?: string }

/** ApiError → монгол мессеж. Сервер `error.<КОД>` түлхүүрийг mn.customer.json-д тодорхойлсон; үгүй бол статусаар. */
export function describeCustomerError(error: unknown): DescribedCustomerError {
  const e = (typeof error === 'object' && error !== null ? error : {}) as { status?: unknown; code?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : null;
  const status = typeof e.status === 'number' ? e.status : null;
  if (code && hasMessage(`error.${code}`)) return { code, message: t(`error.${code}`) };
  if (status === 403) return { code, message: t('customer.error.FORBIDDEN') };
  if (error instanceof TypeError || status === 0) return { code, message: t('customer.error.NETWORK') };
  if (status !== null && status < 500 && typeof e.message === 'string' && e.message) return { code, message: e.message };
  return { code, message: t('customer.error.UNKNOWN') };
}
