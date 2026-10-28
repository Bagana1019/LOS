import { API } from './config';

/** Gateway-ийн алдааны хариу: `{ code, message }` (DomainError / HttpException). `status 0` = сүлжээний алдаа. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
    readonly correlationId: string | null = null,
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
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object') {
      const b = body as { code?: unknown; message?: unknown };
      if (typeof b.code === 'string') code = b.code;
      if (typeof b.message === 'string') message = b.message;
      else if (Array.isArray(b.message)) message = b.message.map(String).join('; ');
    }
  } catch {
    // JSON биш хариу: statusText хэвээр
  }
  return new ApiError(res.status, code, message, res.headers.get('x-correlation-id') ?? correlationId);
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
    throw new ApiError(0, NETWORK_ERROR, 'Серверт холбогдож чадсангүй', correlationId);
  }
}
