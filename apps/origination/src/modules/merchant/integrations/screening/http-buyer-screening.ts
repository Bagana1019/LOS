import { Logger } from '@nestjs/common';
import { GATEWAY_HEADERS, PosScreeningResponse, type PosScreeningRequest } from '@los/contracts';
import { DomainError } from '../../domain/errors';
import { BuyerScreeningPort, type ScreeningContext } from '../../ports';

export interface HttpScreeningOptions {
  baseUrl: string;
  timeoutMs?: number;
  /** тестэд */
  fetchImpl?: typeof fetch;
}

export const SCREENING_TIMEOUT_MS = 15_000;
const unavailable = () => new DomainError('SCREENING_UNAVAILABLE', 'Credit screening is temporarily unavailable');

const isAbort = (e: unknown) => (e as { name?: unknown } | null)?.name === 'AbortError';

/** Алдааны ТӨРӨЛ (тогтмол жагсаалт; хариуны бие, URL, алдааны текст, PII хэзээ ч орохгүй). */
function failureClass(e: unknown): string {
  if (isAbort(e)) return 'timeout';
  const cause = (e as { cause?: { message?: unknown; code?: unknown } } | null)?.cause;
  if (typeof cause?.message === 'string' && /redirect/i.test(cause.message)) return 'redirect';
  return typeof cause?.code === 'string' && /^[A-Z0-9_]{3,40}$/.test(cause.code) ? `network:${cause.code}` : 'network';
}

/**
 * origination → kyc `POST /api/inquiry/pos-screening` (sync, timeout 15с, retry ҮГҮЙ — CLAUDE.md §3.1).
 * Сүлжээ/timeout/5xx/буруу хариу бүр SCREENING_UNAVAILABLE. Алдаанд хариуны бие/PII оруулахгүй.
 * - `redirect: 'error'`: 307/308 нь регистр, утас агуулсан бие рүү өөр хост руу дахин илгээгдэхгүй.
 * - Толгой: `x-correlation-id` + (context өгвөл) `x-org-id` — PII-гүй (CLAUDE.md §3.2.9, §3.2.10).
 * - Алдааг ТӨРЛӨӨР нь (timeout / network / http_5xx / invalid_json / invalid_schema) warn түвшинд логлоно, бие/PII-гүй.
 */
export class HttpBuyerScreening extends BuyerScreeningPort {
  private readonly logger = new Logger('HttpBuyerScreening');
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpScreeningOptions) {
    super();
    this.url = `${opts.baseUrl.replace(/\/+$/, '')}/api/inquiry/pos-screening`;
    this.timeoutMs = opts.timeoutMs ?? SCREENING_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async screen(req: PosScreeningRequest, correlationId: string, context?: ScreeningContext): Promise<PosScreeningResponse> {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json', [GATEWAY_HEADERS.correlationId]: correlationId };
    if (context?.orgId) headers[GATEWAY_HEADERS.orgId] = context.orgId;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(this.url, { method: 'POST', headers, body: JSON.stringify(req), signal: controller.signal, redirect: 'error' });
      } catch (e) {
        throw this.fail(correlationId, failureClass(e));
      }
      if (!res.ok) throw this.fail(correlationId, `http_${res.status}`);
      let body: unknown;
      try {
        body = await res.json();
      } catch (e) {
        throw this.fail(correlationId, isAbort(e) ? 'timeout' : 'invalid_json');
      }
      const parsed = PosScreeningResponse.safeParse(body);
      if (!parsed.success) throw this.fail(correlationId, 'invalid_schema');
      return parsed.data;
    } finally {
      clearTimeout(timer);
    }
  }

  private fail(correlationId: string, reason: string): DomainError {
    this.logger.warn(`[${correlationId}] pos-screening failed: ${reason}`);
    return unavailable();
  }
}
