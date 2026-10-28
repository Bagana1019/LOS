// PDF text layer → StatementText (source 'PDF_TEXT'), BSA-FR-2.1/2.3. pdfjs-dist (legacy build) — програм CommonJS-ээр компайл хийгддэг тул
// ESM-г динамик import() хийнэ. eval, системийн фонт, фонт ачаалах, сүлжээ унтраалттай; worker нь Node-д fake worker (үндсэн thread).
//  - Бүх хуудсыг дарааллаар нь уншина; хуудасны дээд тоо/хэмжээ хэтэрвэл TOO_LARGE (гүйлгээ чимээгүй алдагдахаас сэргийлнэ)
//  - Мөр/нүд сэргээх: pdf-layout.ts. Metadata: pdf-metadata.ts
//  - Text layer-гүй (скан) PDF → PDF_NO_TEXT_LAYER, эсвэл ocrFallback өгөгдсөн бол OCR (source 'OCR'; meta.pdf хэвээр)
import { isStatementExtractionError, StatementExtractionError, tooLargeBytesMessage, tooManyPagesMessage } from './errors';
import { layoutPdfItems, type PdfTextItem } from './pdf-layout';
import { parsePdfDate, pdfInfoString } from './pdf-metadata';
import type { PdfMetadata, StatementTextPage } from '../statement.types';
import type { ExtractedText, PdfTextOptions } from './types';

// ---- pdfjs-ийн ашиглах гадаргуу (бүтцийн төрөл: pdfjs-ийн төрлийн хамаарлыг хязгаарлаж, fake-аар тестлэх боломж) ----
interface PdfJsViewport {
  transform: number[];
}
interface PdfJsPage {
  getViewport(params: { scale: number }): PdfJsViewport;
  getTextContent(): Promise<{ items: unknown[] }>;
  cleanup(): boolean | void;
}
interface PdfJsDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfJsPage>;
  getMetadata(): Promise<{ info?: Record<string, unknown> }>;
  getFieldObjects(): Promise<Record<string, Array<{ type?: string }>> | null>;
}
interface PdfJsLoadingTask {
  promise: Promise<PdfJsDocument>;
  destroy(): Promise<void>;
}
export interface PdfJsModule {
  getDocument(src: Record<string, unknown>): PdfJsLoadingTask;
}

let pdfJsPromise: Promise<PdfJsModule> | null = null;

/** pdfjs-ийг нэг л удаа ачаална (бүтэлгүйтвэл дараагийн дуудлагад дахин оролдоно). */
export function loadPdfJs(): Promise<PdfJsModule> {
  if (!pdfJsPromise) {
    pdfJsPromise = (import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as Promise<PdfJsModule>).catch((err: unknown) => {
      pdfJsPromise = null;
      throw err;
    });
  }
  return pdfJsPromise;
}

/** PDF-ийн нээлтийн тохиргоо: бүх гадаад хандалт (eval, фонт, сүлжээ, stream/range) унтраалттай. */
const PDFJS_LOAD_OPTIONS = {
  isEvalSupported: false,
  useSystemFonts: false,
  disableFontFace: true,
  useWorkerFetch: false,
  disableRange: true,
  disableStream: true,
  disableAutoFetch: true,
  enableXfa: false,
  isOffscreenCanvasSupported: false,
  verbosity: 0, // зөвхөн алдаа (pdfjs-ийн VerbosityLevel.ERRORS)
} as const;

/** Item-ийн чиглэл давамгайлсан чиглэлээс энэ өнцгөөс (радиан) хэтрэхгүй бол "хэвтээ" (≈ 5.7°) */
const UPRIGHT_MAX_ANGLE = Math.atan(0.1);
/** Давамгайлсан чиглэлийг олох өнцгийн сав (градус) */
const ANGLE_BIN_DEGREES = 1;

export interface PdfRead {
  pages: StatementTextPage[];
  pdf: PdfMetadata;
  /** Хуудас тутмын дундаж хоосон бус тэмдэгт ≥ minAvgCharsPerPage */
  hasTextLayer: boolean;
}

const multiply = (a: readonly number[], b: readonly number[]): number[] => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];

interface RawTextItem {
  str: string;
  transform: number[];
  width: number;
}
const isTextItem = (o: unknown): o is RawTextItem => {
  const r = o as Partial<RawTextItem> | null;
  return !!r && typeof r.str === 'string' && Array.isArray(r.transform) && r.transform.length >= 6 && typeof r.width === 'number';
};

/**
 * pdfjs item → хуудасны харагдах (page /Rotate-тай) координат, дараа нь ДАВАМГАЙЛСАН унших чиглэлд тохируулсан (u, v) хүрээ рүү эргүүлнэ:
 * контент нь хуудсанд тэгш бус (босоо/налуу сканы text layer) байсан ч мөр хэвтээ болно. Давамгайлсан чиглэлээс зөрсөн жижиг
 * хэсэг (усан тэмдэг) upright=false болно. Ердийн хуудсанд u = x, v = y (дээрээс доош).
 */
function toLayoutItems(items: readonly unknown[], viewportTransform: readonly number[]): PdfTextItem[] {
  const placed: Array<{ raw: RawTextItem; m: number[]; angle: number }> = [];
  for (const raw of items) {
    if (!isTextItem(raw) || raw.str.trim() === '') continue; // marked-content зэрэг str-гүй, хоосон зүйл
    const m = multiply(viewportTransform, raw.transform);
    if (!m.every(Number.isFinite) || Math.hypot(m[0], m[1]) === 0) continue; // харагдахгүй (масштаб 0) текст
    placed.push({ raw, m, angle: Math.atan2(m[1], m[0]) });
  }
  const angle = dominantAngle(placed.map((p) => ({ angle: p.angle, weight: p.raw.str.trim().length })));
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  return placed.map(({ raw, m }) => ({
    str: raw.str,
    x: m[4] * dx + m[5] * dy,
    y: -m[4] * dy + m[5] * dx,
    width: raw.width,
    height: Math.hypot(m[2], m[3]),
    upright: (m[0] * dx + m[1] * dy) / Math.hypot(m[0], m[1]) >= Math.cos(UPRIGHT_MAX_ANGLE),
  }));
}

/** Тэмдэгтийн тоогоор жинлэсэн хамгийн олон item-тэй чиглэл (радиан). Item байхгүй бол 0. */
function dominantAngle(entries: ReadonlyArray<{ angle: number; weight: number }>): number {
  if (entries.length === 0) return 0;
  const bins = new Map<number, number>();
  for (const e of entries) {
    const bin = Math.round((e.angle * 180) / Math.PI / ANGLE_BIN_DEGREES);
    bins.set(bin, (bins.get(bin) ?? 0) + e.weight);
  }
  const [best] = [...bins.entries()].reduce((a, b) => (b[1] > a[1] ? b : a));
  const center = (best * ANGLE_BIN_DEGREES * Math.PI) / 180;
  // давамгайлсан савны ойролцоох item-үүдийн жинлэсэн дундаж (бага зэргийн ташуу сканд нарийвчлал өгнө)
  let sum = 0;
  let weights = 0;
  for (const e of entries) {
    const diff = Math.atan2(Math.sin(e.angle - center), Math.cos(e.angle - center));
    if (Math.abs(diff) <= (2 * ANGLE_BIN_DEGREES * Math.PI) / 180) {
      sum += diff * e.weight;
      weights += e.weight;
    }
  }
  return center + (weights > 0 ? sum / weights : 0);
}

function failure(err: unknown): StatementExtractionError {
  if (isStatementExtractionError(err)) return err;
  const name = err instanceof Error ? err.name : 'unknown';
  return new StatementExtractionError(name === 'PasswordException' ? 'PDF_ENCRYPTED' : 'PDF_CORRUPT', { detail: name });
}

async function readMetadata(doc: PdfJsDocument): Promise<PdfMetadata> {
  let info: Record<string, unknown> = {};
  try {
    info = (await doc.getMetadata()).info ?? {};
  } catch {
    // metadata уншигдахгүй байсан ч текст уншина — бүх талбар null
  }
  let signatureField = false;
  try {
    signatureField = Object.values((await doc.getFieldObjects()) ?? {}).some((f) => f.some((x) => x.type === 'signature'));
  } catch {
    // AcroForm эвдэрсэн — гарын үсэг тодорхойгүй
  }
  return {
    producer: pdfInfoString(info.Producer),
    creator: pdfInfoString(info.Creator),
    title: pdfInfoString(info.Title),
    author: pdfInfoString(info.Author),
    creationDate: parsePdfDate(info.CreationDate),
    modDate: parsePdfDate(info.ModDate),
    pageCount: doc.numPages,
    // Нууц үггүй нээгдсэн ч (зөвхөн owner password) шифрлэгдсэн гэж тэмдэглэнэ
    isEncrypted: typeof info.EncryptFilterName === 'string' && info.EncryptFilterName !== '',
    // Гарын үсгийн талбар (хоосон ч байж болно) эсвэл AcroForm SigFlags. Криптограф шалгалт хийгдэхгүй — TODO(authenticity)
    hasSignature: info.IsSignaturesPresent === true || signatureField,
  };
}

/** PDF-ийг нээж, бүх хуудасны мөр/нүд болон metadata-г уншина. Шифрлэгдсэн → PDF_ENCRYPTED, эвдэрсэн → PDF_CORRUPT. */
export async function readPdf(content: Buffer, options: PdfTextOptions): Promise<PdfRead> {
  if (content.length > options.maxBytes) throw new StatementExtractionError('TOO_LARGE', { message: tooLargeBytesMessage(options.maxBytes) });
  const pdfjs = await loadPdfJs();
  // pdfjs өгөгдлийг өөрийн болгож авдаг тул хуулбарлана (дуудагчийн буфер, sha256, OCR fallback хэвээр үлдэнэ)
  const task = pdfjs.getDocument({ ...PDFJS_LOAD_OPTIONS, data: new Uint8Array(content) });
  try {
    let doc: PdfJsDocument;
    try {
      doc = await task.promise;
    } catch (err) {
      throw failure(err);
    }
    if (!(doc.numPages >= 1)) throw new StatementExtractionError('PDF_CORRUPT', { detail: 'NoPages' });
    if (doc.numPages > options.maxPages) throw new StatementExtractionError('TOO_LARGE', { message: tooManyPagesMessage(options.maxPages) });

    const pages: StatementTextPage[] = [];
    let chars = 0;
    for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
      try {
        const page = await doc.getPage(pageNo);
        const items = toLayoutItems((await page.getTextContent()).items, page.getViewport({ scale: 1 }).transform);
        const lines = layoutPdfItems(items, options);
        page.cleanup();
        chars += lines.reduce((n, l) => n + l.text.replace(/\s/g, '').length, 0);
        pages.push({ pageNo, lines });
      } catch (err) {
        throw failure(err);
      }
    }
    return { pages, pdf: await readMetadata(doc), hasTextLayer: chars / pages.length >= options.minAvgCharsPerPage };
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

/** Скан PDF-ийг OCR-ээр уншдаг функц (service өгнө) */
export type PdfOcrFallback = (content: Buffer) => Promise<{ pages: StatementTextPage[]; ocr: { engine: string; meanConfidence: number } }>;

export async function extractPdfText(content: Buffer, options: PdfTextOptions, ocrFallback?: PdfOcrFallback): Promise<ExtractedText> {
  const read = await readPdf(content, options);
  if (read.hasTextLayer) return { source: 'PDF_TEXT', pages: read.pages, pdf: read.pdf };
  if (!ocrFallback) throw new StatementExtractionError('PDF_NO_TEXT_LAYER');
  const ocr = await ocrFallback(content);
  return { source: 'OCR', pages: ocr.pages, pdf: read.pdf, ocr: ocr.ocr };
}
