// main.ts болон e2e тестүүдийн ЯГ ИЖИЛ bootstrap: global угтвар /api, нэгдсэн алдааны filter, correlation толгой, JSON body-ийн хязгаар.
// (Файлын multipart хязгаар нь BsaUploadInterceptor + BsaSettings; энд JSON/form body-ийг л хязгаарлана.)
// `enableShutdownHooks()` нь процесс тутамд нэг л удаа тул main.ts-д (тест бүр signal listener нэмэхээс сэргийлнэ).
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { BsaExceptionFilter } from './bsa-exception.filter';
import { CorrelationInterceptor } from './correlation.interceptor';

export const API_PREFIX = 'api';
/** BSA-ийн JSON хүсэлтүүд жижиг (ID жагсаалт ≤ 1000, параметр) */
export const JSON_BODY_LIMIT = '1mb';

export function configureBsaApp(app: INestApplication): void {
  app.setGlobalPrefix(API_PREFIX);
  app.useGlobalFilters(new BsaExceptionFilter());
  app.useGlobalInterceptors(new CorrelationInterceptor());
  const express = app as NestExpressApplication;
  express.disable('x-powered-by');
  express.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  express.useBodyParser('urlencoded', { extended: true, limit: JSON_BODY_LIMIT });
}
