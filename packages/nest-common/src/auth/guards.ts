import { timingSafeEqual } from 'node:crypto';
import { type CanActivate, type ExecutionContext, ForbiddenException, Inject, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CTX_HEADERS, permissionsFor, type Permission } from '@los/contracts';
import { contextOf } from '../context/request-context';

export const PUBLIC_KEY = 'los:public';
export const ROLES_KEY = 'los:roles';
export const PERMISSIONS_KEY = 'los:permissions';

/** Нэвтрэлт шаардахгүй (health, гадаад callback). Callback бол өөрийн баталгаажуулалтыг заавал хийнэ. */
export const Public = () => SetMetadata(PUBLIC_KEY, true);
/** Эдгээр дүрийн ЯМАР Ч НЭГ нь байвал нэвтрүүлнэ. */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
/** Эдгээр эрх БҮГД байх ёстой (`@los/contracts` ROLE_PERMISSIONS). */
export const Permissions = (...permissions: Permission[]) => SetMetadata(PERMISSIONS_KEY, permissions);

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Дотоод сервисийн глобал guard: gateway-ээс ирсэн контекстэд итгэнэ (CLAUDE.md §3.2.9).
 * `INTERNAL_AUTH_SECRET` тохируулсан бол `X-Internal-Token` таарахгүй хүсэлтийг хаана (gateway-г тойрч шууд дуудахаас хамгаална).
 */
@Injectable()
export class ContextAuthGuard implements CanActivate {
  // vitest (esbuild) нь decorator metadata гаргадаггүй тул @Inject-ийг тодорхой бичнэ
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;

    const req = context.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    const secret = process.env.INTERNAL_AUTH_SECRET;
    if (secret) {
      const token = req.headers[CTX_HEADERS.internalToken];
      if (typeof token !== 'string' || !safeEqual(token, secret)) throw new UnauthorizedException({ code: 'INVALID_INTERNAL_TOKEN', message: 'Дотоод сервисийн токен буруу' });
    }
    const ctx = contextOf(req as never);
    if (!ctx.userId && !ctx.customerId) throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Нэвтрээгүй хүсэлт' });
    if (!ctx.orgId) throw new UnauthorizedException({ code: 'MISSING_ORG', message: 'X-Org-Id толгой дутуу' });

    const roles = this.reflector.getAllAndOverride<string[] | undefined>(ROLES_KEY, targets);
    if (roles?.length && !roles.some((r) => ctx.roles.includes(r))) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Энэ үйлдэлд эрх хүрэхгүй' });
    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(PERMISSIONS_KEY, targets);
    if (required?.length) {
      const have = new Set(permissionsFor(ctx.roles));
      if (!required.every((p) => have.has(p))) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Энэ үйлдэлд эрх хүрэхгүй' });
    }
    return true;
  }
}
