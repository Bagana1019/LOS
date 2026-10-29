import type { PortalErrorCode } from '@los/contracts';

export interface ErrorDetail {
  path: string;
  message: string;
}

/** Харилцагчид харагдах бүх алдааны нэг төрөл. HTTP төлөв, монгол мессеж нь error-catalog-оос. */
export class PortalError extends Error {
  constructor(
    readonly code: PortalErrorCode,
    readonly details?: ErrorDetail[],
    readonly headers?: Record<string, string>,
  ) {
    super(code);
    this.name = 'PortalError';
  }
}
