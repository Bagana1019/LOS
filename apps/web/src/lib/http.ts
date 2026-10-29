import { t } from '@los/ui';
import { API } from './config';

export interface ApiIssue {
  path: string;
  message: string;
}

/**
 * Gateway-ийн алдааны хариу: `{ code, message }` (DomainError / HttpException). `status 0` = сүлжээний алдаа.
 * `issues` = zod шалгалтын алдаа (`VALIDATION_FAILED`), feature-ийн алдааны хэсгүүд (`e.issues`) уншина.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
    readonly issues?: ApiIssue[],
    readonly correlationId: string | null = null,
    /** Сүлжээний алдаа (status 0) үед fetch-ийн анхны `TypeError`. */
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const NETWORK_ERROR = 'NETWORK_ERROR';

/** CLAUDE.md §3.2.10: хүсэлт бүр correlationId дамжуулна. `crypto.randomUUID` нь secure context-д л байдаг тул нөөцтэй. */
export function newCorrelationId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function readError(res: Response, correlationId: string): Promise<ApiError> {
  let code: string | null = null;
  let message = res.statusText || `HTTP ${res.status}`;
  let issues: ApiIssue[] | undefined;
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object') {
      const b = body as { code?: unknown; message?: unknown; details?: unknown; issues?: unknown };
      if (typeof b.code === 'string') code = b.code;
      if (typeof b.message === 'string') message = b.message;
      else if (Array.isArray(b.message)) message = b.message.map(String).join('; ');
      // Module 0 AllExceptionsFilter: zod алдаа = { code: 'VALIDATION_FAILED', details: [{ path, message }] }
      const raw = code === 'VALIDATION_FAILED' && Array.isArray(b.details) ? b.details : b.issues;
      if (Array.isArray(raw)) issues = raw as ApiIssue[];
    }
  } catch {
    // JSON биш хариу: statusText хэвээр
  }
  return new ApiError(res.status, code, message, issues, res.headers?.get?.('x-correlation-id') ?? correlationId);
}

export interface SendOptions {
  method?: string;
  body?: unknown;
  token?: string | null;
  signal?: AbortSignal;
}

/** Нэг fetch: cookie (`los_rt`) дамжуулна, JSON body, correlationId. Сүлжээний алдааг ApiError(0) болгоно. */
export async function send(path: string, o: SendOptions = {}): Promise<{ res: Response; correlationId: string }> {
  const correlationId = newCorrelationId();
  const headers: Record<string, string> = { accept: 'application/json', 'x-correlation-id': correlationId };
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  try {
    const res = await fetch(`${API}${path}`, {
      method: o.method ?? 'GET',
      headers,
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
      credentials: 'include',
      signal: o.signal,
    });
    return { res, correlationId };
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(0, NETWORK_ERROR, t('shell.unreachable.title'), undefined, correlationId, e);
  }
}
