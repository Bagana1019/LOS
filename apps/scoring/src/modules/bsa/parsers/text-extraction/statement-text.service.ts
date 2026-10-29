// StatementTextService: хуулгын файл (PDF | зураг | CSV | текст) → StatementText. BSA-FR-2.1, 2.3. Parser зөвхөн энэ гаралтыг уншина.
// Диспатч: file-kind.ts (бит-ээр) → extractor. Файлын агуулга, нэр, OCR текстийг ЛОГЛОХГҮЙ (PII); алдаа нь StatementExtractionError.
import { createHash } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { OcrProvider } from '@los/ocr';
import { extractCsvText } from './csv-text.extractor';
import { STATEMENT_EXTRACTION_MESSAGES, StatementExtractionError, tooLargeBytesMessage, XLSX_UNSUPPORTED_MESSAGE } from './errors';
import { inspectFile, type FileKind } from './file-kind';
import { recognizeStatementText } from './ocr-text.extractor';
import { extractPdfText } from './pdf-text.extractor';
import { extractPlainText } from './plain-text.extractor';
import { resolveTextExtractionOptions } from './text-extraction.defaults';
import { OCR_PROVIDER, TEXT_EXTRACTION_OPTIONS } from './tokens';
import type { StatementFileMeta, StatementText } from '../statement.types';
import type { ExtractedText, ExtractInput, TextExtractionOptions, TextExtractionOptionsInput } from './types';

const MAX_FILE_NAME_LENGTH = 255;

/** Клиентийн файлын нэр: зам хасч, удирдлагын тэмдэгт устгаж, уртыг хязгаарлана (нэр өөрөө PII байж болно — зөвхөн meta-д, логт биш). */
function safeFileName(raw: unknown): string {
  const base = typeof raw === 'string' ? raw.split(/[\\/]/).pop() ?? '' : '';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_FILE_NAME_LENGTH);
  return clean === '' ? 'unnamed' : clean;
}

@Injectable()
export class StatementTextService {
  private readonly options: TextExtractionOptions;

  constructor(
    @Optional() @Inject(OCR_PROVIDER) private readonly ocr?: OcrProvider,
    @Optional() @Inject(TEXT_EXTRACTION_OPTIONS) options?: TextExtractionOptionsInput,
  ) {
    this.options = resolveTextExtractionOptions(options);
    // Тохиргооны алдаа эхлэхэд л унана: OCR fallback асаалттай ч provider байхгүй
    if (this.options.ocrFallback && !ocr) throw new Error('text-extraction: ocrFallback=true үед OCR_PROVIDER заавал хэрэгтэй');
  }

  async extract(input: ExtractInput): Promise<StatementText> {
    const { content } = input;
    if (!Buffer.isBuffer(content)) throw new StatementExtractionError('UNSUPPORTED_FILE', { detail: 'NotBuffer' });
    if (content.length === 0) throw new StatementExtractionError('EMPTY');
    if (content.length > this.options.maxBytes) {
      throw new StatementExtractionError('TOO_LARGE', { message: tooLargeBytesMessage(this.options.maxBytes) });
    }

    const { kind, mimeType } = inspectFile(input);
    const extracted = await this.extractByKind(kind, content, mimeType);
    const meta: StatementFileMeta = {
      fileName: safeFileName(input.fileName),
      mimeType,
      sizeBytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
      ...(extracted.pdf ? { pdf: extracted.pdf } : {}),
      ...(extracted.ocr ? { ocr: extracted.ocr } : {}),
    };
    return { source: extracted.source, pages: extracted.pages, meta };
  }

  private async extractByKind(kind: FileKind, content: Buffer, mimeType: string): Promise<ExtractedText> {
    const o = this.options;
    switch (kind) {
      case 'PDF':
        return extractPdfText(
          content,
          o.pdf,
          o.ocrFallback ? (pdf) => recognizeStatementText(this.ocr, { content: pdf, mimeType: 'application/pdf' }, o.ocr) : undefined,
        );
      case 'IMAGE': {
        const r = await recognizeStatementText(this.ocr, { content, mimeType }, o.ocr);
        return { source: 'OCR', pages: r.pages, ocr: r.ocr };
      }
      case 'CSV': {
        const { lines } = extractCsvText(content, o.csv);
        if (lines.length === 0) throw new StatementExtractionError('EMPTY');
        return { source: 'CSV', pages: [{ pageNo: 1, lines }] };
      }
      case 'TEXT': {
        const pages = extractPlainText(content, o.csv);
        if (pages.length === 0) throw new StatementExtractionError('EMPTY');
        return { source: 'TEXT', pages };
      }
      case 'XLSX':
        // TODO(xlsx): Excel унших баталгаатай сан (vetted library) сонгогдтол CSV/PDF экспорт шаардана
        throw new StatementExtractionError('UNSUPPORTED_FILE', { message: XLSX_UNSUPPORTED_MESSAGE, detail: 'XLSX' });
      default:
        throw new StatementExtractionError('UNSUPPORTED_FILE', { message: STATEMENT_EXTRACTION_MESSAGES.UNSUPPORTED_FILE });
    }
  }
}
