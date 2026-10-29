import type { z } from 'zod';
import { API } from './config';
import { ApiError, newCorrelationId, readError, send } from './http';
import { endSession, getAccessToken, refreshSession } from './auth/session';

export { API, ApiError };

/** `?a=1&b=2` — хоосон/undefined утгыг алгасна. */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/**
 * Нэг дуудлагыг bearer token-той гүйцэтгэж, 401 бол token шинэчлээд дахин оролдоно.
 * Refresh бүр хуучин session мөрийг хүчингүй болгодог (gateway) тул өөр хүсэлт/таб token-ийг аль хэдийн шинэчилсэн байж болно:
 *   1) token солигдсон бол refresh хийхгүйгээр шинэ token-оор давтана;
 *   2) үгүй бол refresh хийж давтана;
 *   3) тэр ч 401 бол (дундуур өөр refresh орсон) нэг л удаа дахин refresh хийнэ.
 * Refresh өөрөө 401 өгвөл (эсвэл эцсийн хариу 401) сессийг дуусгана.
 */
async function withRenewal<R extends { res: Response }>(run: (token: string | null) => Promise<R>): Promise<R> {
  const used = getAccessToken();
  let out = await run(used);
  for (let attempt = 0; out.res.status === 401 && attempt < 2; attempt++) {
    if (attempt > 0 || getAccessToken() === used || getAccessToken() === null) {
      const refreshed = await refreshSession();
      if (!refreshed) break;
    }
    // Refresh хариу өөр хэрэглэгч байсан бол session дууссан (auth-context) → token цэвэр
    if (getAccessToken() === null) break;
    out = await run(getAccessToken());
  }
  if (out.res.status === 401) endSession();
  return out;
}

export interface ApiOptions<T> {
  method?: string;
  /** JSON body (feature-үүдэд `json` нэрээр ч өгч болно). */
  body?: unknown;
  json?: unknown;
  /** Хариуг zod-оор шалгана (`@los/contracts`-ийн схем). */
  schema?: z.ZodType<T, z.ZodTypeDef, unknown>;
  signal?: AbortSignal;
}

/**
 * Gateway руу JSON дуудлага (`API` + path). HTTP алдаа → `ApiError`; 401 бол token шинэчилж давтана.
 * Сүлжээний алдаа нь fetch-ийн анхны `TypeError` хэвээр гарна — feature-үүд (borrowers, payments, notifications, reports) үүгээр "сүлжээ" гэж таньж дахин оролддог.
 */
export async function apiFetch<T = unknown>(path: string, o: ApiOptions<T> = {}): Promise<T> {
  const opts = { method: o.method, body: o.body ?? o.json, signal: o.signal };
  let sent: { res: Response; correlationId: string };
  try {
    sent = await withRenewal((token) => send(path, { ...opts, token }));
  } catch (e) {
    if (e instanceof ApiError && e.status === 0 && e.cause instanceof TypeError) throw e.cause;
    throw e;
  }
  const { res, correlationId } = sent;
  if (!res.ok) throw await readError(res, correlationId);
  if (res.status === 204) return undefined as T;
  const json: unknown = await res.json();
  return o.schema ? o.schema.parse(json) : (json as T);
}

/** Gateway нь `/api/<service>/<зам>`-аар л дамжуулдаг (docs/00-foundation.md §2): origination-ийн endpoint-ууд `/origination/...`. */
export const ORIGINATION = '/origination';
export const originationFetch = <T = unknown>(path: string, o?: ApiOptions<T>): Promise<T> => apiFetch<T>(`${ORIGINATION}${path}`, o);
export const originationDownload = (path: string, fallbackName: string): Promise<void> => apiDownload(`${ORIGINATION}${path}`, fallbackName);

/**
 * `fetch`-ийн оронд: bearer token нэмж, 401 бол token шинэчлээд дахин оролдоно. Хариуг (`Response`) өөрчлөхгүй — feature өөрийн алдааны схемээр задлана.
 * Өөрийн `fetch(...)`-тэй модуль (maker-checker, мерчант, гарын үсгийн самбар) нэвтэрсэн ажилтны дуудлагад заавал үүгээр дамжуулна. Нийтийн хуудас (`/sign`, `/verify`) ашиглахгүй.
 * `body` нь дахин илгээж болох төрөл (string, FormData) байх ёстой — stream биш.
 */
export async function authFetch(url: string, init: RequestInit = {}): Promise<Response> {
  // Толгойг энгийн object хэвээр өгнө (feature-үүдийн тест `init.headers['…']`-г шууд уншдаг)
  const given: Record<string, string> = init.headers instanceof Headers || Array.isArray(init.headers) ? Object.fromEntries(new Headers(init.headers)) : { ...(init.headers as Record<string, string> | undefined) };
  const has = (name: string) => Object.keys(given).some((k) => k.toLowerCase() === name);
  const { res } = await withRenewal(async (token) => {
    const headers = { ...given };
    if (token && !has('authorization')) headers.authorization = `Bearer ${token}`;
    if (!has('x-correlation-id')) headers['x-correlation-id'] = newCorrelationId();
    return { res: await fetch(url, { ...init, headers, credentials: init.credentials ?? 'include' }) };
  });
  return res;
}

/** Файл (Excel) татах — gateway-н дамжуулсан Blob-ыг хөтөч дээр хадгалуулна. */
export async function apiDownload(path: string, fallbackName: string): Promise<void> {
  const res = await authFetch(`${API}${path}`);
  if (!res.ok) throw new ApiError(res.status, null, res.statusText);
  const cd = res.headers.get('content-disposition') ?? '';
  const name = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd)?.[1];
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: name ? decodeURIComponent(name) : fallbackName });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
