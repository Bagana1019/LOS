import type { z } from 'zod';
import { API } from './config';
import { ApiError, readError, send } from './http';
import { endSession, getAccessToken, refreshSession } from './auth/session';

export { API, ApiError };

export interface ApiOptions<T> {
  method?: string;
  body?: unknown;
  /** Хариуг zod-оор шалгана (`@los/contracts`-ийн схем). */
  schema?: z.ZodType<T, z.ZodTypeDef, unknown>;
  signal?: AbortSignal;
}

/** Gateway руу JSON дуудлага. 401 бол нэг удаа refresh хийж дахин оролдоно; refresh бүтэлгүйтвэл сессийг дуусгана. */
export async function apiFetch<T = unknown>(path: string, o: ApiOptions<T> = {}): Promise<T> {
  const opts = { method: o.method, body: o.body, signal: o.signal };
  let { res, correlationId } = await send(path, { ...opts, token: getAccessToken() });
  if (res.status === 401) {
    const refreshed = await refreshSession();
    if (refreshed) ({ res, correlationId } = await send(path, { ...opts, token: getAccessToken() }));
    if (!refreshed || res.status === 401) {
      endSession();
      throw await readError(res, correlationId);
    }
  }
  if (!res.ok) throw await readError(res, correlationId);
  if (res.status === 204) return undefined as T;
  const json: unknown = await res.json();
  return o.schema ? o.schema.parse(json) : (json as T);
}
