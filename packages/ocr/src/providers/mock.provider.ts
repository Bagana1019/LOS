// MockOcrProvider — CLAUDE.md §3.2(7): deterministic fixture буцаана (сүлжээ, цаг, санамсаргүй утга байхгүй).
// Fixture сонгох дараалал: (1) агуулгын sha256 → (2) бүртгэсэн файлын нэрний pattern → (3) mimeType 'text/plain' passthrough
// (агуулга өөрөө текст) → (4) built-in fixture (файлын нэрний хэсэг: id-card | salary | statement) → (5) OcrError('NO_FIXTURE').
// (3) нь (4)-өөс өмнө: тестийн текст тодорхой өгөгдсөн бол файлын нэрээр дарагдахгүй.
import { createHash } from 'node:crypto';
import { OCR_DEFAULTS } from '../defaults';
import { normalizeOcrMime } from '../mime';
import { OcrError, type OcrInput, type OcrProvider, type OcrResult } from '../types';
import { validateLanguages } from './languages';
import { layoutTextToPages, type MockConfidence, type MockLayoutOptions } from './mock.layout';
import { assembleOcrResult } from './result';
import { MOCK_BUILTIN_FIXTURES } from './mock.fixtures';

export interface MockOcrProviderOptions {
  /** sha256 (hex) → fixture текст */
  bySha256?: Record<string, string>;
  /** Файлын нэрийн pattern (string = жижиг үсгээр орсон эсэх; RegExp = test) → fixture текст. Бүртгэсэн дарааллаар. */
  byFileName?: ReadonlyArray<{ pattern: string | RegExp; text: string }>;
  /** built-in fixture (id-card, salary, statement) ашиглах эсэх. Анхдагч true */
  builtins?: boolean;
  confidence?: MockConfidence;
  layout?: Partial<MockLayoutOptions>;
  maxInputBytes?: number;
}

export const MOCK_ENGINE_NAME = 'mock';
export const MOCK_ENGINE_VERSION = 'mock-1';

export class MockOcrProvider implements OcrProvider {
  readonly name = MOCK_ENGINE_NAME;
  private readonly bySha256 = new Map<string, string>();
  private readonly byFileName: Array<{ pattern: string | RegExp; text: string }> = [];
  private readonly useBuiltins: boolean;
  private readonly confidence: MockConfidence;
  private readonly layout: Partial<MockLayoutOptions>;
  private readonly maxInputBytes: number;

  constructor(options: MockOcrProviderOptions = {}) {
    for (const [hash, text] of Object.entries(options.bySha256 ?? {})) this.registerSha256(hash, text);
    for (const f of options.byFileName ?? []) this.registerFileName(f.pattern, f.text);
    this.useBuiltins = options.builtins ?? true;
    this.confidence = options.confidence ?? OCR_DEFAULTS.mockConfidence;
    this.layout = options.layout ?? {};
    this.maxInputBytes = options.maxInputBytes ?? OCR_DEFAULTS.maxInputBytes;
  }

  /** Тодорхой агуулгад (sha256 hex) тодорхой текст оноох. */
  registerSha256(sha256: string, text: string): this {
    this.bySha256.set(sha256.toLowerCase(), text);
    return this;
  }

  /** Файлын нэр pattern-д таарвал тодорхой текст буцаах. */
  registerFileName(pattern: string | RegExp, text: string): this {
    this.byFileName.push({ pattern, text });
    return this;
  }

  async recognize(input: OcrInput): Promise<OcrResult> {
    if (!input || !Buffer.isBuffer(input.content) || input.content.length === 0) throw new OcrError('INVALID_INPUT', 'OCR оролт хоосон байна');
    if (input.content.length > this.maxInputBytes) throw new OcrError('INVALID_INPUT', 'OCR оролтын файл хэт том байна');
    const languages = validateLanguages(input.languages ?? OCR_DEFAULTS.languages);
    const textPlain = /^text\/plain\b/i.test(input.mimeType ?? '');
    if (!textPlain && !normalizeOcrMime(input.mimeType)) throw new OcrError('UNSUPPORTED_MIME', 'Дэмжигдээгүй файлын төрөл');

    const text = this.findFixture(input, textPlain);
    if (text === null) throw new OcrError('NO_FIXTURE', 'Mock OCR-д энэ файлд тохирох fixture бүртгэгдээгүй байна');
    const pages = layoutTextToPages(text, this.confidence, this.layout);
    if (pages.every((p) => p.lines.length === 0)) throw new OcrError('EMPTY_RESULT', 'OCR текст олдсонгүй');
    return assembleOcrResult(pages, { engine: this.name, engineVersion: MOCK_ENGINE_VERSION, languages, durationMs: 0 });
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: 'mock OCR (deterministic fixtures)' };
  }

  private findFixture(input: OcrInput, textPlain: boolean): string | null {
    const hash = createHash('sha256').update(input.content).digest('hex');
    const byHash = this.bySha256.get(hash);
    if (byHash !== undefined) return byHash;

    const fileName = input.fileName ?? '';
    for (const f of this.byFileName) {
      if (typeof f.pattern !== 'string') f.pattern.lastIndex = 0; // /g эсвэл /y RegExp төлөвгүй байх
      const hit = typeof f.pattern === 'string' ? fileName.toLowerCase().includes(f.pattern.toLowerCase()) : f.pattern.test(fileName);
      if (hit) return f.text;
    }
    if (textPlain) return input.content.toString('utf8').replace(/^\uFEFF/, '');
    if (this.useBuiltins) {
      const normalized = fileName.toLowerCase().replace(/[\s_]+/g, '-');
      const builtin = MOCK_BUILTIN_FIXTURES.find((f) => normalized.includes(f.key));
      if (builtin) return builtin.text;
    }
    return null;
  }
}
