import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PortalError } from '../../common/portal-error';
import { RateLimitService } from '../../security/rate-limit.service';
import { clientIp } from '../../security/rate-limit.guard';
import { IS_PUBLIC_KEY } from './public.decorator';
import { SessionService } from './session.service';
import { TokenService } from './token.service';

/** Анхдагчаар бүх маршрут Bearer JWT шаардана; `@Public()`-тай нь л чөлөөтэй. */
@Injectable()
export class CustomerAuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
    private readonly limiter: RateLimitService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()])) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    try {
      const token = bearerToken(req);
      const claims = this.tokens.verifyAccess(token);
      if (!(await this.sessions.isActive(claims.sessionId, claims.customerId))) throw new PortalError('UNAUTHENTICATED');
      req.principal = { customerId: claims.customerId, sessionId: claims.sessionId };
      return true;
    } catch (err) {
      // Нэвтрээгүй хүсэлт rate-limit guard-д хүрэхгүй тул хуурамч/дууссан токеныг энд IP-ээр тоолно.
      if (err instanceof PortalError && err.code === 'UNAUTHENTICATED') {
        await this.limiter.enforce({ name: 'auth-fail:ip', limit: 60, windowSec: 60 }, clientIp(req));
      }
      throw err;
    }
  }
}

function bearerToken(req: Request): string {
  const header = req.header('authorization');
  const match = header ? /^Bearer ([A-Za-z0-9._-]{20,2048})$/.exec(header) : null;
  if (!match) throw new PortalError('UNAUTHENTICATED');
  return match[1];
}
