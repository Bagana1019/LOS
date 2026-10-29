import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { PortalError } from '../../common/portal-error';
import type { CallContext } from '../../common/request-context';

/** Нэвтэрсэн харилцагчийн downstream контекст (customerId + correlationId). */
export const CallCtx = createParamDecorator((_data: unknown, ctx: ExecutionContext): CallContext => {
  const req = ctx.switchToHttp().getRequest<Request>();
  if (!req.principal) throw new PortalError('UNAUTHENTICATED');
  return { customerId: req.principal.customerId, correlationId: req.correlationId };
});

/** Нэвтрээгүй маршрутын хүсэлтийн мэдээлэл: IP + correlationId. */
export const ReqInfo = createParamDecorator((_data: unknown, ctx: ExecutionContext): { ip: string; correlationId: string } => {
  const req = ctx.switchToHttp().getRequest<Request>();
  return { ip: req.ip ?? req.socket.remoteAddress ?? 'unknown', correlationId: req.correlationId };
});
