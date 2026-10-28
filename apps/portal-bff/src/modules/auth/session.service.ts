import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../common/clock';
import { randomToken, safeEqual, sha256Hex } from '../../common/crypto';
import { PortalError } from '../../common/portal-error';
import { PORTAL_CONFIG, type PortalConfig } from '../../config/portal.config';
import { KV_STORE, type KvStore } from '../../store/kv-store';

/** Refresh-ийг сунгасаар байсан ч session-ий дээд насны хязгаар. */
export const SESSION_ABSOLUTE_TTL_SEC = 90 * 24 * 60 * 60;

interface SessionRecord {
  customerId: string;
  refreshHash: string;
  /** Өмнөх refresh токены хэш — дахин ашиглагдвал хулгайлагдсан гэж үзнэ. */
  prevRefreshHash: string | null;
  createdAt: number;
}

export interface IssuedSession {
  customerId: string;
  sessionId: string;
  refreshToken: string;
  refreshExpiresInSec: number;
}

export type RotateOutcome = ({ kind: 'ROTATED' } & IssuedSession) | { kind: 'REUSE_DETECTED'; customerId: string; sessionId: string };

const SESSION_ID = /^[A-Za-z0-9_-]{22}$/;
const REFRESH_SECRET = /^[A-Za-z0-9_-]{43}$/;

/**
 * Сервер талын session + эргэлддэг (rotating) refresh токен.
 * Refresh токен = `<sessionId>.<secret>`; сервер зөвхөн secret-ийн SHA-256-г хадгална.
 */
@Injectable()
export class SessionService {
  constructor(
    @Inject(KV_STORE) private readonly store: KvStore,
    @Inject(PORTAL_CONFIG) private readonly cfg: PortalConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async create(customerId: string): Promise<IssuedSession> {
    const sessionId = randomToken(16);
    const secret = randomToken(32);
    const record: SessionRecord = { customerId, refreshHash: sha256Hex(secret), prevRefreshHash: null, createdAt: this.clock.now().getTime() };
    const ttl = this.cfg.auth.refreshTtlSec;
    await this.store.set(sessionKey(sessionId), JSON.stringify(record), ttl);
    return { customerId, sessionId, refreshToken: `${sessionId}.${secret}`, refreshExpiresInSec: ttl };
  }

  /** Access токены sid бодитоор идэвхтэй, тухайн харилцагчийнх эсэх (logout/reuse дараа токен тэр дор хүчингүй). */
  async isActive(sessionId: string, customerId: string): Promise<boolean> {
    const raw = await this.store.get(sessionKey(sessionId));
    return raw !== null && (JSON.parse(raw) as SessionRecord).customerId === customerId;
  }

  async revoke(sessionId: string): Promise<void> {
    await this.store.del(sessionKey(sessionId));
  }

  async rotate(refreshToken: string): Promise<RotateOutcome> {
    const [sessionId, secret, ...extra] = refreshToken.split('.');
    if (extra.length || !SESSION_ID.test(sessionId ?? '') || !REFRESH_SECRET.test(secret ?? '')) throw new PortalError('UNAUTHENTICATED');

    // Зэрэгцээ rotate-ыг цуваа болгоно: хоёр хүсэлт ижил токеныг зэрэг «зөв» гэж үзэхээс сэргийлнэ.
    const lock = `refresh-lock:${sessionId}`;
    if (!(await this.store.setIfAbsent(lock, '1', 10))) throw new PortalError('REQUEST_IN_PROGRESS');
    try {
      const raw = await this.store.get(sessionKey(sessionId));
      if (!raw) throw new PortalError('UNAUTHENTICATED');
      const record = JSON.parse(raw) as SessionRecord;
      const presented = sha256Hex(secret);

      if (!safeEqual(presented, record.refreshHash)) {
        if (record.prevRefreshHash && safeEqual(presented, record.prevRefreshHash)) {
          await this.revoke(sessionId);
          return { kind: 'REUSE_DETECTED', customerId: record.customerId, sessionId };
        }
        throw new PortalError('UNAUTHENTICATED');
      }

      const ageSec = Math.floor((this.clock.now().getTime() - record.createdAt) / 1000);
      const ttl = Math.min(this.cfg.auth.refreshTtlSec, SESSION_ABSOLUTE_TTL_SEC - ageSec);
      if (ttl <= 0) {
        await this.revoke(sessionId);
        throw new PortalError('UNAUTHENTICATED');
      }
      const nextSecret = randomToken(32);
      const next: SessionRecord = { ...record, prevRefreshHash: record.refreshHash, refreshHash: sha256Hex(nextSecret) };
      await this.store.set(sessionKey(sessionId), JSON.stringify(next), ttl);
      return { kind: 'ROTATED', customerId: record.customerId, sessionId, refreshToken: `${sessionId}.${nextSecret}`, refreshExpiresInSec: ttl };
    } finally {
      await this.store.del(lock).catch(() => undefined);
    }
  }
}

const sessionKey = (sessionId: string) => `sess:${sessionId}`;
