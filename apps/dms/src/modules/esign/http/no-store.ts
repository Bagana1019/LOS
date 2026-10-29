// FR-11.4 Хариу кэшлэгдэхгүй: линкийн токен, гэрээ (PII агуулсан PDF), гарын үсгийн мэдээлэл браузер/proxy-д үлдэхгүй, MIME sniff хийгдэхгүй.
import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';
import type { Observable } from 'rxjs';

export function applyNoStore(res: Pick<Response, 'setHeader'>): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

/** Controller-д: амжилттай хариуны толгойг handler-ээс өмнө тавина (алдааны хариунд filter өөрөө тавьдаг) */
@Injectable()
export class NoStoreInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    applyNoStore(context.switchToHttp().getResponse<Response>());
    return next.handle();
  }
}
