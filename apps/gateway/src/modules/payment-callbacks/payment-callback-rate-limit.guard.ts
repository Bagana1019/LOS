import { type CanActivate, type ExecutionContext, HttpException, HttpStatus, Injectable, Logger, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { rateLimitKeyForIp, resolveClientIp } from '../public-esign/client-ip';
import type { PublicCallbackRoute } from '../proxy/route-policy';
import { SharedCounterStore } from '../rate-limit/rate-limit.module';
import { loadTrustedSources, trustedSourceWarnings } from './trusted-sources';

const WINDOW_MS = 60_000;
const PROVIDER_KEY = 'los:payment-callback-provider';

const positiveInt = (name: string, fallback: number, env: NodeJS.ProcessEnv): number => {
  const raw = env[name];
  const n = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid ${name}="${raw}"`);
  return n;
};

/**
 * H9 хязгаар (хүсэлт бүрт env уншина). Итгэмжлэгдсэн эх сурвалж = PAYMENT_CALLBACK_TRUSTED_CIDRS_<PROVIDER> (trusted-sources.ts).
 * Итгэмжлэгдсэн IP:
 *  - PAYMENT_CALLBACK_IP_RATE_LIMIT — нэг IP-ийн дээд хязгаар, минутад; анхдагч 600. Эхэлж шалгана (хэтэрсэн IP хувинг зарцуулахгүй).
 *  - PAYMENT_CALLBACK_RATE_LIMIT — провайдер тус бүрийн НИЙТ хувин (бүх pod), минутад; анхдагч 1200.
 * Бусад бүх IP провайдерын хувинд ХЭЗЭЭ Ч хүрэхгүй (олон IP-ээс үерлэж жинхэнэ callback-ийг 429 болгох боломжгүй):
 *  - PAYMENT_CALLBACK_UNTRUSTED_IP_RATE_LIMIT — нэг IP, минутад; анхдагч 30. Эхэлж шалгана.
 *  - PAYMENT_CALLBACK_UNTRUSTED_RATE_LIMIT — провайдер тус бүрийн «итгэмжлэгдээгүй» нийт хувин, минутад; анхдагч 300.
 */
export function callbackRateLimits(env: NodeJS.ProcessEnv = process.env): { perProvider: number; perIp: number; untrustedPerIp: number; untrustedShared: number } {
  return {
    perProvider: positiveInt('PAYMENT_CALLBACK_RATE_LIMIT', 1200, env),
    perIp: positiveInt('PAYMENT_CALLBACK_IP_RATE_LIMIT', 600, env),
    untrustedPerIp: positiveInt('PAYMENT_CALLBACK_UNTRUSTED_IP_RATE_LIMIT', 30, env),
    untrustedShared: positiveInt('PAYMENT_CALLBACK_UNTRUSTED_RATE_LIMIT', 300, env),
  };
}

/** Route-ийг провайдерын хувинд ононо. */
export const CallbackProvider = (provider: PublicCallbackRoute['provider']) => SetMetadata(PROVIDER_KEY, provider);

/** Redis-тэй SharedCounterStore — бүх gateway pod нэг тоолуур (M9). 429 нь Retry-After-тэй; провайдер дахин илгээнэ, origination poll/maintenance нөхнө. */
@Injectable()
export class PaymentCallbackRateLimitGuard implements CanActivate {
  /** Эхлэхэд уншиж шалгана: буруу CIDR → gateway эхлэхгүй. */
  private readonly trusted = loadTrustedSources();

  constructor(private readonly reflector: Reflector, private readonly counters: SharedCounterStore) {
    const log = new Logger('PaymentCallbacks');
    for (const w of trustedSourceWarnings()) log.warn(w);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const provider = this.reflector.get<PublicCallbackRoute['provider'] | undefined>(PROVIDER_KEY, context.getHandler());
    // Хувингүй route нь програмчлалын алдаа — хязгааргүй нээхгүй
    if (!provider) throw new Error('Payment callback route is missing @CallbackProvider()');
    const http = context.switchToHttp();
    const ip = resolveClientIp(http.getRequest<Request>());
    const limits = callbackRateLimits();
    const ipKey = rateLimitKeyForIp(ip);
    const [ipBucket, ipLimit, sharedBucket, sharedLimit] = this.trusted.isTrusted(provider, ip)
      ? [`pcb:ip:${ipKey}`, limits.perIp, `pcb:provider:${provider}`, limits.perProvider]
      : [`pcb:untrusted:ip:${ipKey}`, limits.untrustedPerIp, `pcb:untrusted:provider:${provider}`, limits.untrustedShared];
    await this.take(ipBucket, ipLimit, http.getResponse<Response>());
    await this.take(sharedBucket, sharedLimit, http.getResponse<Response>());
    return true;
  }

  /** Атомар hit; хэтэрвэл 429. */
  private async take(key: string, limit: number, res: Response): Promise<void> {
    const s = await this.counters.store.hit(`${this.counters.prefix}${key}`, WINDOW_MS);
    if (s.count <= limit) return;
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(s.resetMs / 1000))));
    throw new HttpException({ code: 'RATE_LIMITED', message: 'Хэт олон хүсэлт' }, HttpStatus.TOO_MANY_REQUESTS);
  }
}
