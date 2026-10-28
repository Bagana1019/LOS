// BSA-FR-2.1: multipart `files` хүлээн авна. Хязгаарыг (файлын хэмжээ, файлын тоо) BsaSettings-ээс ХҮСЭЛТ ТУТАМД авна (байгууллага тутмын
// тохиргоо ирэхэд тохирно) — тиймээс Nest-ийн `FilesInterceptor`-ыг хүсэлт бүрт тухайн хязгаартайгаар үүсгэнэ (multer instance хямд).
//  - Санах ойн storage (multer-ийн анхдагч): файл диск дээр үлдэхгүй; хамгийн их санах ой ≈ maxUploadBytes × maxFilesPerUpload (README).
//  - Guard (контекст + үүрэг) interceptor-оос ӨМНӨ ажиллана ⇒ эрхгүй хэрэглэгчийн том биеийг уншихгүй.
//  - multer-ийн англи алдааг монгол errorCode-той BsaException болгоно (413 FILE_TOO_LARGE, 400 TOO_MANY_FILES, 400 UNEXPECTED_FILE_FIELD, 400 INVALID_MULTIPART).
import {
  BadRequestException, type CallHandler, type ExecutionContext, HttpException, HttpStatus, Inject, Injectable, Logger, type NestInterceptor,
  PayloadTooLargeException,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Observable } from 'rxjs';
import { describeError } from '../../common/import-queue';
import { BSA_SETTINGS, type BsaSettings, type BsaSettingsProvider } from '../../common/infra.ports';
import { resolveRequestContext } from '../../common/request-context';
import { BsaException } from '../import.errors';

/** Файл оруулах multipart талбарын нэр */
export const UPLOAD_FIELD = 'files';

/** Техникийн хязгаар (бизнесийн босго БИШ): текст талбарын тоо/хэмжээ. `banks` JSON бага (файл тутамд ~10 тэмдэгт) */
export const UPLOAD_TECH_LIMITS = { maxTextFields: 4, maxFieldBytes: 16 * 1024, maxFieldNameBytes: 100, extraParts: 4 } as const;

export function uploadLimits(settings: Pick<BsaSettings, 'maxUploadBytes' | 'maxFilesPerUpload'>) {
  return {
    fileSize: settings.maxUploadBytes,
    files: settings.maxFilesPerUpload,
    fields: UPLOAD_TECH_LIMITS.maxTextFields,
    fieldSize: UPLOAD_TECH_LIMITS.maxFieldBytes,
    fieldNameSize: UPLOAD_TECH_LIMITS.maxFieldNameBytes,
    parts: settings.maxFilesPerUpload + UPLOAD_TECH_LIMITS.extraParts,
  };
}

/** multer-ийн алдаа (Nest `transformException`-ийн дараах) → домэйн алдаа. Мессеж агуулгыг (файлын нэр) оруулдаггүй ч хариунд дамжуулахгүй */
export function mapUploadError(e: unknown, settings: Pick<BsaSettings, 'maxUploadBytes' | 'maxFilesPerUpload'>): HttpException {
  if (e instanceof PayloadTooLargeException) {
    return new BsaException(HttpStatus.PAYLOAD_TOO_LARGE, 'FILE_TOO_LARGE', { maxBytes: settings.maxUploadBytes });
  }
  if (e instanceof BadRequestException) {
    const raw = (e.getResponse() as { message?: unknown }).message;
    const text = typeof raw === 'string' ? raw : '';
    if (text === 'Too many files') return new BsaException(HttpStatus.BAD_REQUEST, 'TOO_MANY_FILES', { max: settings.maxFilesPerUpload });
    if (text === 'Unexpected field') return new BsaException(HttpStatus.BAD_REQUEST, 'UNEXPECTED_FILE_FIELD');
    return new BsaException(HttpStatus.BAD_REQUEST, 'INVALID_MULTIPART');
  }
  if (e instanceof HttpException) return e;
  // busboy: «Unexpected end of form», «Multipart: Boundary not found» гэх мэт — хэрэглэгчийн хүсэлтийн алдаа
  return new BsaException(HttpStatus.BAD_REQUEST, 'INVALID_MULTIPART');
}

@Injectable()
export class BsaUploadInterceptor implements NestInterceptor {
  private readonly log = new Logger(BsaUploadInterceptor.name);

  constructor(@Inject(BSA_SETTINGS) private readonly settingsProvider: BsaSettingsProvider) {}

  async intercept(host: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const ctx = resolveRequestContext(host.switchToHttp().getRequest());
    const settings = await this.settingsProvider.get(ctx.orgId);
    const Inner = FilesInterceptor(UPLOAD_FIELD, undefined, { limits: uploadLimits(settings) });
    try {
      return await new Inner({}).intercept(host, next);
    } catch (e) {
      if (!(e instanceof HttpException)) this.log.warn(`multipart rejected (${describeError(e)})`);
      throw mapUploadError(e, settings);
    }
  }
}
