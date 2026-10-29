// OCR модуль (DMS). INTEGRATION_MODE=mock|real env-ээр provider солигдоно (@los/ocr createOcrProvider).
import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { createOcrProvider } from '@los/ocr';
import { OcrController } from './ocr.controller';
import { readOcrConfig, type OcrHttpConfig } from './ocr.config';
import { OcrService } from './ocr.service';
import { OCR_CLOCK, OCR_CONFIG, OCR_PROVIDER } from './ocr.tokens';

export { OCR_PROVIDER } from './ocr.tokens';

/**
 * multer: storage/dest өгөөгүй бол multer өөрөө санах ой (MemoryStorage) ашиглана — диск дээр баримт үлдэхгүй (PII).
 * Хэмжээ/тоо хязгаартай (файл нэг, текст талбар цөөн, жижиг). env-ийг модуль үүсэх үед уншина.
 */
export function buildMulterOptions(config: OcrHttpConfig) {
  return {
    limits: { fileSize: config.maxFileBytes, files: 1, fields: 5, fieldSize: 256, parts: 8, headerPairs: 64 },
  };
}

@Module({
  imports: [MulterModule.registerAsync({ useFactory: () => buildMulterOptions(readOcrConfig(process.env)) })],
  controllers: [OcrController],
  providers: [
    { provide: OCR_CONFIG, useFactory: () => readOcrConfig(process.env) },
    { provide: OCR_PROVIDER, useFactory: () => createOcrProvider(process.env) },
    { provide: OCR_CLOCK, useValue: () => new Date() },
    OcrService,
  ],
  exports: [OCR_PROVIDER, OcrService],
})
export class OcrModule {}
