import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../common/clock';
import { hmacHex, randomToken, safeEqual } from '../../common/crypto';
import { PortalError } from '../../common/portal-error';
import { PORTAL_CONFIG, type PortalConfig } from '../../config/portal.config';
import { KV_STORE, type KvStore } from '../../store/kv-store';

/** Refresh-ийг сунгасаар байсан ч session-ий дээд насны хязгаар. */
export const SESSION_ABSOLUTE_TTL_SEC = 90 * 24 * 60 * 60;

interface SessionRecord {
  customerId: string;
  /** Refresh токены нууцыг үүсгэх түлхүүрийн материал (зөвхөн `PORTAL_HASH_SECRET`-тэй хамт утга өгнө). */
  seed: string;
  /** Одоогийн (хамгийн сүүлд олгосон) refresh токены үе. Түүнээс бага үе ирвэл хулгайлагдсан гэж үзнэ. */
  gen: number;
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
const GENERATION = /^\d{1,7}$/;
const REFRESH_SECRET = /^[0-9a-f]{64}$/;

/**
 * Сервер талын session + эргэлддэг (rotating) refresh токен.
 * Refresh токен = `<sessionId>.<gen>.<secret>`, secret = HMAC(PORTAL_HASH_SECRET, sessionId|seed|gen).
 * Өмнөх бүх үеийн токеныг хадгалахгүйгээр шалгаж чадна: хуучин (gen < одоогийн) боловч хүчинтэй токен
 * дахин ирвэл хулгайлагдсан гэж үзэж session (token family)-ийг устгана — хэдэн удаа эргэсэн ч адил.
 * Redis-ийн агуулга дангаараа токен хуурамчаар үүсгэх боломж олгохгүй (HMAC түлхүүр Redis-д байхгүй).
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
    const record: SessionRecord = { customerId, seed: randomToken(32), gen: 0, createdAt: this.clock.now().getTime() };
    const ttl = this.cfg.auth.refreshTtlSec;
    await this.store.set(sessionKey(sessionId), JSON.stringify(record), ttl);
    return { customerId, sessionId, refreshToken: this.token(sessionId, record, 0), refreshExpiresInSec: ttl };
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
    const [sessionId, genRaw, secret, ...extra] = refreshToken.split('.');
    if (extra.length || !SESSION_ID.test(sessionId ?? '') || !GENERATION.test(genRaw ?? '') || !REFRESH_SECRET.test(secret ?? '')) {
      throw new PortalError('UNAUTHENTICATED');
    }
    const gen = Number(genRaw);

    // Зэрэгцээ rotate-ыг цуваа болгоно: хоёр хүсэлт ижил токеныг зэрэг «зөв» гэж үзэхээс сэргийлнэ.
    const lock = `refresh-lock:${sessionId}`;
    if (!(await this.store.setIfAbsent(lock, '1', 10))) throw new PortalError('REQUEST_IN_PROGRESS');
    try {
      const raw = await this.store.get(sessionKey(sessionId));
      if (!raw) throw new PortalError('UNAUTHENTICATED');
      const record = JSON.parse(raw) as SessionRecord;

      // Үе нь хэзээ ч олгогдоогүй эсвэл нууц нь таарахгүй бол хуурамч: session-д хүрэхгүй.
      if (gen > record.gen || !safeEqual(secret, this.secret(sessionId, record.seed, gen))) throw new PortalError('UNAUTHENTICATED');
      if (gen < record.gen) {
        await this.revoke(sessionId);
        return { kind: 'REUSE_DETECTED', customerId: record.customerId, sessionId };
      }

      const ageSec = Math.floor((this.clock.now().getTime() - record.createdAt) / 1000);
      const ttl = Math.min(this.cfg.auth.refreshTtlSec, SESSION_ABSOLUTE_TTL_SEC - ageSec);
      if (ttl <= 0) {
        await this.revoke(sessionId);
        throw new PortalError('UNAUTHENTICATED');
      }
      const next: SessionRecord = { ...record, gen: record.gen + 1 };
      // Зөвхөн session одоо ч байгаа үед бичнэ: rotate-ын завсар logout орвол session дахин «амилахгүй».
      if (!(await this.store.setIfExists(sessionKey(sessionId), JSON.stringify(next), ttl))) throw new PortalError('UNAUTHENTICATED');
      return { kind: 'ROTATED', customerId: record.customerId, sessionId, refreshToken: this.token(sessionId, next, next.gen), refreshExpiresInSec: ttl };
    } finally {
      await this.store.del(lock).catch(() => undefined);
    }
  }

  private secret(sessionId: string, seed: string, gen: number): string {
    return hmacHex(this.cfg.auth.hashSecret, `refresh:${sessionId}:${seed}:${gen}`);
  }

  private token(sessionId: string, record: SessionRecord, gen: number): string {
    return `${sessionId}.${gen}.${this.secret(sessionId, record.seed, gen)}`;
  }
}

const sessionKey = (sessionId: string) => `sess:${sessionId}`;
