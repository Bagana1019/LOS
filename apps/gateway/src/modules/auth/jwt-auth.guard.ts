import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY, PUBLIC_KEY, ROLES_KEY, contextOf } from '@los/nest-common';
import { ForbiddenException } from '@nestjs/common';
import { permissionsFor, type Permission, type SessionUser } from '@los/contracts';
import { AuthService } from './auth.service';
import { isMerchantPrincipal } from './merchant-principal';
import { isMerchantPortalPath } from '../proxy/route-policy';

type Req = { headers: Record<string, string | string[] | undefined>; user?: SessionUser; mustChangePassword?: boolean; originalUrl?: string; url?: string };

/** FR-13: түр нууц үгтэй хэрэглэгчид зөвхөн өөрийн мэдээлэл авах, нууц үг солих зөвшөөрөгдөнө. */
const PASSWORD_CHANGE_PATHS = new Set(['/api/auth/me', '/api/auth/change-password']);

const requestPath = (req: Req) => ((req.originalUrl ?? req.url ?? '').split('?')[0] ?? '').replace(/\/+$/, '');
const isAuthPath = (path: string) => path.toLowerCase().startsWith('/api/auth/');

/**
 * docs/05-merchant-pos.md §8, §13: мерчант principal зөвхөн `/api/auth/*` ба мерчант портал; дүргүй хэрэглэгч (жнь мерчантын буруу тохиргоо) зөвхөн `/api/auth/*`.
 * Ингэснээр "бодлогогүй зам нэвтэрсэн хэрэглэгчид нээлттэй" дүрэм (route-policy) мерчант хэрэглэгчид хамаарахгүй.
 */
function assertMerchantConfinement(user: SessionUser, path: string): void {
  const merchant = isMerchantPrincipal(user.roles);
  if (!merchant && user.roles.length > 0) return;
  if (isAuthPath(path) || (merchant && isMerchantPortalPath(path))) return;
  throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Энэ үйлдэлд эрх хүрэхгүй' });
}

/**
 * Глобал guard: `Authorization: Bearer <JWT>` шалгаад хүсэлтийн контекстийг (req.ctx — ALS-тэй ижил объект) БАТАЛГААЖСАН утгаар дүүргэнэ.
 * Клиентээс ирсэн X-User-Id/X-Roles/... толгойг ашиглахгүй (CommonModule trustIdentityHeaders=false).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;

    const req = context.switchToHttp().getRequest<Req>();
    const header = req.headers.authorization;
    const m = typeof header === 'string' ? /^Bearer\s+(\S+)$/i.exec(header) : null;
    if (!m) throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Нэвтрээгүй хүсэлт' });

    const { user, mustChangePassword } = await this.auth.authenticate(m[1]!);
    if (mustChangePassword && !PASSWORD_CHANGE_PATHS.has(requestPath(req))) {
      throw new ForbiddenException({ code: 'PASSWORD_CHANGE_REQUIRED', message: 'Түр нууц үгээ солино уу' });
    }
    Object.assign(contextOf(req as never), { userId: user.id, roles: [...user.roles], branchId: user.branchId, orgId: user.orgId, customerId: null });
    req.user = user;
    req.mustChangePassword = mustChangePassword;
    assertMerchantConfinement(user, requestPath(req));

    const roles = this.reflector.getAllAndOverride<string[] | undefined>(ROLES_KEY, targets);
    if (roles?.length && !roles.some((r) => user.roles.includes(r as never))) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Энэ үйлдэлд эрх хүрэхгүй' });
    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(PERMISSIONS_KEY, targets);
    if (required?.length) {
      const have = new Set(permissionsFor(user.roles));
      if (!required.every((p) => have.has(p))) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Энэ үйлдэлд эрх хүрэхгүй' });
    }
    return true;
  }
}
