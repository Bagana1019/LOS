// OcrPage[] → OcrResult угсралт (provider бүрт нийтлэг).
import type { OcrPage, OcrResult } from '../types';
import { layoutTextToPages, type MockConfidence } from './mock.layout';

/** Дундаж (6 орон хүртэл — float хуримтлагдсан алдаа гарахгүй: 0.99 × N → 0.99) */
const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1e6) / 1e6);

/** Хуудсуудаас OcrResult угсарна: текст '\n\f'-ээр, meanConfidence = үг тус бүрийн дундаж (үггүй бол 0). */
export function assembleOcrResult(
  pages: readonly OcrPage[],
  meta: { engine: string; engineVersion: string | null; languages: readonly string[]; durationMs: number; warnings?: string[] },
): OcrResult {
  const wordConf = pages.flatMap((p) => p.lines.flatMap((l) => l.words.map((w) => w.confidence)));
  const result: OcrResult = {
    engine: meta.engine,
    engineVersion: meta.engineVersion,
    languages: [...meta.languages],
    pages: [...pages],
    text: pages.map((p) => p.text).join('\n\f'),
    meanConfidence: mean(wordConf),
    durationMs: meta.durationMs,
  };
  if (meta.warnings && meta.warnings.length > 0) result.warnings = meta.warnings;
  return result;
}

/**
 * Текстээс шууд OcrResult (mock-ийн хайрцаг зохиолттой): тест болон доод урсгалын (parser/extractor) unit тест ашиглана.
 * '\t' / 2+ зай = баганын цоорхой, '\f' = хуудасны завсар. Итгэл: тоо эсвэл (үг, мөрийн дугаар, хуудас) => 0..1.
 */
export function ocrResultFromText(text: string, confidence: MockConfidence = 0.99, engine = 'mock'): OcrResult {
  return assembleOcrResult(layoutTextToPages(text, confidence), { engine, engineVersion: null, languages: ['mon', 'eng'], durationMs: 0 });
}
