// OcrError → HTTP. Мессеж нь тогтмол (Монгол): provider-ийн мессеж, баримтын текст, файлын нэрийг ХЭЗЭЭ Ч хариунд оруулахгүй.
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import { OcrError, type OcrErrorCode } from '@los/ocr';
import type { Request, Response } from 'express';
import { GateFullError } from './concurrency-gate';
import { sanitizeCorrelationId } from './correlation';

interface Mapped {
  status: number;
  error: string;
  message: string;
}

export const OCR_ERROR_HTTP: Readonly<Record<OcrErrorCode, Mapped>> = {
  UNSUPPORTED_MIME: { status: HttpStatus.UNSUPPORTED_MEDIA_TYPE, error: 'Unsupported Media Type', message: 'Дэмжигдээгүй файлын төрөл (PNG, JPEG, TIFF, WebP, PDF зөвшөөрнө)' },
  INVALID_INPUT: { status: HttpStatus.BAD_REQUEST, error: 'Bad Request', message: 'Файл буруу эсвэл унших боломжгүй байна' },
  EMPTY_RESULT: { status: HttpStatus.UNPROCESSABLE_ENTITY, error: 'Unprocessable Entity', message: 'Файлаас текст олдсонгүй' },
  NO_FIXTURE: { status: HttpStatus.UNPROCESSABLE_ENTITY, error: 'Unprocessable Entity', message: 'Mock OCR-д энэ файлд тохирох fixture бүртгэгдээгүй байна' },
  ENGINE_UNAVAILABLE: { status: HttpStatus.SERVICE_UNAVAILABLE, error: 'Service Unavailable', message: 'OCR хөдөлгүүр түр ажиллахгүй байна' },
  TIMEOUT: { status: HttpStatus.GATEWAY_TIMEOUT, error: 'Gateway Timeout', message: 'OCR хугацаа хэтэрлээ' },
  ENGINE_FAILED: { status: HttpStatus.BAD_GATEWAY, error: 'Bad Gateway', message: 'OCR хөдөлгүүр алдаа гаргалаа' },
};

@Catch(OcrError, GateFullError)
export class OcrErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('OcrErrorFilter');

  catch(exception: OcrError | GateFullError, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const correlationId = sanitizeCorrelationId(req.headers?.['x-correlation-id']);
    const isGate = exception instanceof GateFullError;
    const code = isGate ? 'BUSY' : (exception as OcrError).code;
    const mapped: Mapped = isGate
      ? { status: HttpStatus.TOO_MANY_REQUESTS, error: 'Too Many Requests', message: 'OCR түр завгүй байна, дахин оролдоно уу' }
      : OCR_ERROR_HTTP[(exception as OcrError).code] ?? OCR_ERROR_HTTP.ENGINE_FAILED;
    // лог: код л (exception.message-д нууц/PII байх боломжтой тул бичихгүй)
    this.logger.warn(JSON.stringify({ event: 'ocr.error', code, status: mapped.status, correlationId }));
    res.status(mapped.status).json({ statusCode: mapped.status, error: mapped.error, code, message: mapped.message });
  }
}
