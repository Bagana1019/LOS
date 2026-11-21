import { ApplicationStatus, type ApplicationDetail, type ApplicationIdempotencyErrorCode, type ApplicationStepView, type StepKey } from '@los/contracts';
import { ApiError } from '../../lib/api';
import { newCorrelationId } from '../../lib/http';
import { hasMessage, t } from '../../lib/i18n';

/** FR-1.1: табууд төлөвтэй 1:1 (docs/01 §4). */
export const STATUS_TABS: readonly ApplicationStatus[] = ApplicationStatus;

export const stepHref = (applicationId: string, step: StepKey | string): string => `/los/loan-application/${encodeURIComponent(applicationId)}/${step}`;

/** FR-1.6: "Мэдээлэл оруулах" — сүүлд зогссон (эхний бүрдээгүй, цоожгүй) алхам. Бүгд бүрдсэн бол шийдвэр. */
export function resumeStep(steps: readonly ApplicationStepView[]): StepKey {
  const next = steps.find((s) => s.stage === 1 && (s.status === 'PENDING' || s.status === 'STALE'));
  return next?.stepKey ?? 'decision';
}

export const applicationHref = (id: string): string => `/los/loan-application/${encodeURIComponent(id)}`;

/** Wizard-н алхмыг сервер дээрх цоожоор нь (2-р үе шат батлагдтал). */
export const isStepOpen = (detail: Pick<ApplicationDetail, 'steps'>, key: string): boolean => detail.steps.some((s) => s.stepKey === key && s.status !== 'LOCKED');

/** Серверийн `{code, message}` → хэрэглэгчид харуулах текст. STEPS_INCOMPLETE бол дутуу алхмуудыг нэрлэнэ. */
export function describeApplicationError(e: unknown, fallbackKey: string): string {
  if (e instanceof ApiError) {
    const key = e.code ? `application.error.${e.code}` : null;
    if (key && hasMessage(key)) return t(key);
    if (e.message) return e.message;
  }
  return t(fallbackKey);
}

/** F12-4: API 403 (эрхгүй). Давтан оролдсон ч өөрчлөгдөхгүй тул UI "Дахин оролдох"-ыг харуулахгүй. Сүлжээний алдаа (status 0), 5xx зэрэг бусад нь false. */
export const isForbiddenError = (e: unknown): boolean => e instanceof ApiError && e.status === 403;

/** "Мэдээлэл оруулах": хүсэлтийн эхний бүрдээгүй алхам руу. Серверийн алхамгүйгээр: `/los/loan-application/:id` нь redirect хийнэ. */
export const resumeHref = (id: string): string => applicationHref(id);

/**
 * Давхар илгээлтээс хамгаалах (FR-1 «Үүсгэх» давхар дарах): гүйцэтгэж буй үед дахин дуудвал шинээр ажиллуулахгүй, ижил promise буцаана.
 * React-ийн `isPending` нь дараагийн render хүртэл шинэчлэгддэггүй тул `confirmLoading` дангаараа 53 мс-ийн давхар дарахыг хаахгүй.
 */
export function singleFlight<T>(task: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    if (inFlight) return inFlight;
    let started: Promise<T>;
    try { started = Promise.resolve(task()); } catch (e) { started = Promise.reject(e); }
    const tracked = started.finally(() => { inFlight = null; });
    inFlight = tracked;
    return tracked;
  };
}

/**
 * `POST /applications`-ийн Idempotency-Key. `crypto.randomUUID` нь зөвхөн secure контекстэд (https/localhost) байдаг;
 * http:// дотоод сүлжээнд байхгүй бол correlationId-ийн нөөц (мөн [A-Za-z0-9-], 8+ тэмдэгт) — серверийн хэлбэрт нийцнэ.
 */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  return typeof c?.randomUUID === 'function' ? c.randomUUID() : newCorrelationId();
}

/**
 * Нэг модал нээлт = нэг түлхүүр. `current()` эхний дуудлагад үүсгэж, `reset()` хүртэл ижил утга буцаана (retry бүр ижил түлхүүр → сервер давхардуулахгүй).
 * Дараагийн нээлт, амжилттай үүсгэлт, түлхүүр өөр биетэй ашиглагдсан алдааны дараа `reset()`.
 */
export function createIdempotencyKeyHolder(generate: () => string = newIdempotencyKey): { current: () => string; reset: () => void } {
  let key: string | null = null;
  return {
    current: () => (key ??= generate()),
    reset: () => { key = null; },
  };
}

const KEY_REUSED: ApplicationIdempotencyErrorCode = 'IDEMPOTENCY_KEY_REUSED';

/**
 * Сервер "энэ түлхүүр өөр биетэй хүсэлтэд ашиглагдсан" (422) гэвэл түлхүүрийг солино: хэрэглэгч эхний оролдлогын дараа талбараа засвал дахин оролдож чадна.
 * Сүлжээний алдаа, 5xx, timeout дээр СОЛИХГҮЙ — тэр үед хүсэлт серверт хүрсэн байж болох тул ижил түлхүүрээр дахин оролдох нь зөв.
 */
export const shouldRotateIdempotencyKey = (e: unknown): boolean => e instanceof ApiError && e.code === KEY_REUSED;
