// OcrDocumentService — provider + extractor-ийг нэгтгэнэ (DMS-ийн REST модуль ашиглана). Баримтын текстийг ЛОГЛОХГҮЙ.
import { extractDocument } from './extract/extract-document';
import type { DocumentExtraction, ExtractOptions, OcrDocType } from './extract/types';
import { OcrError, type OcrProvider } from './types';

export interface AnalyzeInput {
  content: Buffer;
  mimeType: string;
  fileName?: string;
  /** Анхдагч 'AUTO' */
  docType?: OcrDocType | 'AUTO';
  /** Зөвхөн дебаг: OCR-ийн бүтэн текстийг хариунд оруулна (PII!). Анхдагч false */
  includeText?: boolean;
  languages?: string[];
  timeoutMs?: number;
}

export interface AnalyzeResult {
  extraction: DocumentExtraction;
  ocr: {
    engine: string;
    meanConfidence: number;
    pageCount: number;
    durationMs: number;
    /** includeText=true үед л */
    text?: string;
  };
}

export class OcrDocumentService {
  /** @param extractOptions задлалтын сонголтыг дуудлага бүрт өгөх функц (жишээ нь `() => ({ today })`; цагийг package дотроос уншихгүй) */
  constructor(
    private readonly provider: OcrProvider,
    private readonly extractOptions: () => ExtractOptions = () => ({}),
  ) {}

  async analyze(input: AnalyzeInput): Promise<AnalyzeResult> {
    if (!input || !Buffer.isBuffer(input.content)) throw new OcrError('INVALID_INPUT', 'OCR оролт буруу');
    const ocr = await this.provider.recognize({
      content: input.content,
      mimeType: input.mimeType,
      fileName: input.fileName,
      languages: input.languages,
      timeoutMs: input.timeoutMs,
    });
    const extraction = extractDocument(ocr, input.docType ?? 'AUTO', this.extractOptions());
    return {
      extraction,
      ocr: {
        engine: ocr.engine,
        meanConfidence: ocr.meanConfidence,
        pageCount: ocr.pages.length,
        durationMs: ocr.durationMs,
        ...(input.includeText ? { text: ocr.text } : {}),
      },
    };
  }
}
