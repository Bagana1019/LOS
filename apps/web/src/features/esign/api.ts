import { PublicSigningSession, SigningVerification, StartPublicSigning } from '@los/contracts';
import type { ZodType } from 'zod';
import { API } from '../../lib/api';

// FR-11.4 — зээлдэгчийн (JWT-гүй) public API. Бүх дуудлага gateway `/api/public/esign/**` руу; cookie дамжуулахгүй.
// Токен URL-д байх ёстой (iframe/link толгой тохируулж чадахгүй) тул URL-ийг алдаа/лог/гарчигт хэзээ ч оруулахгүй.

export type EsignErrorKind =
  | 'NOT_FOUND'
  | 'GONE'
  | 'RATE_LIMITED'
  | 'CONFLICT'
  | 'INVALID_REQUEST'
  | 'SERVER'
  | 'NETWORK'
  | 'INVALID_RESPONSE';

export class EsignApiError extends Error {
  constructor(
    readonly kind: EsignErrorKind,
    readonly status: number | null = null,
    /** 429-ийн `Retry-After` (мс); толгой байхгүй/уншигдахгүй бол null */
    readonly retryAfterMs: number | null = null,
  ) {
    // Мессеж нь зөвхөн төрөл — URL (токен), биеийн агуулга орохгүй
    super(kind);
    this.name = 'EsignApiError';
  }
}

/** 32 random byte → base64url (43 тэмдэгт) — gateway-ийн SigningTokenPipe-тэй ижил */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
/** Crockford base32 (I L O U-гүй), 12 тэмдэгт */
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{12}$/;
const MAX_RETRY_AFTER_MS = 60_000;

export function isValidSigningToken(value: string): boolean {
  return TOKEN_RE.test(value);
}

/** `XXXX-XXXX-XXXX` эсвэл зураасгүй, жижиг үсэгтэй ч болно → зураасгүй том үсэг; буруу бол null */
export function normalizeVerificationCode(raw: string): string | null {
  const code = raw.trim().replaceAll('-', '').toUpperCase();
  return CODE_RE.test(code) ? code : null;
}

const base = (path: string): string => `${API}/public/esign/${path}`;

/** iframe/link-ийн src. Токен path-д — encode хийх шаардлагагүй (base64url), гэхдээ шалгасан токен л орно. */
export function documentUrl(token: string): string {
  return base(`${assertToken(token)}/document`);
}
export function signedDocumentUrl(token: string): string {
  return base(`${assertToken(token)}/signed-document`);
}

function assertToken(token: string): string {
  if (!isValidSigningToken(token)) throw new EsignApiError('NOT_FOUND');
  return token;
}

function parseRetryAfter(res: Response): number | null {
  const raw = res.headers.get('retry-after');
  if (raw === null || !/^\d{1,5}$/.test(raw.trim())) return null;
  return Math.min(Number(raw) * 1000, MAX_RETRY_AFTER_MS);
}

function errorFor(res: Response): EsignApiError {
  const { status } = res;
  if (status === 404) return new EsignApiError('NOT_FOUND', status);
  if (status === 410) return new EsignApiError('GONE', status);
  if (status === 429) return new EsignApiError('RATE_LIMITED', status, parseRetryAfter(res));
  if (status === 409) return new EsignApiError('CONFLICT', status);
  if (status >= 500) return new EsignApiError('SERVER', status);
  return new EsignApiError('INVALID_REQUEST', status);
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

interface CallOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
}

async function call(path: string, { method = 'GET', body, signal }: CallOptions = {}): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(base(path), {
      method,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    // Цуцлагдсан (unmount) хүсэлтийг алдаа болгохгүй
    if (isAbort(err)) throw err;
    throw new EsignApiError('NETWORK');
  }
  if (!res.ok) throw errorFor(res);
  try {
    return await res.json();
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new EsignApiError('INVALID_RESPONSE', res.status);
  }
}

function parseWith<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  // Zod-ын алдаа (талбарын нэр/утга)-г дамжуулахгүй
  if (!parsed.success) throw new EsignApiError('INVALID_RESPONSE');
  return parsed.data;
}

export async function fetchSession(token: string, signal?: AbortSignal): Promise<PublicSigningSession> {
  return parseWith(PublicSigningSession, await call(assertToken(token), { signal }));
}

/** Polling — `GET :token/status` нь `GET :token`-тэй ижил PublicSigningSession хэлбэртэй */
export async function fetchStatus(token: string, signal?: AbortSignal): Promise<PublicSigningSession> {
  return parseWith(PublicSigningSession, await call(`${assertToken(token)}/status`, { signal }));
}

export async function startSigning(token: string, input: StartPublicSigning): Promise<PublicSigningSession> {
  // consent: true литерал — зөвшөөрөлгүйгээр хүсэлт гарахгүй
  const body = StartPublicSigning.parse(input);
  return parseWith(PublicSigningSession, await call(`${assertToken(token)}/start`, { method: 'POST', body }));
}

export async function declineSigning(token: string): Promise<PublicSigningSession> {
  return parseWith(PublicSigningSession, await call(`${assertToken(token)}/decline`, { method: 'POST' }));
}

export async function fetchVerification(code: string, signal?: AbortSignal): Promise<SigningVerification> {
  const normalized = normalizeVerificationCode(code);
  if (normalized === null) throw new EsignApiError('NOT_FOUND');
  return parseWith(SigningVerification, await call(`verify/${normalized}`, { signal }));
}
