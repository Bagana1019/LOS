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

/**
 * Gateway руу JSON дуудлага. 401 бол token шинэчлээд дахин оролдоно.
 * Refresh бүр хуучин session мөрийг хүчингүй болгодог (gateway) тул өөр хүсэлт/таб token-ийг аль хэдийн шинэчилсэн байж болно:
 *   1) token солигдсон бол refresh хийхгүйгээр шинэ token-оор давтана;
 *   2) үгүй бол refresh хийж давтана;
 *   3) тэр ч 401 бол (дундуур өөр refresh орсон) нэг л удаа дахин refresh хийнэ.
 * Refresh өөрөө 401 өгвөл сессийг дуусгана.
 */
export async function apiFetch<T = unknown>(path: string, o: ApiOptions<T> = {}): Promise<T> {
  const opts = { method: o.method, body: o.body, signal: o.signal };
  const used = getAccessToken();
  let { res, correlationId } = await send(path, { ...opts, token: used });

  for (let attempt = 0; res.status === 401 && attempt < 2; attempt++) {
    if (attempt > 0 || getAccessToken() === used || getAccessToken() === null) {
      const refreshed = await refreshSession();
      if (!refreshed) break;
    }
    // Refresh хариу өөр хэрэглэгч байсан бол session дууссан (auth-context) → token цэвэр
    if (getAccessToken() === null) break;
    ({ res, correlationId } = await send(path, { ...opts, token: getAccessToken() }));
  }
  if (res.status === 401) {
    endSession();
    throw await readError(res, correlationId);
  }
  if (!res.ok) throw await readError(res, correlationId);
  if (res.status === 204) return undefined as T;
  const json: unknown = await res.json();
  return o.schema ? o.schema.parse(json) : (json as T);
}
