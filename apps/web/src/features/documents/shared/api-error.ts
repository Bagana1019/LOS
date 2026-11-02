import { hasMessage, t } from '../../../lib/i18n';

// Collateral ба document алхмын нийтлэг API алдааны тайлбар. Түлхүүр нь `<scope>.error.<КОД>` (collateral.* / document.*).
// Дүрэм: сервер монгол (кирилл) мессеж өгсөн бол түүнийг (тодорхой, нөхцөлтэй) хэвээр харуулна; үгүй бол кодын орчуулга, түүнгүй бол статусын ерөнхий мессеж.

export type ErrorScope = 'collateral' | 'document';

export interface DescribedError {
  code: string | null;
  status: number | null;
  message: string;
  /** VALIDATION_FAILED үед талбар тус бүрийн тайлбар. */
  issues: string[];
}

const CYRILLIC_LETTERS = /[Ѐ-ӿ]/g;
const LATIN_LETTERS = /[A-Za-z]/g;
/**
 * Мессеж монгол (кирилл) эсэх: кирилл үсэг латинаас цөөн биш байх. Кирилл үсэг ганцхан байхад хангалтгүй —
 * «Plate number must be … e.g. УЕН5246» гэх мэт англи мессежид кирилл жишээ орсон байж болно.
 */
export const isMongolianText = (s: string): boolean => {
  const cyrillic = s.match(CYRILLIC_LETTERS)?.length ?? 0;
  const latin = s.match(LATIN_LETTERS)?.length ?? 0;
  return cyrillic > 0 && cyrillic >= latin;
};

export const errorKey = (scope: ErrorScope, code: string): string => `${scope}.error.${code}`;
/** Хоёр scope-д заавал байх ерөнхий алдааны түлхүүрүүд (тестэд шалгана). */
export const GENERIC_ERROR_CODES = ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'FILE_TOO_LARGE', 'FILE_TYPE_NOT_ALLOWED', 'SERVER', 'NETWORK', 'UNKNOWN', 'FIELD_INVALID'] as const;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function describeApiError(error: unknown, scope: ErrorScope): DescribedError {
  const e = (typeof error === 'object' && error !== null ? error : {}) as { status?: unknown; code?: unknown; message?: unknown; issues?: unknown };
  const code = str(e.code);
  const status = typeof e.status === 'number' ? e.status : null;
  const serverMessage = str(e.message);
  const generic = (key: string, issues: string[] = []): DescribedError => ({ code, status, message: t(errorKey(scope, key)), issues });

  if (error instanceof TypeError || status === 0 || code === 'NETWORK_ERROR') return generic('NETWORK');
  if (status === 401) return generic('UNAUTHENTICATED');
  if (status === 403) return generic('FORBIDDEN');

  if (code === 'VALIDATION_FAILED') {
    const issues = Array.isArray(e.issues)
      ? e.issues.flatMap((raw: unknown) => {
          const issue = raw as { path?: unknown; message?: unknown } | null;
          const message = str(issue?.message);
          if (message && isMongolianText(message)) return [message];
          const path = str(issue?.path);
          return path ? [t(errorKey(scope, 'FIELD_INVALID'), { field: path })] : [];
        })
      : [];
    return generic('VALIDATION_FAILED', issues);
  }
  // Монгол мессеж өгсөн (DomainError) → тэр. Gateway/proxy-ийн англи "Not Found", "Bad Gateway" гэх мэтийг ашиглахгүй.
  if (serverMessage && isMongolianText(serverMessage)) return { code, status, message: serverMessage, issues: [] };
  if (code && hasMessage(errorKey(scope, code))) return generic(code);
  if (status === 404) return generic('NOT_FOUND');
  if (status === 413) return generic('FILE_TOO_LARGE');
  if (status === 415) return generic('FILE_TYPE_NOT_ALLOWED');
  if (status !== null && status >= 500) return generic('SERVER');
  return generic('UNKNOWN');
}

/** 404/409 — сервер дээрх төлөв манайхаас зөрсөн (өөр хүн засчээ, хүсэлтийн төлөв солигдсон) → өгөгдлийг дахин татна. */
export const isStaleStateError = (error: unknown): boolean => {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 404 || status === 409;
};

/** 4xx (эрх, олдсонгүй, дүрмийн зөрчил) дахин оролдсоноор засагдахгүй. Сүлжээ/серверийн алдааг л нэг удаа дахин оролдоно. */
export const retryTransient = (failureCount: number, error: unknown): boolean => {
  const status = (error as { status?: unknown } | null)?.status;
  return failureCount < 1 && !(typeof status === 'number' && status >= 400 && status < 500);
};
