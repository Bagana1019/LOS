import { IntegrationError, type IntegrationContext } from './integration.types';

/** Runs an adapter call under a deadline (15 s for external systems, CLAUDE.md §3.1). `fn` receives a signal that is aborted on timeout. */
export async function callWithTimeout<T>(
  integration: string,
  timeoutMs: number,
  base: { correlationId: string; now: Date },
  fn: (ctx: IntegrationContext) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new IntegrationError(integration, 'TIMEOUT', `${integration} did not answer within ${timeoutMs} ms`);
      // Reject first: an abort listener in `fn` may reject synchronously and must not win the race with the TIMEOUT error.
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });
  try {
    // Promise.race subscribes to `fn`'s promise too, so a rejection that arrives after the timeout is never unhandled.
    return await Promise.race([fn({ ...base, signal: controller.signal }), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
