import type { ESignProvider, PublicSigningSession, SigningFailureReason } from '@los/contracts';
import type { EsignErrorKind } from './api';
import { t, type MnKey } from './i18n';

// FR-11.4 — төрөл → монгол текстийн хүснэгтүүд. `satisfies Record<…>` нь enum-д шинэ утга нэмэхэд tsc-ээр барина.

const FAILURE_KEYS = {
  DECLINED: 'esign.failed.DECLINED',
  EXPIRED: 'esign.failed.EXPIRED',
  IDENTITY_MISMATCH: 'esign.failed.IDENTITY_MISMATCH',
  INTEGRITY_ERROR: 'esign.failed.INTEGRITY_ERROR',
  PROVIDER_ERROR: 'esign.failed.PROVIDER_ERROR',
  CANCELLED: 'esign.failed.CANCELLED',
} as const satisfies Record<SigningFailureReason, MnKey>;

/** Зээлдэгчид харуулах шалтгаан; шалтгаан үл мэдэгдэх (null) бол ерөнхий мессеж */
export function failureMessage(reason: SigningFailureReason | null): string {
  return t(reason === null ? 'esign.failed.UNKNOWN' : FAILURE_KEYS[reason]);
}

const ERROR_KEYS = {
  NOT_FOUND: 'esign.error.notFoundBody',
  GONE: 'esign.expired.body',
  RATE_LIMITED: 'esign.error.rateLimited',
  CONFLICT: 'esign.error.conflict',
  INVALID_REQUEST: 'esign.error.invalidRequest',
  SERVER: 'esign.error.server',
  NETWORK: 'esign.error.network',
  INVALID_RESPONSE: 'esign.error.invalidResponse',
} as const satisfies Record<EsignErrorKind, MnKey>;

export function errorMessage(kind: EsignErrorKind): string {
  return t(ERROR_KEYS[kind]);
}

const PROVIDER_KEYS = {
  TRIDUM: 'esign.provider.TRIDUM',
  MONPASS: 'esign.provider.MONPASS',
} as const satisfies Record<ESignProvider, MnKey>;

export function providerName(code: ESignProvider): string {
  return t(PROVIDER_KEYS[code]);
}

/** Session-д байгаа үйлчилгээний нэр (сервер өгсөн displayName), байхгүй бол толь бичгийн нэр */
export function sessionProviderName(session: PublicSigningSession): string {
  if (session.provider === null) return '';
  return session.providers.find((p) => p.code === session.provider)?.displayName || providerName(session.provider);
}
