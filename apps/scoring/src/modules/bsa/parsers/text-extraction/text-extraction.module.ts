// text-extraction Nest модуль: StatementTextService + OCR_PROVIDER. Parser-ийн дээд талд (import дэд модуль) ашиглана.
//  imports: [TextExtractionModule]                                 — OCR_PROVIDER = createOcrProvider(process.env) (INTEGRATION_MODE=mock|real)
//  imports: [TextExtractionModule.register({ options, ocrProvider })] — хязгаар/босго дарах, эсвэл бэлэн provider өгөх
import { DynamicModule, Module, type FactoryProvider, type Provider } from '@nestjs/common';
import { createOcrProvider, type OcrProvider } from '@los/ocr';
import { StatementTextService } from './statement-text.service';
import { OCR_PROVIDER, TEXT_EXTRACTION_OPTIONS } from './tokens';
import type { TextExtractionOptionsInput } from './types';

/** CLAUDE.md §3.2(7): INTEGRATION_MODE env-ээр mock | tesseract. Тохиргооны алдаа эхлэхэд л (fail-fast) унана. */
export const ocrProviderFactory: FactoryProvider<OcrProvider> = {
  provide: OCR_PROVIDER,
  useFactory: () => createOcrProvider(process.env),
};

export interface TextExtractionModuleOptions {
  options?: TextExtractionOptionsInput;
  /** Өгвөл env-ээс үүсгэхийн оронд үүнийг ашиглана */
  ocrProvider?: OcrProvider;
}

@Module({
  providers: [ocrProviderFactory, StatementTextService],
  // OCR_PROVIDER-ийг экспортолно: бусад BSA модуль (жишээ нь баримтын OCR) нэг л хөдөлгүүрийг дахин ашиглана
  exports: [StatementTextService, OCR_PROVIDER],
})
export class TextExtractionModule {
  /** Динамик providers нь статик metadata-г ДАРЖ бичнэ (ижил токен) */
  static register(config: TextExtractionModuleOptions = {}): DynamicModule {
    const providers: Provider[] = [{ provide: TEXT_EXTRACTION_OPTIONS, useValue: config.options ?? {} }];
    if (config.ocrProvider) providers.push({ provide: OCR_PROVIDER, useValue: config.ocrProvider });
    return { module: TextExtractionModule, providers };
  }
}
