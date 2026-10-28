// OCR үр дүн → StatementText (source 'OCR'). Цэвэр хөрвүүлэлт (ocrResultToPages) + injected OcrProvider-ийг дууддаг нимгэн wrapper.
// Нүд таслах: нэг OcrLine доторх дараалсан үгсийн зай > max(cellGapCharWidths × медиан үсгийн өргөн, cellGapLineHeights × мөрийн өндөр).
// Хүснэгтийн босоо шугам "|" гэж танигдсан бол (зөвхөн босоо зураас үсгээс бүтсэн үг) нүдний хил болгож, текстээс хасна.
import { cleanCellText, joinCells } from './cell-text';
import { OCR_INCOMPLETE_MESSAGE, StatementExtractionError } from './errors';
import type { OcrLine, OcrProvider, OcrResult, OcrWord } from '@los/ocr';
import type { StatementTextLine, StatementTextPage } from '../statement.types';
export { OCR_PROVIDER } from './tokens';
import type { OcrLayoutOptions, OcrTextOptions } from './types';

const RULE_WORD_RE = /^[|¦│┃]+$/;

const codePointLength = (s: string): number => Array.from(s).length;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Нэг OcrLine-ийг нүднүүдэд хуваана. Үгийн хайрцаг байхгүй бол [line.text]. */
export function splitOcrLineCells(line: OcrLine, options: OcrLayoutOptions): string[] {
  const words: OcrWord[] = (line.words ?? []).filter((w) => typeof w.text === 'string' && w.text.trim() !== '');
  if (words.length === 0) {
    const t = cleanCellText(line.text ?? '');
    return t === '' ? [] : [t];
  }
  words.sort((a, b) => a.box.x - b.box.x);
  const content = words.filter((w) => !RULE_WORD_RE.test(w.text.trim()));
  const widths = content.filter((w) => w.box.width > 0).map((w) => w.box.width / codePointLength(w.text.trim()));
  const charWidth = widths.length > 0 ? median(widths) : 0;
  const boxHeight = line.box?.height ?? 0;
  const lineHeight = boxHeight > 0 ? boxHeight : median(content.map((w) => w.box.height).filter((h) => h > 0));
  const threshold = Math.max(options.cellGapCharWidths * charWidth, options.cellGapLineHeights * lineHeight);

  const cells: string[] = [];
  let current: string[] = [];
  let end = Number.NEGATIVE_INFINITY;
  const flush = () => {
    const c = cleanCellText(current.join(' '));
    if (c !== '') cells.push(c);
    current = [];
  };
  for (const w of words) {
    if (RULE_WORD_RE.test(w.text.trim())) {
      flush();
      continue;
    }
    // Геометр огт байхгүй (threshold 0) бол таслахгүй: нэг нүд
    if (current.length > 0 && threshold > 0 && w.box.x - end > threshold) flush();
    current.push(w.text.trim());
    end = Math.max(end, w.box.x + w.box.width);
  }
  flush();
  return cells;
}

/** OcrResult → хуудас/мөр. Хоосон мөрийг алгасна; провайдерын мөрийн дарааллыг (дээрээс доош) хэвээр хадгална.
 *  `y` = мөрийн хайрцгийн дээд ирмэг (px). */
export function ocrResultToPages(result: OcrResult, options: OcrLayoutOptions): StatementTextPage[] {
  return result.pages.map((page) => {
    const lines: StatementTextLine[] = [];
    for (const line of page.lines) {
      const cells = splitOcrLineCells(line, options);
      if (cells.length > 0) lines.push({ text: joinCells(cells), cells, y: line.box?.y });
    }
    return { pageNo: page.pageNo, lines };
  });
}

export interface OcrExtraction {
  pages: StatementTextPage[];
  ocr: { engine: string; meanConfidence: number };
}

/** OcrProvider-ийн алдаанаас аюулгүй шошго (код л; мессеж/текст биш). */
function causeTag(err: unknown): string {
  const e = err as { name?: unknown; code?: unknown } | null;
  const name = typeof e?.name === 'string' ? e.name : 'unknown';
  return typeof e?.code === 'string' ? `${name}:${e.code}` : name;
}

/**
 * `mimeType` нь файлын агуулгаас (file-kind) гарсан каноник MIME; fileName-г provider-т ӨГӨХГҮЙ (PII).
 * Провайдер байхгүй / алдаа / хоосон үр дүн / (rejectOnWarnings үед) дутуу уншсан → OCR_FAILED.
 */
export async function recognizeStatementText(
  provider: OcrProvider | undefined,
  input: { content: Buffer; mimeType: string },
  options: OcrTextOptions,
): Promise<OcrExtraction> {
  if (!provider) throw new StatementExtractionError('OCR_FAILED', { detail: 'OCR_PROVIDER_MISSING' });
  let result: OcrResult;
  try {
    result = await provider.recognize({
      content: input.content,
      mimeType: input.mimeType,
      ...(options.languages ? { languages: options.languages } : {}),
    });
  } catch (err) {
    throw new StatementExtractionError('OCR_FAILED', { detail: causeTag(err) });
  }
  if (options.rejectOnWarnings && result.warnings && result.warnings.length > 0) {
    throw new StatementExtractionError('OCR_FAILED', { message: OCR_INCOMPLETE_MESSAGE, detail: 'OCR_INCOMPLETE' });
  }
  const pages = ocrResultToPages(result, options);
  if (!pages.some((p) => p.lines.length > 0)) throw new StatementExtractionError('OCR_FAILED', { detail: 'EMPTY_TEXT' });
  return { pages, ocr: { engine: result.engine, meanConfidence: result.meanConfidence } };
}
