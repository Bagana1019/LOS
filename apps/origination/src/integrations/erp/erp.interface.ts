// Санхүүгийн систем (ERP / Core banking) рүү бизнес үйл явдал дамжуулах port. ERP журналаа өөрөө үүсгэнэ. CLAUDE.md §3.2-7: interface + Mock + Real, INTEGRATION_MODE-оор солино.
import type { ErpEventPayload } from '@los/contracts';

export interface ErpPostContext { correlationId: string; attemptNo: number; }
// duplicate=true — тухайн idempotencyKey-ийг өмнө нь хүлээн авсан (дахин илгээлт), амжилт гэж үзнэ
export interface ErpPostResult { externalRef: string | null; duplicate: boolean; }

export interface ErpGateway {
  readonly name: string;
  // Нэг idempotencyKey-г олон удаа илгээхэд ERP-д нэг л үйл явдал бүртгэгдэх ёстой (at-least-once дамжуулалт).
  post(payload: ErpEventPayload, ctx: ErpPostContext): Promise<ErpPostResult>;
}

// RETRYABLE: сүлжээ, timeout, 5xx, 429 — outbox backoff-оор дахин оролдоно. PERMANENT: payload татгалзагдсан — DEAD, хүн засна.
export type ErpErrorKind = 'RETRYABLE' | 'PERMANENT';
export class ErpPostError extends Error {
  constructor(
    message: string, readonly kind: ErpErrorKind, readonly code: string,
    readonly httpStatus?: number, readonly retryAfterMs?: number,
  ) { super(message); this.name = 'ErpPostError'; }
}

export const ERP_GATEWAY = Symbol('ERP_GATEWAY');
