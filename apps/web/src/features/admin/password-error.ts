import { ApiError } from '../../lib/http';
import { t } from '../../lib/i18n';

export interface PasswordErrorView {
  /** `current` бол алдааг "Одоогийн нууц үг" талбарт заана; `null` бол формын ерөнхий алдаа. */
  field: 'current' | null;
  message: string;
}

/**
 * Нууц үг солих (`POST /auth/change-password`) алдааг дэлгэцэнд харуулах хэлбэрт хөрвүүлнэ.
 * F9-14: gateway одоогийн нууц үг буруу үед 422 + INVALID_CURRENT_PASSWORD өгнө (401 биш — 401-ийг apiFetch "token дууссан" гэж ойлгож сесс хаадаг байсан).
 */
export function classifyPasswordError(error: unknown): PasswordErrorView {
  if (error instanceof ApiError) {
    if (error.code === 'INVALID_CURRENT_PASSWORD') return { field: 'current', message: t('admin.password.error.currentWrong') };
    if (error.status === 401) return { field: null, message: t('admin.password.error.current') };
    if (error.code === 'PASSWORD_UNCHANGED') return { field: null, message: t('admin.password.error.same') };
  }
  return { field: null, message: error instanceof Error ? error.message : t('admin.common.load_error') };
}
