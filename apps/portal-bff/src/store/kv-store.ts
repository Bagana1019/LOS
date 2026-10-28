export const KV_STORE = Symbol('KV_STORE');

/**
 * Богино настай нууцлалын төлөв (OTP, session, rate limit, idempotency) хадгалах порт.
 * Бизнесийн өгөгдөл энд орохгүй — portal-bff өөрийн DB-гүй (CLAUDE.md §4).
 * Бүх үйлдэл атомар байх ёстой (Redis: SET NX / GETDEL / INCR).
 */
export interface KvStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec: number): Promise<void>;
  /** Түлхүүр байхгүй үед л үүсгэнэ. Үүсгэсэн бол true. */
  setIfAbsent(key: string, value: string, ttlSec: number): Promise<boolean>;
  /** Түлхүүр одоо ч байгаа үед л дарж бичнэ (SET XX). Бичсэн бол true. Устгагдсан бичлэгийг «амилуулахгүй». */
  setIfExists(key: string, value: string, ttlSec: number): Promise<boolean>;
  del(key: string): Promise<void>;
  /** Нэг удаагийн хэрэглээ (OTP, refresh rotation): уншаад нэгэн зэрэг устгана. */
  getAndDelete(key: string): Promise<string | null>;
  /** Атомар +1. Түлхүүр шинээр үүсэхэд ttlSec тохируулна (дараагийн incr хугацааг сунгахгүй). */
  incr(key: string, ttlSec: number): Promise<number>;
  /** Үлдсэн секунд; түлхүүр байхгүй бол 0. */
  ttl(key: string): Promise<number>;
}

/** Хадгалалтын давхарга ажиллахгүй үед (Redis унасан). Auth/rate-limit хаалттай (fail closed) байна. */
export class StoreUnavailableError extends Error {}
