import { Inject, Injectable } from '@nestjs/common';
import { PortalError } from '../common/portal-error';
import { sha256Hex } from '../common/crypto';
import { KV_STORE, type KvStore } from '../store/kv-store';

const KEY_FORMAT = /^[A-Za-z0-9_-]{8,64}$/;
/** Боловсруулж байгаа үеийн түгжээ. Процесс унавал өөрөө суллагдана. */
const LOCK_TTL_SEC = 60;
/** Амжилттай хариуг давтан илгээх хугацаа. */
const REPLAY_TTL_SEC = 24 * 60 * 60;

interface IdemRecord {
  state: 'IN_PROGRESS' | 'DONE';
  fingerprint: string;
  response?: unknown;
}

export interface IdempotentResult<T> {
  value: T;
  replayed: boolean;
}

/**
 * Мөнгөн гүйлгээ үүсгэх POST-ыг дахин илгээхэд (сүлжээ тасрах, давхар товшилт) нэг л төлбөр үүсгэх баталгаа.
 * Түлхүүр = (customerId, Idempotency-Key). Ижил түлхүүр + өөр агуулга → IDEMPOTENCY_KEY_REUSED.
 * Downstream мөн ижил түлхүүрээр давхардлыг хаана (хоёр давхар хамгаалалт).
 */
@Injectable()
export class IdempotencyService {
  constructor(@Inject(KV_STORE) private readonly store: KvStore) {}

  static validateKey(key: string | undefined): string {
    if (!key) throw new PortalError('IDEMPOTENCY_KEY_REQUIRED');
    if (!KEY_FORMAT.test(key)) {
      throw new PortalError('INVALID_REQUEST', [{ path: 'Idempotency-Key', message: '8-64 chars: A-Z a-z 0-9 _ -' }]);
    }
    return key;
  }

  static fingerprint(parts: unknown): string {
    return sha256Hex(JSON.stringify(parts));
  }

  async run<T>(customerId: string, key: string, fingerprint: string, exec: () => Promise<T>): Promise<IdempotentResult<T>> {
    const storeKey = `idem:${customerId}:${key}`;
    const fresh: IdemRecord = { state: 'IN_PROGRESS', fingerprint };

    if (!(await this.store.setIfAbsent(storeKey, JSON.stringify(fresh), LOCK_TTL_SEC))) {
      const raw = await this.store.get(storeKey);
      // Түгжээ дөнгөж хугацаа дууссан гэсэн зэрэгцээ нөхцөл: дахин оролдоход бэлэн.
      if (!raw) throw new PortalError('REQUEST_IN_PROGRESS');
      const existing = JSON.parse(raw) as IdemRecord;
      if (existing.fingerprint !== fingerprint) throw new PortalError('IDEMPOTENCY_KEY_REUSED');
      if (existing.state === 'DONE') return { value: existing.response as T, replayed: true };
      throw new PortalError('REQUEST_IN_PROGRESS');
    }

    try {
      const value = await exec();
      await this.store.set(storeKey, JSON.stringify({ state: 'DONE', fingerprint, response: value } satisfies IdemRecord), REPLAY_TTL_SEC);
      return { value, replayed: false };
    } catch (err) {
      // Алдаа гарсан бол түлхүүрийг суллана: клиент ижил түлхүүрээр дахин оролдож болно.
      await this.store.del(storeKey).catch(() => undefined);
      throw err;
    }
  }
}
