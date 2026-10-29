import { formatMnt } from '../../lib/format';
import { hasMessage, t } from '../../lib/i18n';
import { isApiError } from '../../lib/merchant-api';
// ApiError → мэргэжлийн монгол мессеж. Серверийн англи `message`-ийг хэзээ ч хэрэглэгчид харуулахгүй (POS-BR-6/7: дотоод мэдээлэл задрахгүй).

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 401/403 (нэвтрээгүй / эрхгүй) → "хандах эрхгүй" төлөв. STORE_SCOPE_VIOLATION нь үйлдлийн алдаа тул энд орохгүй. */
export function isNoAccess(e: unknown): boolean {
  return isApiError(e) && (e.code === 'UNAUTHENTICATED' || e.code === 'FORBIDDEN' || e.status === 401 || (e.status === 403 && e.code !== 'STORE_SCOPE_VIOLATION'));
}
export const isNotFound = (e: unknown): boolean => isApiError(e) && e.code === 'NOT_FOUND';
export const isNetworkError = (e: unknown): boolean => isApiError(e) && e.code === 'NETWORK_ERROR';

/** Алдааны монгол мессеж; `details`-д тоо байвал тодорхой хувилбарыг ашиглана. */
export function errorMessage(e: unknown): string {
  if (!isApiError(e)) return t('error.UNKNOWN');
  const d = e.details ?? {};
  switch (e.code) {
    case 'DOWN_PAYMENT_TOO_LOW':
      if (isNum(d.minDownPayment)) return t('error.DOWN_PAYMENT_TOO_LOW.withMin', { min: formatMnt(d.minDownPayment) });
      break;
    case 'AMOUNT_OUT_OF_RANGE':
      if (isNum(d.minAmount) && isNum(d.maxAmount)) return t('error.AMOUNT_OUT_OF_RANGE.withRange', { min: formatMnt(d.minAmount), max: formatMnt(d.maxAmount) });
      break;
    case 'TICKET_LIMIT_EXCEEDED':
      if (isNum(d.maxTicketAmount)) return t('error.TICKET_LIMIT_EXCEEDED.withMax', { max: formatMnt(d.maxTicketAmount) });
      break;
    case 'DAILY_LIMIT_EXCEEDED':
      if (isNum(d.dailyLimitAmount)) return t('error.DAILY_LIMIT_EXCEEDED.withLimit', { limit: formatMnt(d.dailyLimitAmount) });
      break;
    case 'TERM_NOT_ALLOWED':
      if (Array.isArray(d.allowed) && d.allowed.every(isNum) && d.allowed.length > 0) return t('error.TERM_NOT_ALLOWED.withAllowed', { terms: d.allowed.join(', ') });
      break;
    case 'OTP_INVALID':
      if (isNum(d.attemptsLeft)) return t('error.OTP_INVALID.withLeft', { left: d.attemptsLeft });
      break;
    case 'OTP_RESEND_TOO_SOON':
      if (isNum(d.retryAfterSeconds)) return t('error.OTP_RESEND_TOO_SOON.withWait', { seconds: d.retryAfterSeconds });
      break;
    case 'OTP_ATTEMPTS_EXCEEDED':
      // MAX_SENDS: нэг лизингийн кодын илгээлтийн хязгаар дууссан → "шинэ код авна уу" гэж хэлж болохгүй (POS-BR-8).
      if (d.reason === 'MAX_SENDS') return t('error.OTP_ATTEMPTS_EXCEEDED.maxSends');
      break;
    default:
      break;
  }
  return hasMessage(`error.${e.code}`) ? t(`error.${e.code}`) : t('error.UNKNOWN');
}

/** Серверийн төлөв өөрчлөгдсөн байж болзошгүй алдааны кодууд (OTP_INVALID, баталгаажуулалтын алдаа орохгүй). */
const STATE_CHANGING_CODES: ReadonlySet<string> = new Set(['INVALID_TRANSITION', 'CONCURRENT_UPDATE', 'OFFER_EXPIRED', 'MERCHANT_NOT_ACTIVE', 'SCREENING_UNAVAILABLE', 'SMS_UNAVAILABLE']);

/**
 * Амжилтгүй mutation-ы дараа лизингийн төлөв серверт өөрчлөгдсөн байж болох уу? (409, 503/5xx, сүлжээ тасрал, INVALID_TRANSITION, SCREENING_UNAVAILABLE …)
 * true бол дуудагч лизингийн query-г дахин татаж `allowedActions`-ийг сервертэй тулгана. Буруу код (OTP_INVALID) ба талбарын алдаанд false — төлөв өөрчлөгдөөгүй.
 */
export function leaseStateMayHaveChanged(e: unknown): boolean {
  if (!isApiError(e)) return false;
  return e.status === 409 || e.status >= 500 || e.code === 'NETWORK_ERROR' || STATE_CHANGING_CODES.has(e.code);
}

/** OTP_RESEND_TOO_SOON-ийн хүлээх секунд. */
export function retryAfterSeconds(e: unknown): number | null {
  return isApiError(e) && isNum(e.details?.retryAfterSeconds) ? e.details.retryAfterSeconds : null;
}

export interface FieldIssue { path: string[]; message: string }
/** VALIDATION_FAILED → [{ path: ['buyer','registerNo'], message }] (серверийн `details.issues`). */
export function fieldIssues(e: unknown): FieldIssue[] {
  if (!isApiError(e) || e.code !== 'VALIDATION_FAILED') return [];
  const issues = e.details?.issues;
  if (!Array.isArray(issues)) return [];
  const out: FieldIssue[] = [];
  for (const i of issues) {
    if (i && typeof i === 'object' && typeof (i as { path?: unknown }).path === 'string') out.push({ path: String((i as { path: string }).path).split('.').filter(Boolean), message: String((i as { message?: unknown }).message ?? '') });
  }
  return out;
}

/** TanStack Query retry: 4xx-д дахин оролдохгүй; сүлжээ/5xx-д хязгаартай. */
export function shouldRetry(failureCount: number, e: unknown): boolean {
  if (isApiError(e)) {
    if (e.code === 'NETWORK_ERROR') return failureCount < 2;
    if (e.code === 'INTERNAL') return failureCount < 1;
    return false;
  }
  return failureCount < 1;
}
