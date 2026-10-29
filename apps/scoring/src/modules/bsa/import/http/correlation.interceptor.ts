// CLAUDE.md §3.2(10): хүсэлт бүр correlationId дамжуулна. Guard-ийн дараа ажиллах тул толгой хүчинтэй; хүчингүй бол алдаа аль хэдийн гарсан.
// X-Correlation-Id-ийг хариуны толгойд буцаана (gateway лог холбоход). Толгой байхгүй бол parseRequestContext үүсгэсэн UUID.
import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { resolveRequestContext } from '../../common/request-context';

@Injectable()
export class CorrelationInterceptor implements NestInterceptor {
  intercept(host: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (host.getType() === 'http') {
      const http = host.switchToHttp();
      try {
        http.getResponse().setHeader('X-Correlation-Id', resolveRequestContext(http.getRequest()).correlationId);
      } catch {
        // Хүчингүй толгой: guard 401/403 өгсөн байх ёстой; энд юу ч нэмэхгүй
      }
    }
    return next.handle();
  }
}
