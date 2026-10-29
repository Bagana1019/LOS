// DMS-ийн OCR үйлчилгээ: @los/ocr-ийн OcrDocumentService-ийг (provider + задлагч) Nest DI-д холбоно.
// Баримтын текст/талбарыг ЛОГЛОХГҮЙ — зөвхөн хэмжээ, хөдөлгүүр, хуудас, хугацаа, олдсон талбарын тоо.
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  OCR_DOC_TYPE_INFO,
  OcrDocumentService,
  type DocTypeInfo,
  type DocumentExtraction,
  type OcrDocType,
  type OcrProvider,
} from '@los/ocr';
import { ConcurrencyGate } from './concurrency-gate';
import type { OcrHttpConfig } from './ocr.config';
import { OCR_CLOCK, OCR_CONFIG, OCR_PROVIDER } from './ocr.tokens';

export interface ExtractCommand {
  content: Buffer;
  /** Файлын агуулгаас (magic bytes) тодорхойлсон MIME — клиентийн толгой БИШ */
  mimeType: string;
  fileName?: string;
  docType: OcrDocType | 'AUTO';
  includeText: boolean;
  correlationId?: string;
}

export interface ExtractResponse {
  docType: DocumentExtraction['docType'];
  detectedDocType: DocumentExtraction['detectedDocType'];
  fields: DocumentExtraction['fields'];
  warnings: string[];
  ocr: { engine: string; meanConfidence: number; pageCount: number; durationMs: number; text?: string };
}

export interface HealthResponse {
  ok: boolean;
  provider: string;
  detail?: string;
}

@Injectable()
export class OcrService {
  private readonly logger = new Logger('OcrService');
  private readonly documents: OcrDocumentService;
  private readonly gate: ConcurrencyGate;

  constructor(
    @Inject(OCR_PROVIDER) private readonly provider: OcrProvider,
    @Inject(OCR_CONFIG) config: OcrHttpConfig,
    @Inject(OCR_CLOCK) clock: () => Date,
  ) {
    // Улаанбаатарын өдөр (UTC+8) — хугацаа дууссан эсэхийг шалгахад. en-CA = YYYY-MM-DD
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ulaanbaatar', year: 'numeric', month: '2-digit', day: '2-digit' });
    this.documents = new OcrDocumentService(provider, () => ({ today: fmt.format(clock()) }));
    this.gate = new ConcurrencyGate(config.maxConcurrency, config.maxQueue);
  }

  async extract(cmd: ExtractCommand): Promise<ExtractResponse> {
    const started = Date.now();
    const { extraction, ocr } = await this.gate.run(() =>
      this.documents.analyze({ content: cmd.content, mimeType: cmd.mimeType, fileName: cmd.fileName, docType: cmd.docType, includeText: cmd.includeText }),
    );
    const found = Object.values(extraction.fields).filter((f) => f.value !== null && !(Array.isArray(f.value) && f.value.length === 0)).length;
    // PII-гүй JSON лог (CLAUDE.md §3.2(10))
    this.logger.log(
      JSON.stringify({
        event: 'ocr.extract',
        correlationId: cmd.correlationId,
        docType: extraction.docType,
        detectedDocType: extraction.detectedDocType,
        engine: ocr.engine,
        bytes: cmd.content.length,
        pages: ocr.pageCount,
        fieldsFound: found,
        warnings: extraction.warnings.length,
        ocrMs: ocr.durationMs,
        totalMs: Date.now() - started,
      }),
    );
    return { docType: extraction.docType, detectedDocType: extraction.detectedDocType, fields: extraction.fields, warnings: extraction.warnings, ocr };
  }

  docTypes(): { docTypes: Array<DocTypeInfo | { code: 'AUTO'; name: string; fields: readonly string[] }> } {
    return { docTypes: [{ code: 'AUTO', name: 'Автоматаар таних (анхдагч)', fields: [] }, ...OCR_DOC_TYPE_INFO] };
  }

  async health(): Promise<HealthResponse> {
    if (!this.provider.healthCheck) return { ok: true, provider: this.provider.name, detail: 'health check хэрэгжээгүй' };
    try {
      const h = await this.provider.healthCheck();
      return { ok: h.ok, provider: this.provider.name, ...(h.detail ? { detail: h.detail } : {}) };
    } catch {
      return { ok: false, provider: this.provider.name, detail: 'health check амжилтгүй' };
    }
  }
}
