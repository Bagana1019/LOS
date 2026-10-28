import { Catch, HttpException, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';

interface Res { status(code: number): { json(body: unknown): void } }

/** Алдааны нэг хэлбэр: {statusCode, code, message, details?} — UI `code`-оор мапплана. */
@Catch()
export class MakerCheckerExceptionFilter implements ExceptionFilter {
  private readonly log = new Logger('MakerChecker');
  catch(e: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Res>();
    if (e instanceof HttpException) {
      const body = e.getResponse();
      res.status(e.getStatus()).json(typeof body === 'string' ? { statusCode: e.getStatus(), code: 'HTTP_ERROR', message: body } : body);
    } else {
      this.log.error(e instanceof Error ? e.stack ?? e.message : String(e));
      res.status(500).json({ statusCode: 500, code: 'INTERNAL', message: 'Системийн алдаа гарлаа' });
    }
  }
}
