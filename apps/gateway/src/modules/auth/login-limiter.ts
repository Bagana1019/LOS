import { createHash } from 'node:crypto';
import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { rateLimitKeyForIp } from '../public-esign/client-ip';
import { SharedCounterStore } from '../rate-limit/rate-limit.module';
import { AUTH_CONFIG, type AuthConfig } from './auth.config';

/** AuthService-тэй ижил: хэрэглэгчийн нэрийг хайхдаа trim + жижиг үсэг. */
export const normalizeUsername = (raw: string): string => raw.trim().toLowerCase();

/**
 * M7 — нэвтрэлтийн АМЖИЛТГҮЙ оролдлогыг (хэрэглэгчийн нэр, IP) хосоор тоолно: нэг NAT IP-ийн ард буй салбарын бусад ажилтан хаагдахгүй.
 * Хязгаар LOGIN_RATE_LIMIT (анхдагч 10) / LOGIN_RATE_WINDOW_SECONDS (анхдагч 60). IP-ийн нийт дээд хязгаар (spraying) — auth.controller-ийн @Throttle.
 * Данс түгжих (LOGIN_MAX_FAILURES / LOGIN_LOCK_MINUTES) AuthService-д хэвээр. Хэрэглэгчийн нэрийг Redis-д hash-аар л хадгална.
 */
@Injectable()
export class LoginAttemptLimiter {
  constructor(private readonly counters: SharedCounterStore, @Inject(AUTH_CONFIG) private readonly cfg: AuthConfig) {}

  keyFor(username: string, ip: string | undefined): string {
    const user = createHash('sha256').update(normalizeUsername(username)).digest('hex').slice(0, 32);
    return `${this.counters.prefix}login:${user}:${rateLimitKeyForIp(ip)}`;
  }

  /** Хаагдсан бол 429 (+Retry-After). `setHeader` нь Express response-ийн. */
  async assertAllowed(key: string, setHeader: (name: string, value: string) => void): Promise<void> {
    const s = await this.counters.store.peek(key);
    if (s.count < this.cfg.loginFailureLimit) return;
    setHeader('Retry-After', String(Math.max(1, Math.ceil(s.resetMs / 1000))));
    throw new HttpException({ code: 'TOO_MANY_LOGIN_ATTEMPTS', message: 'Хэт олон удаа буруу оролдлоо. Түр хүлээгээд дахин оролдоно уу.' }, HttpStatus.TOO_MANY_REQUESTS);
  }

  async recordFailure(key: string): Promise<void> { await this.counters.store.hit(key, this.cfg.loginFailureWindowSeconds * 1000); }
  async reset(key: string): Promise<void> { await this.counters.store.clear(key); }
}
