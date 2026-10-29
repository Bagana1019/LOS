import { All, Controller, ForbiddenException, NotFoundException, Req, Res, UseInterceptors } from '@nestjs/common';
import { hasPermission } from '@los/contracts';
import { contextOf } from '@los/nest-common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { PROXIED_SERVICES, ProxyService, type ProxiedService } from './proxy.service';
import { isAmbiguousPath, isInternalOnly, requiredPermission } from './route-policy';

type Req_ = IncomingMessage & { path: string; method: string };

/** web → gateway → сервис (CLAUDE.md §3.2.1). JwtAuthGuard (глобал) нэвтрэлтийг баталгаажуулсны дараа л энд хүрнэ. */
@Controller()
@UseInterceptors(AuditInterceptor)
export class ProxyController {
  constructor(private readonly proxy: ProxyService) {}

  @All(PROXIED_SERVICES.map((s) => `${s}/*`))
  forward(@Req() req: Req_, @Res() res: ServerResponse): void {
    const service = req.path.split('/')[2] as ProxiedService;
    if (isAmbiguousPath(req.path) || !PROXIED_SERVICES.includes(service) || isInternalOnly(req.path)) throw new NotFoundException();
    const need = requiredPermission(req.method, req.path);
    if (need && !hasPermission(contextOf(req as never).roles, need)) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Энэ үйлдэлд эрх хүрэхгүй' });
    this.proxy.forward(service, req, res);
  }
}
