import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { contextOf } from '@los/nest-common';
import { AuditService } from './audit.service';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Gateway-ээр дамжсан БҮХ өөрчлөх хүсэлтийг (POST/PUT/PATCH/DELETE) audit_log-д бүртгэнэ: хэн, хэзээ, ямар endpoint, ямар хариу.
 * Body бичихгүй (хувийн мэдээлэл/нууц). Бизнесийн өмнөх/шинэ утгын аудитыг сервис өөрөө бичнэ (@los/database recordAudit).
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<{ method: string; originalUrl: string; ip?: string; headers: Record<string, string | string[] | undefined> }>();
    if (!MUTATING.has(req.method)) return next.handle();
    const res = context.switchToHttp().getResponse<{ statusCode: number; once(ev: string, fn: () => void): void }>();
    // Proxy нь req.url-ийг дахин бичдэг тул замыг ЭХЭНД (originalUrl-аас, query-гүй) авна
    const path = req.originalUrl.split('?')[0]!;
    const ctx = contextOf(req as never);
    const started = Date.now();
    res.once('finish', () => {
      this.audit.recordSafe({
        orgId: ctx.orgId || null, entity: 'HTTP', entityId: `${req.method} ${path.replace(UUID, ':id')}`, action: `HTTP_${req.method}`, actorId: ctx.userId,
        afterJson: { status: res.statusCode, durationMs: Date.now() - started }, correlationId: ctx.correlationId, ip: req.ip ?? null,
        userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
      });
    });
    return next.handle();
  }
}
