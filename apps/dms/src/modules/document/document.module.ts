import { Module } from '@nestjs/common';
import { FileModule } from '../file/file.module';
import { OcrModule } from '../ocr/ocr.module';
import { DocumentController } from './document.controller';
import { DocumentService } from './document.service';

// Модуль 9 (FR-9.1): `document` (хүсэлт/зээлдэгч/барьцаатай холбогдсон файл). Зөвхөн origination (sync) дууддаг дотоод API.
// FileModule → OBJECT_STORAGE (OCR-д файл унших), OcrModule → OcrService (provider `INTEGRATION_MODE`-оор). PrismaService/CommonModule нь AppModule-аас.
@Module({
  imports: [FileModule, OcrModule],
  controllers: [DocumentController],
  providers: [DocumentService],
  exports: [DocumentService],
})
export class DocumentModule {}
