import { Module } from '@nestjs/common';
import { FileModule } from '../file/file.module';
import { TemplateController } from './template.controller';
import { TemplateService } from './template.service';
import { createPdfConverter, PDF_CONVERTER } from './pdf-converter';

// Модуль 11 (FR-11.1, FR-11.2): гэрээ/ЭТХ/албан бичгийн загвар + PDF. PrismaService/CommonModule нь AppModule-аас.
@Module({
  imports: [FileModule],
  controllers: [TemplateController],
  providers: [TemplateService, { provide: PDF_CONVERTER, useFactory: () => createPdfConverter() }],
  exports: [TemplateService],
})
export class TemplateModule {}
