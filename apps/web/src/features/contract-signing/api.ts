import { SigningRequestView, type ESignProvider } from '@los/contracts';
import type { z } from 'zod';
import { API, authFetch } from '../../lib/api';

// FR-11.4 — ажилтны тал: gateway `/api/origination/contracts/:applicationId/esign`. Gateway-ийн JWT (Authorization: Bearer) шаардлагатай —
// `authFetch` (lib/api) нэвтэрсэн сессийн token-ийг нэмж, дууссан бол шинэчилнэ.
// Зээлдэгчийн линк (signingUrl) ЗӨВХӨН SMS-ээр явна — энд хэзээ ч хүсэхгүй, харуулахгүй: schema-аар (strip) хасна.

export const StaffSigningView = SigningRequestView.omit({ signingUrl: true });
export type StaffSigningView = z.infer<typeof StaffSigningView>;

export type SigningApiErrorKind = 'NETWORK' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'RATE_LIMITED' | 'INVALID_REQUEST' | 'SERVER' | 'INVALID_RESPONSE';

export class SigningApiError extends Error {
  constructor(
    readonly kind: SigningApiErrorKind,
    readonly status: number | null = null,
    /** Backend-ийн өгсөн монгол тайлбар (4xx/502/503) — ажилтанд ойлгомжтой шалтгаан; байхгүй бол null */
    readonly serverMessage: string | null = null,
  ) {
    super(kind);
    this.name = 'SigningApiError';
  }
}

const APPLICATION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_SERVER_MESSAGE = 300;

function url(applicationId: string, suffix = ''): string {
  // origination-ийн ApplicationId шалгалттай ижил — path-д ямар ч утга оруулахгүй
  if (!APPLICATION_ID_RE.test(applicationId)) throw new SigningApiError('INVALID_REQUEST');
  return `${API}/origination/contracts/${encodeURIComponent(applicationId)}/esign${suffix}`;
}

function kindFor(status: number): SigningApiErrorKind {
  if (status === 401 || status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'SERVER';
  return 'INVALID_REQUEST';
}

/** Nest-ийн `{ message: string }` хэлбэрээс л авна (массив/HTML/объект бол үгүй) */
async function readServerMessage(res: Response): Promise<string | null> {
  try {
    const body: unknown = await res.json();
    const message = typeof body === 'object' && body !== null ? (body as { message?: unknown }).message : undefined;
    return typeof message === 'string' && message.trim() !== '' ? message.trim().slice(0, MAX_SERVER_MESSAGE) : null;
  } catch {
    return null;
  }
}

async function request(target: string, method: 'GET' | 'POST', body?: unknown, signal?: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await authFetch(target, {
      method,
      credentials: 'include',
      cache: 'no-store',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    throw new SigningApiError('NETWORK');
  }
  return res;
}

async function parseView(res: Response): Promise<StaffSigningView> {
  if (!res.ok) {
    // 5xx-ийн дотоод мессежийг (502/503 бус) ажилтанд харуулахгүй
    const showable = res.status < 500 || res.status === 502 || res.status === 503;
    throw new SigningApiError(kindFor(res.status), res.status, showable ? await readServerMessage(res) : null);
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new SigningApiError('INVALID_RESPONSE', res.status);
  }
  const parsed = StaffSigningView.safeParse(json);
  if (!parsed.success) throw new SigningApiError('INVALID_RESPONSE', res.status);
  return parsed.data;
}

/** Одоогийн хүсэлт; хүсэлт огт үүсээгүй (404) бол null */
export async function getSigning(applicationId: string, signal?: AbortSignal): Promise<StaffSigningView | null> {
  const res = await request(url(applicationId), 'GET', undefined, signal);
  if (res.status === 404) return null;
  return parseView(res);
}

/** Шинэ хүсэлт үүсгэж зээлдэгчид SMS илгээнэ. `preferredProvider` заавал биш. */
export async function startSigning(applicationId: string, preferredProvider?: ESignProvider): Promise<StaffSigningView> {
  return parseView(await request(url(applicationId), 'POST', preferredProvider === undefined ? {} : { preferredProvider }));
}

/** Линкийг шинэчилж (хуучин нь хүчингүй) SMS-ийг дахин илгээнэ */
export async function resendSigning(applicationId: string): Promise<StaffSigningView> {
  return parseView(await request(url(applicationId, '/resend'), 'POST'));
}

export async function cancelSigning(applicationId: string): Promise<StaffSigningView> {
  return parseView(await request(url(applicationId, '/cancel'), 'POST'));
}
