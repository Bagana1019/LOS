import { type CanActivate, type ExecutionContext, HttpException, HttpStatus, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { rateLimitKeyForIp, resolveClientIp } from '../public-esign/client-ip';
import type { PublicCallbackRoute } from '../proxy/route-policy';
import { SharedCounterStore } from '../rate-limit/rate-limit.module';

const WINDOW_MS = 60_000;
const PROVIDER_KEY = 'los:payment-callback-provider';

const positiveInt = (name: string, fallback: number, env: NodeJS.ProcessEnv): number => {
  const raw = env[name];
  const n = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid ${name}="${raw}"`);
  return n;
};

/**
 * H9 хязгаар (хүсэлт бүрт env уншина):
 *  - PAYMENT_CALLBACK_RATE_LIMIT — провайдер тус бүрийн НИЙТ хувин (бүх IP, бүх pod), минутад; анхдагч 1200.
 *    Провайдерууд цөөн IP-ээс дууддаг тул IP тутмын хязгаар оргил үед жинхэнэ callback-ийг 429 болгодог байсан.
 *  - PAYMENT_CALLBACK_IP_RATE_LIMIT — нэг IP-ийн дээд хязгаар (зөвхөн халдлагаас), минутад; анхдагч 600.
 *    Эхэлж шалгана: хэтэрсэн IP-ийн хүсэлт провайдерын хувинг ЗАРЦУУЛАХГҮЙ (нэг IP бусдын callback-ийг хааж чадахгүй).
 */
export function callbackRateLimits(env: NodeJS.ProcessEnv = process.env): { perProvider: number; perIp: number } {
  return { perProvider: positiveInt('PAYMENT_CALLBACK_RATE_LIMIT', 1200, env), perIp: positiveInt('PAYMENT_CALLBACK_IP_RATE_LIMIT', 600, env) };
}

/** Route-ийг провайдерын хувинд ононо. */
export const CallbackProvider = (provider: PublicCallbackRoute['provider']) => SetMetadata(PROVIDER_KEY, provider);

/** Redis-тэй SharedCounterStore — бүх gateway pod нэг тоолуур (M9). 429 нь Retry-After-тэй; провайдер дахин илгээнэ, origination poll/maintenance нөхнө. */
@Injectable()
export class PaymentCallbackRateLimitGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly counters: SharedCounterStore) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const provider = this.reflector.get<PublicCallbackRoute['provider'] | undefined>(PROVIDER_KEY, context.getHandler());
    // Хувингүй route нь програмчлалын алдаа — хязгааргүй нээхгүй
    if (!provider) throw new Error('Payment callback route is missing @CallbackProvider()');
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const limits = callbackRateLimits();
    const { prefix, store } = this.counters;

    const ip = await store.hit(`${prefix}pcb:ip:${rateLimitKeyForIp(resolveClientIp(req))}`, WINDOW_MS);
    if (ip.count > limits.perIp) this.reject(http.getResponse<Response>(), ip.resetMs);
    const bucket = await store.hit(`${prefix}pcb:provider:${provider}`, WINDOW_MS);
    if (bucket.count > limits.perProvider) this.reject(http.getResponse<Response>(), bucket.resetMs);
    return true;
  }

  private reject(res: Response, resetMs: number): never {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(resetMs / 1000))));
    throw new HttpException({ code: 'RATE_LIMITED', message: 'Хэт олон хүсэлт' }, HttpStatus.TOO_MANY_REQUESTS);
  }
}
