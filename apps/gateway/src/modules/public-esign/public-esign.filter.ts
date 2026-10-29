import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { PUBLIC_ERRORS, PublicEsignError } from './errors';
import { applyNoStoreHeaders } from './response-headers';

/**
 * Public e-sign route-ийн БҮХ алдааг `{ code, message }` хэлбэрт хөрвүүлнэ. Танигдаагүй алдааны дотоод мэдээлэл (message, stack) клиентэд гарахгүй, зөвхөн логт.
 */
@Catch()
export class PublicEsignExceptionFilter implements ExceptionFilter {
  private readonly log = new Logger('EsignProxy');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    // Хариу аль хэдийн эхэлсэн / клиент таслагдсан бол дахин бичих боломжгүй — холболтыг таслана
    if (res.headersSent || res.destroyed) {
      res.destroy();
      return;
    }
    applyNoStoreHeaders(res);
    if (exception instanceof PublicEsignError) {
      for (const [name, value] of Object.entries(exception.headers)) res.setHeader(name, value);
      res.status(exception.getStatus()).json(exception.getResponse());
      return;
    }
    if (exception instanceof HttpException && exception.getStatus() < 500) {
      const { message } = PUBLIC_ERRORS.REQUEST_REJECTED;
      res.status(exception.getStatus()).json({ code: 'REQUEST_REJECTED', message });
      return;
    }
    this.log.error(JSON.stringify({ event: 'esign_proxy_unhandled', error: exception instanceof Error ? exception.name : typeof exception }));
    const { status, message } = PUBLIC_ERRORS.INTERNAL_ERROR;
    res.status(status).json({ code: 'INTERNAL_ERROR', message });
  }
}
