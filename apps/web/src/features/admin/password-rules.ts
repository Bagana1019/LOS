import { ChangePasswordBody, PASSWORD_MIN_LENGTH } from '@los/contracts';
import { t } from '../../lib/i18n';

// F9-15: нууц үг солих формын шаардлагын чеклист + "товч яагаад идэвхгүй" шалтгаан.
// Эх сурвалж: серверийн `PasswordField` (packages/contracts/src/admin.ts): ≥12, ≤200 тэмдэгт; [a-z], [A-Z], \d — ЗӨВХӨН латин үсэг (кирилл тоологдохгүй).
// `ChangePasswordBody`-той ижил шийдвэр гаргадгийг password-rules.test.ts шалгана (дүрэм зөрөхөөс хамгаална).

/** `PasswordField`-ийн `.max(200)` — contracts-д тогтмол болгон экспортлоогүй тул энд; тест зөрүүг барина. */
const PASSWORD_MAX_LENGTH = 200;

export type PasswordCheckKey = 'length' | 'upper' | 'lower' | 'digit' | 'max';
export interface PasswordCheck { key: PasswordCheckKey; ok: boolean; /** Одоогийн тэмдэгтийн тоо (zod-той адил UTF-16 нэгж). */ count: number }

export function passwordChecks(password: string): PasswordCheck[] {
  const count = password.length;
  return [
    { key: 'length', ok: count >= PASSWORD_MIN_LENGTH, count },
    { key: 'upper', ok: /[A-Z]/.test(password), count },
    { key: 'lower', ok: /[a-z]/.test(password), count },
    { key: 'digit', ok: /\d/.test(password), count },
    { key: 'max', ok: count <= PASSWORD_MAX_LENGTH, count },
  ];
}

export const passwordMeetsPolicy = (password: string): boolean => passwordChecks(password).every((c) => c.ok);

/** Чеклистийн мөрийн текст. */
export function checkText(check: PasswordCheck): string {
  return check.key === 'length' ? t('admin.password.rules.length', { count: check.count }) : t(`admin.password.rules.${check.key}`);
}

export type SubmitBlocker = 'current' | 'rules' | 'same' | 'confirm' | 'mismatch';
export interface PasswordForm { current: string; next: string; again: string }

/**
 * Товч идэвхгүй байгаа ЭХНИЙ шалтгаан (формыг дээрээс доош бөглөх дарааллаар) эсвэл null (бэлэн).
 * `same`: шинэ нууц үг одоогийнхтой ижил бол сервер PASSWORD_UNCHANGED өгдөг — илгээхээс өмнө хэлнэ (зөв хүсэлтийг хэзээ ч хаахгүй).
 */
export function submitBlocker({ current, next, again }: PasswordForm): SubmitBlocker | null {
  if (!ChangePasswordBody.shape.currentPassword.safeParse(current).success) return 'current';
  if (!passwordMeetsPolicy(next)) return 'rules';
  if (next === current) return 'same';
  if (again === '') return 'confirm';
  if (again !== next) return 'mismatch';
  return null;
}

export function blockerText(blocker: SubmitBlocker | null): string {
  return blocker === null ? '' : t('admin.password.blocked', { reason: t(`admin.password.blocked.${blocker}`) });
}
