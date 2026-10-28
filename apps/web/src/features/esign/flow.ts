import type { PublicSigningSession, SigningFailureReason } from '@los/contracts';
import type { EsignErrorKind } from './api';

// FR-11.4 — зээлдэгчийн урсгалын цэвэр логик (React-гүй): алхам тодорхойлох, polling-ийн бодлого, deep link шүүлт, кодын формат.

export type FlowStep =
  | { step: 'review' }
  /** `retryReason` — provider-ийн өмнөх session амжилтгүй болж PENDING руу буцсан үед (линк хүчинтэй хэвээр) */
  | { step: 'choose'; retryReason: SigningFailureReason | null }
  | { step: 'waiting'; phase: 'approve' | 'finalizing' }
  | { step: 'signed' }
  | { step: 'declined' }
  | { step: 'expired' }
  | { step: 'cancelled' }
  | { step: 'failed'; reason: SigningFailureReason | null }
  | { step: 'notFound' };

/**
 * Сервер дээрх төлөв + орон нутгийн "гэрээг үзлээ, үргэлжлүүлье" баталгаанаас алхам гаргана.
 * `documentViewed` сервер дээр true болсон даруй review алхам алга болохгүй — хэрэглэгч өөрөө "Үргэлжлүүлэх" дарна.
 */
export function deriveStep(session: PublicSigningSession, reviewAcknowledged: boolean): FlowStep {
  switch (session.status) {
    case 'PENDING':
      // Өмнөх оролдлого амжилтгүй болсон (failureReason үлдсэн) бол гэрээг аль хэдийн үзсэн → шууд дахин сонгоно
      if (session.documentViewed && session.failureReason !== null) return { step: 'choose', retryReason: session.failureReason };
      return session.documentViewed && reviewAcknowledged ? { step: 'choose', retryReason: null } : { step: 'review' };
    case 'IN_PROGRESS':
      return { step: 'waiting', phase: 'approve' };
    case 'FINALIZING':
      return { step: 'waiting', phase: 'finalizing' };
    case 'SIGNED':
      return { step: 'signed' };
    case 'DECLINED':
      return { step: 'declined' };
    case 'EXPIRED':
      return { step: 'expired' };
    case 'CANCELLED':
      return { step: 'cancelled' };
    case 'FAILED':
      return { step: 'failed', reason: session.failureReason };
  }
}

/** API-ийн алдаа өөрөө алхам тодорхойлох тохиолдол: 404 → олдсонгүй, 410 → хугацаа дууссан. Бусад нь алхамгүй (түр алдаа). */
export function stepForError(kind: EsignErrorKind): FlowStep | null {
  if (kind === 'NOT_FOUND') return { step: 'notFound' };
  if (kind === 'GONE') return { step: 'expired' };
  return null;
}

const TERMINAL_STEPS: ReadonlySet<FlowStep['step']> = new Set(['signed', 'declined', 'expired', 'cancelled', 'failed', 'notFound']);

export function isTerminalStep(step: FlowStep): boolean {
  return TERMINAL_STEPS.has(step.step);
}

// --- Polling ---

export const POLL_FAST_MS = 2_000;
export const POLL_SLOW_MS = 5_000;
export const POLL_SLOW_AFTER_MS = 60_000;
export const POLL_ERROR_CAP_MS = 20_000;
const MAX_BACKOFF_DOUBLINGS = 4;

export interface PollContext {
  /** waiting алхамд орсоноос хойш өнгөрсөн хугацаа */
  elapsedMs: number;
  /** Дараалсан амжилтгүй polling-ийн тоо */
  failures?: number;
  /** 429-ийн Retry-After */
  retryAfterMs?: number | null;
}

/**
 * Дараагийн status хүсэлт хүртэлх хугацаа (мс); polling хийх ёсгүй бол false.
 * Эхний 60 с — 2 с, дараа нь 5 с. Алдаа гарвал давхар болгон ухарна (дээд хязгаар 20 с), 429-д Retry-After-аас богино болохгүй.
 */
export function pollIntervalMs(step: FlowStep | null, { elapsedMs, failures = 0, retryAfterMs = null }: PollContext): number | false {
  if (step === null || step.step !== 'waiting') return false;
  const base = elapsedMs >= POLL_SLOW_AFTER_MS ? POLL_SLOW_MS : POLL_FAST_MS;
  const backedOff = failures > 0 ? Math.min(POLL_ERROR_CAP_MS, base * 2 ** Math.min(failures, MAX_BACKOFF_DOUBLINGS)) : base;
  return retryAfterMs === null ? backedOff : Math.max(backedOff, retryAfterMs);
}

// --- Deep link ---

/** Provider аппуудын мэдэгдэж буй scheme. Бодит scheme-үүд өөр бол NEXT_PUBLIC_ESIGN_APP_SCHEMES-ээр нэмнэ. */
export const KNOWN_APP_SCHEMES: readonly string[] = ['tridum:', 'monpass:', 'mock-tridum:', 'mock-monpass:'];
const WEB_SCHEMES: readonly string[] = ['http:', 'https:'];
/** Env-ээр ч зөвшөөрөхгүй, XSS/файл/өгөгдлийн scheme-үүд */
const FORBIDDEN_SCHEMES: ReadonlySet<string> = new Set(['javascript', 'data', 'vbscript', 'file', 'blob', 'about', 'filesystem', 'view-source']);
const SCHEME_NAME_RE = /^[a-z][a-z0-9+.-]{1,31}$/;
const MAX_DEEP_LINK_LENGTH = 2048;

/** Зай болон control тэмдэгт (URL parser заримыг нь чимээгүй хасдаг тул урьдчилан хориглоно) */
function hasUnsafeChars(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) as number;
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/** "tridum, monpass2" → ['tridum:', 'monpass2:']; буруу/хориотой нэрийг орхино */
export function parseExtraSchemes(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/:$/, ''))
    .filter((s) => SCHEME_NAME_RE.test(s) && !FORBIDDEN_SCHEMES.has(s))
    .map((s) => `${s}:`);
}

const EXTRA_APP_SCHEMES = parseExtraSchemes(process.env.NEXT_PUBLIC_ESIGN_APP_SCHEMES);

/**
 * Серверийн өгсөн deep link-ийг `<a href>`-д тавихаас өмнө шалгана: зөвхөн http(s) эсвэл мэдэгдэж буй апп scheme.
 * `javascript:`, `data:` гэх мэт бүгд null. Шалгасан, normalize хийсэн URL-ийг буцаана.
 */
export function safeDeepLink(raw: string | null, extraSchemes: readonly string[] = EXTRA_APP_SCHEMES): string | null {
  if (raw === null || raw.length === 0 || raw.length > MAX_DEEP_LINK_LENGTH || hasUnsafeChars(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const isWeb = WEB_SCHEMES.includes(url.protocol);
  if (!isWeb && !KNOWN_APP_SCHEMES.includes(url.protocol) && !extraSchemes.includes(url.protocol)) return null;
  // https://user:pass@host нь итгэлийг будлиулах өргөн тархсан арга
  if (isWeb && (url.hostname === '' || url.username !== '' || url.password !== '')) return null;
  return url.href;
}

// --- Формат ---

/** `ABCD1234EFGH` → `ABCD-1234-EFGH` (12 тэмдэгт биш бол зөвхөн цэвэрлээд том үсэг болгоно) */
export function formatVerificationCode(code: string): string {
  const clean = code.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  return clean.length === 12 ? (clean.match(/.{4}/g) as string[]).join('-') : clean;
}

/** Дуусах хүртэлх хугацаа (мс), сөрөг/буруу огноо → 0 */
export function remainingMs(expiresAtIso: string, nowMs: number): number {
  const at = Date.parse(expiresAtIso);
  return Number.isNaN(at) ? 0 : Math.max(0, at - nowMs);
}

/** 272_000 → "04:32" */
export function formatCountdown(ms: number): string {
  const total = Math.ceil(Math.max(0, ms) / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}
