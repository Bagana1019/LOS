import { randomUUID } from 'crypto';
import { createParamDecorator, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { GATEWAY_HEADERS } from '@los/contracts';
import { DomainError } from '../domain/errors';
import type { HttpRequest, HttpResponse } from './http.types';
import type { RequestContext } from './request-context';

const CORRELATION_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_HEADER_LENGTH = 256;

function header(req: HttpRequest, name: string): string | undefined {
  const raw = req.headers[name];
  const v = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return v && v.length <= MAX_HEADER_LENGTH ? v : undefined;
}

/**
 * Gateway-ийн толгойноос RequestContext үүсгэнэ (CLAUDE.md §3.2.9, §3.2.10). x-user-id, x-org-id заавал, үгүй бол 401.
 * Correlation id толгойноос эсвэл шинээр; хариуны x-correlation-id-д буцаана.
 */
@Injectable()
export class ContextGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const req = http.getRequest<HttpRequest>();
    const res = http.getResponse<HttpResponse>();
    const incoming = header(req, GATEWAY_HEADERS.correlationId);
    const correlationId = incoming && CORRELATION_RE.test(incoming) ? incoming : randomUUID();
    res.setHeader(GATEWAY_HEADERS.correlationId, correlationId);

    const userId = header(req, GATEWAY_HEADERS.userId);
    const orgId = header(req, GATEWAY_HEADERS.orgId);
    if (!userId || !orgId) throw new DomainError('UNAUTHENTICATED', 'Authentication required');
    const roles = (header(req, GATEWAY_HEADERS.roles) ?? '').split(',').map((r) => r.trim().toUpperCase()).filter(Boolean);
    const ctx: RequestContext = {
      userId, orgId, roles, correlationId,
      branchId: header(req, GATEWAY_HEADERS.branchId) ?? null,
      merchantId: header(req, GATEWAY_HEADERS.merchantId) ?? null,
      storeId: header(req, GATEWAY_HEADERS.storeId) ?? null,
    };
    req.ctx = ctx;
    return true;
  }
}

/** `@Ctx() ctx: RequestContext` */
export const Ctx = createParamDecorator((_data: unknown, host: ExecutionContext): RequestContext => {
  const req = host.switchToHttp().getRequest<HttpRequest>();
  if (!req.ctx) throw new DomainError('UNAUTHENTICATED', 'Authentication required');
  return req.ctx;
});
