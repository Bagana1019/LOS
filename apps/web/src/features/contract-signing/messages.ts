import type { SigningFailureReason } from '@los/contracts';
import { t, type MnKey } from '../esign/i18n';
import type { SigningApiError, SigningApiErrorKind } from './api';
import type { PanelStatus } from './status';

const STATUS_KEYS = {
  NONE: 'contractSigning.status.NONE',
  PENDING: 'contractSigning.status.PENDING',
  IN_PROGRESS: 'contractSigning.status.IN_PROGRESS',
  FINALIZING: 'contractSigning.status.FINALIZING',
  SIGNED: 'contractSigning.status.SIGNED',
  DECLINED: 'contractSigning.status.DECLINED',
  EXPIRED: 'contractSigning.status.EXPIRED',
  FAILED: 'contractSigning.status.FAILED',
  CANCELLED: 'contractSigning.status.CANCELLED',
} as const satisfies Record<PanelStatus, MnKey>;

export const statusLabel = (status: PanelStatus): string => t(STATUS_KEYS[status]);

const FAILURE_KEYS = {
  DECLINED: 'contractSigning.failure.DECLINED',
  EXPIRED: 'contractSigning.failure.EXPIRED',
  IDENTITY_MISMATCH: 'contractSigning.failure.IDENTITY_MISMATCH',
  INTEGRITY_ERROR: 'contractSigning.failure.INTEGRITY_ERROR',
  PROVIDER_ERROR: 'contractSigning.failure.PROVIDER_ERROR',
  CANCELLED: 'contractSigning.failure.CANCELLED',
} as const satisfies Record<SigningFailureReason, MnKey>;

export const failureLabel = (reason: SigningFailureReason): string => t(FAILURE_KEYS[reason]);

const ERROR_KEYS = {
  NETWORK: 'contractSigning.error.network',
  FORBIDDEN: 'contractSigning.error.forbidden',
  NOT_FOUND: 'contractSigning.error.generic',
  CONFLICT: 'contractSigning.error.conflict',
  RATE_LIMITED: 'contractSigning.error.rateLimited',
  INVALID_REQUEST: 'contractSigning.error.generic',
  SERVER: 'contractSigning.error.server',
  INVALID_RESPONSE: 'contractSigning.error.invalidResponse',
} as const satisfies Record<SigningApiErrorKind, MnKey>;

/** Backend-ийн өгсөн ойлгомжтой тайлбар (409 "Хүсэлт батлагдаагүй…" гэх мэт) байвал түүнийг, үгүй бол төрлөөр нь */
export const errorText = (err: SigningApiError): string => err.serverMessage ?? t(ERROR_KEYS[err.kind]);
