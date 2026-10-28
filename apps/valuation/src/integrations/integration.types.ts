// Shared shapes of the external-integration adapters (CLAUDE.md §3.2 rule 7).
export interface IntegrationContext {
  correlationId: string;
  /** Request time; adapters derive relative dates from it so mocks stay deterministic. */
  now: Date;
  /** Aborted when the call exceeds its timeout (15 s for external systems, CLAUDE.md §3.1). */
  signal: AbortSignal;
}

export type IntegrationErrorCode = 'UNAVAILABLE' | 'TIMEOUT' | 'BAD_RESPONSE' | 'NOT_IMPLEMENTED';

export class IntegrationError extends Error {
  constructor(
    readonly integration: string,
    readonly code: IntegrationErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'IntegrationError';
  }
}
