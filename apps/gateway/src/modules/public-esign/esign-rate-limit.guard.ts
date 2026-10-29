import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { rateLimitKeyForIp, resolveClientIp } from './client-ip';
import { PublicEsignError } from './errors';
import { PROXY_CONFIG, ProxyConfig, RateGroup } from './esign-proxy.config';
import { FixedWindowRateLimiter, RATE_LIMITER } from './rate-limiter';

const RATE_GROUP_KEY = 'esignRateGroup';

/** Route-ийг rate limit-ийн бүлэгт ононо (бүлэг бүр өөрийн IP тоолууртай). */
export const RateGroupOf = (group: RateGroup) => SetMetadata(RATE_GROUP_KEY, group);

// Webhook нь provider-ийн цөөн тооны серверээс burst-ээр ирдэг тул IP тус бүрээр хязгаарлахгүй; оронд нь бүх IP-ийн нийт хязгаар (ESIGN_WEBHOOK_RATE_LIMIT_PER_MIN).
// Нийт хязгаар дүүрвэл provider дахин илгээнэ / dms-ийн poll + sweeper гарын үсгийг баталгаажуулна.
const WEBHOOK_KEY = 'webhook';

@Injectable()
export class EsignRateLimitGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(RATE_LIMITER) private readonly limiter: FixedWindowRateLimiter,
    @Inject(PROXY_CONFIG) private readonly config: ProxyConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const group = this.reflector.get<RateGroup | undefined>(RATE_GROUP_KEY, context.getHandler());
    // Бүлэггүй route нь програмчлалын алдаа — хязгааргүй нээхгүй, 500-аар унагана
    if (!group) throw new Error('E-sign route is missing @RateGroupOf()');
    const req = context.switchToHttp().getRequest<Request>();
    const key = group === 'webhook' ? WEBHOOK_KEY : `${group}:${rateLimitKeyForIp(resolveClientIp(req))}`;
    const decision = this.limiter.consume(key, this.config.rateLimits[group]);
    if (!decision.allowed) throw new PublicEsignError('RATE_LIMITED', { 'Retry-After': String(decision.retryAfterSec) });
    return true;
  }
}
