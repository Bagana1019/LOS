// Маршрут тутмын үүргийн шалгалт. Тенант/салбар/эзэмшигчийн шалгалт service-д (access.ts); энд зөвхөн «энэ үүрэг энэ маршрутыг дуудаж болох уу».
// Deny-by-default: `@Roles` заагаагүй handler 403 өгнө (шинэ маршрут нэмэхдээ эрхээ мартахаас сэргийлнэ) — `roles.test.ts` бүх маршрутыг шалгана.
import { ForbiddenException, Inject, Injectable, SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@los/contracts';
import { resolveRequestContext } from '../../common/request-context';
import { hasAnyRole, WRITE_ROLES } from '../access';

export const ROLES_KEY = 'bsa:roles';
/** Маршрутын үүргийн татгалзал (шинжилгээнд хамаарахгүй маршрутад ч тохирно) */
export const ROUTE_FORBIDDEN_MESSAGE = 'Энэ үйлдлийг хийх эрх байхгүй байна.';

/** docs/01 §3: бүх үүрэг уншина (хүрээг service тодорхойлно) */
export const READ_ROLES: readonly UserRole[] = UserRole;
/** Бичих: APPROVER зөвхөн харна */
export const WRITE_ONLY_ROLES: readonly UserRole[] = WRITE_ROLES;
export const ADMIN_ONLY: readonly UserRole[] = ['ADMIN'];

export const Roles = (...roles: readonly UserRole[]): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(host: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<readonly UserRole[] | undefined>(ROLES_KEY, [host.getHandler(), host.getClass()]);
    if (!roles || roles.length === 0) throw new ForbiddenException(ROUTE_FORBIDDEN_MESSAGE);
    const ctx = resolveRequestContext(host.switchToHttp().getRequest());
    if (!hasAnyRole(ctx, roles)) throw new ForbiddenException(ROUTE_FORBIDDEN_MESSAGE);
    return true;
  }
}
