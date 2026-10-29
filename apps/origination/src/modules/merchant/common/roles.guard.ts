import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MerchantRole } from '@los/contracts';
import { DomainError } from '../domain/errors';
import type { HttpRequest } from './http.types';
import { ROLES_KEY } from './roles.decorator';

/** ContextGuard-ийн ДАРАА ажиллана. Мерчант + лизингийн дүр хольсон principal-г (хүрээ тодорхойгүй) үргэлж хаана. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[] | undefined>(ROLES_KEY, [context.getHandler(), context.getClass()]);
    const req = context.switchToHttp().getRequest<HttpRequest>();
    const roles = req.ctx?.roles ?? [];
    const merchantRole = roles.some((r) => (MerchantRole as readonly string[]).includes(r));
    const otherRole = roles.some((r) => !(MerchantRole as readonly string[]).includes(r));
    if (!required?.length || (merchantRole && otherRole) || !roles.some((r) => required.includes(r))) throw new DomainError('FORBIDDEN', 'Insufficient role');
    return true;
  }
}
