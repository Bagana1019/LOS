import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { RATE_LIMIT_KEY, type RateLimitOptions, SKIP_RATE_LIMIT_KEY } from './rate-limit.decorator';
import { RateLimitService } from './rate-limit.service';

export const GLOBAL_IP_LIMIT = { limit: 300, windowSec: 60 } as const;

/**
 * Auth guard-ийн ДАРАА ажиллана (per-customer хязгаарт principal хэрэгтэй).
 * Нэвтрээгүй хүсэлт auth guard дээр 401-ээр унах тул тэдгээрийн IP хязгаарыг AuthGuard өөрөө тоолно.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimitService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(SKIP_RATE_LIMIT_KEY, targets)) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const opts = this.reflector.getAllAndOverride<RateLimitOptions | undefined>(RATE_LIMIT_KEY, targets);
    const route = `${ctx.getClass().name}.${ctx.getHandler().name}`;
    const ip = clientIp(req);

    await this.limiter.enforce({ name: 'ip:global', ...GLOBAL_IP_LIMIT }, ip);
    if (opts?.ip) await this.limiter.enforce({ name: `ip:${route}`, ...opts.ip }, ip);
    if (opts?.customer && req.principal) {
      await this.limiter.enforce({ name: `customer:${route}`, ...opts.customer }, req.principal.customerId);
    }
    return true;
  }
}

export function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}
