// Баримтын OCR REST (DMS файл/баримт эзэмшдэг тул энд). Gateway-ийн /api угтвар дор:
//   POST /api/ocr/extract   multipart: file, docType (ID_CARD|SALARY_CERTIFICATE|GENERIC|AUTO, анхдагч AUTO), includeText (false)
//   GET  /api/ocr/doc-types
//   GET  /api/ocr/health
// Авторизаци gateway-д (CLAUDE.md §3.2(9)). Файлын төрлийг клиентийн толгойгоор БИШ, агуулгын magic bytes-аар тодорхойлно.
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Post,
  Res,
  UploadedFile,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { detectOcrMime, OcrError } from '@los/ocr';
import type { Response } from 'express';
import { sanitizeCorrelationId } from './correlation';
import { extractBodySchema, type ExtractBody } from './ocr.dto';
import { OcrErrorFilter } from './ocr-error.filter';
import { OcrService, type ExtractResponse, type HealthResponse } from './ocr.service';
import { ZodValidationPipe } from './zod-validation.pipe';

@Controller('ocr')
@UseFilters(OcrErrorFilter)
export class OcrController {
  constructor(@Inject(OcrService) private readonly ocr: OcrService) {}

  @Post('extract')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store') // хариу PII агуулна
  @UseInterceptors(FileInterceptor('file'))
  async extract(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body(new ZodValidationPipe(extractBodySchema)) body: ExtractBody,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<ExtractResponse> {
    if (!file || !Buffer.isBuffer(file.buffer) || file.size === 0) throw new BadRequestException({ statusCode: 400, error: 'Bad Request', code: 'FILE_REQUIRED', message: "'file' талбарт хоосон биш нэг файл шаардлагатай" });
    const mimeType = detectOcrMime(file.buffer);
    if (!mimeType) throw new OcrError('UNSUPPORTED_MIME', 'magic bytes таарсангүй');
    return this.ocr.extract({
      content: file.buffer,
      mimeType,
      fileName: file.originalname,
      docType: body.docType,
      includeText: body.includeText,
      correlationId: sanitizeCorrelationId(correlationId),
    });
  }

  @Get('doc-types')
  docTypes(): ReturnType<OcrService['docTypes']> {
    return this.ocr.docTypes();
  }

  @Get('health')
  async health(@Res({ passthrough: true }) res: Response): Promise<HealthResponse> {
    const h = await this.ocr.health();
    if (!h.ok) res.status(503);
    return h;
  }
}
