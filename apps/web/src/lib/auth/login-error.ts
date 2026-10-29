import type { MnKey } from '@los/ui';
import { ApiError } from '../http';

/** Нэвтрэх үеийн алдааг хэрэглэгчид ойлгомжтой монгол мессеж болгоно (серверийн текстийг шууд харуулахгүй). */
export function loginErrorKey(e: unknown): MnKey {
  if (e instanceof ApiError) {
    if (e.status === 0) return 'auth.error.network';
    if (e.status === 429) return 'auth.error.rate_limit';
    // Буруу нууц үг, байхгүй/идэвхгүй/түгжигдсэн хэрэглэгч — gateway зориуд ижил хариу өгдөг
    if (e.status === 401 || e.code === 'INVALID_CREDENTIALS') return 'auth.error.invalid';
  }
  return 'auth.error.unknown';
}
