import { HttpStatus } from '@nestjs/common';
import { CTX_HEADERS, type RequestContext } from '@los/contracts';
import type { ZodType } from 'zod';
import { getRequestContext } from '../context/request-context';
import { DomainError } from '../http/errors';

export type ServiceName = 'origination' | 'kyc' | 'scoring' | 'valuation' | 'dms' | 'gateway';
const DEFAULT_URLS: Record<ServiceName, string> = {
  gateway: 'http://localhost:4000', origination: 'http://localhost:4001', kyc: 'http://localhost:4002',
  scoring: 'http://localhost:4003', valuation: 'http://localhost:4004', dms: 'http://localhost:4005',
};
/** `KYC_URL` гэх мэт env, байхгүй бол localhost портууд (CLAUDE.md §2.1). */
export const serviceUrl = (s: ServiceName, env: NodeJS.ProcessEnv = process.env): string => (env[`${s.toUpperCase()}_URL`] ?? DEFAULT_URLS[s]).replace(/\/$/, '');

export interface CallOptions<T> {
  ctx?: RequestContext;
  /** CLAUDE.md §3.1: дотоод 3с, гадаад интеграци дамжуулах дуудлага 15с. */
  timeoutMs?: number;
  schema?: ZodType<T>;
  query?: Record<string, string | number | boolean | undefined>;
}
export class UpstreamError extends DomainError {
  constructor(readonly service: ServiceName, readonly upstreamStatus: number | null, message: string, status: number, readonly upstreamBody?: unknown) {
    super(status === 504 ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_ERROR', message, status, { service, upstreamStatus });
  }
}

export interface InternalHttpOptions { fetchFn?: typeof fetch; env?: NodeJS.ProcessEnv; sleep?: (ms: number) => Promise<void> }

/**
 * Sync REST дуудлага (origination → kyc | scoring | valuation | dms). Контекст толгойг дамжуулна, timeout тавина,
 * ЗӨВХӨН idempotent GET-ийг нэг удаа дахин оролдоно (CLAUDE.md §3.1, §3.2.2).
 */
export class InternalHttpClient {
  private readonly fetchFn: typeof fetch;
  private readonly env: NodeJS.ProcessEnv;
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(opts: InternalHttpOptions = {}) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.env = opts.env ?? process.env;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get<T = unknown>(service: ServiceName, path: string, opts: CallOptions<T> = {}): Promise<T> { return this.request('GET', service, path, undefined, opts); }
  post<T = unknown>(service: ServiceName, path: string, body: unknown, opts: CallOptions<T> = {}): Promise<T> { return this.request('POST', service, path, body, opts); }
  put<T = unknown>(service: ServiceName, path: string, body: unknown, opts: CallOptions<T> = {}): Promise<T> { return this.request('PUT', service, path, body, opts); }

  private async request<T>(method: string, service: ServiceName, path: string, body: unknown, opts: CallOptions<T>): Promise<T> {
    const attempts = method === 'GET' ? 2 : 1;
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await this.once<T>(method, service, path, body, opts);
      } catch (e) {
        last = e;
        const retryable = e instanceof UpstreamError && (e.upstreamStatus === null || e.upstreamStatus >= 500);
        if (!retryable || i === attempts - 1) throw e;
        await this.sleep(150);
      }
    }
    throw last;
  }

  private async once<T>(method: string, service: ServiceName, path: string, body: unknown, opts: CallOptions<T>): Promise<T> {
    const ctx = opts.ctx ?? getRequestContext();
    const url = new URL(`${serviceUrl(service, this.env)}${path.startsWith('/') ? path : `/${path}`}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (ctx) {
      if (ctx.userId) headers[CTX_HEADERS.userId] = ctx.userId;
      if (ctx.roles.length) headers[CTX_HEADERS.roles] = ctx.roles.join(',');
      if (ctx.branchId) headers[CTX_HEADERS.branchId] = ctx.branchId;
      if (ctx.orgId) headers[CTX_HEADERS.orgId] = ctx.orgId;
      if (ctx.customerId) headers[CTX_HEADERS.customerId] = ctx.customerId;
      headers[CTX_HEADERS.correlationId] = ctx.correlationId;
    }
    const secret = this.env.INTERNAL_AUTH_SECRET;
    if (secret) headers[CTX_HEADERS.internalToken] = secret;

    let res: Response;
    try {
      res = await this.fetchFn(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(opts.timeoutMs ?? 3000) });
    } catch (e) {
      const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      throw new UpstreamError(service, null, timeout ? `${service} хариу өгсөнгүй (timeout)` : `${service} сервис руу холбогдож чадсангүй`, timeout ? HttpStatus.GATEWAY_TIMEOUT : HttpStatus.BAD_GATEWAY);
    }
    const text = await res.text();
    let json: unknown = undefined;
    if (text) { try { json = JSON.parse(text); } catch { json = text; } }
    if (!res.ok) {
      // 4xx: upstream-ийн `code`/`message`-ийг хэвээр дамжуулна (жишээ нь VALIDATION_FAILED); 5xx: 502
      const o = (json && typeof json === 'object' ? json : {}) as { code?: string; message?: string; details?: unknown };
      if (res.status >= 400 && res.status < 500) throw new DomainError(o.code ?? 'UPSTREAM_REJECTED', o.message ?? `${service}: ${res.status}`, res.status, o.details);
      throw new UpstreamError(service, res.status, `${service} алдаа буцаалаа (${res.status})`, HttpStatus.BAD_GATEWAY, json);
    }
    return opts.schema ? opts.schema.parse(json) : (json as T);
  }
}
