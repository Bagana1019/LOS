import { ApplicationStatus, type ApplicationDetail, type ApplicationStepView, type StepKey } from '@los/contracts';
import { ApiError } from '../../lib/api';
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

/** "Мэдээлэл оруулах": хүсэлтийн эхний бүрдээгүй алхам руу. Серверийн алхамгүйгээр: `/los/loan-application/:id` нь redirect хийнэ. */
export const resumeHref = (id: string): string => applicationHref(id);
