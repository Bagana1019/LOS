// FR-11.4 Тестэд зориулсан PDF шалгагч: гаралтын bytes-аас контент stream-ийг задлан текст/зураг/матрицыг гаргана (black-box).
// Production-д ашиглагдахгүй. Текстийг шрифтийн ToUnicode CMap-аар буцааж Unicode болгоно (pdftotext-ээс үл хамаарна).
import fontkit from '@pdf-lib/fontkit';
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFString,
  PDFHexString,
  type PDFFont,
  type PDFObject,
  type PDFPage,
  type PDFRef,
} from 'pdf-lib';
import * as QRCode from 'qrcode';
import { loadFontBytes } from './fonts';
import type { QuarterTurn } from './page-frame';

export type Matrix = readonly [number, number, number, number, number, number];
export type Point = readonly [number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** PDF-ийн row-vector convention: (m × n) гэдэг нь эхлээд m, дараа нь n-ийг хэрэглэнэ */
export const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];
export const transformPoint = (m: Matrix, [x, y]: Point): Point => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
export const transformVector = (m: Matrix, [x, y]: Point): Point => [x * m[0] + y * m[2], x * m[1] + y * m[3]];

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * user space → ХАРАГДАХ координат (зүүн доод булан эх). PDF spec-ийн дагуу /Rotate нь хуудсыг цагийн зүүн тийш эргүүлж харуулна —
 * stamper-ийн `toUser`-ийн урвуу биш, спекээс шууд гаргасан тул stamper-ийн алдааг баттай илрүүлнэ.
 */
export function userToVisual(point: Point, visible: Rect, rotation: QuarterTurn): Point {
  const a = point[0] - visible.x;
  const b = point[1] - visible.y;
  switch (rotation) {
    case 0:
      return [a, b];
    case 90:
      return [b, visible.width - a];
    case 180:
      return [visible.width - a, visible.height - b];
    case 270:
      return [visible.height - b, a];
  }
}
export function userToVisualVector([dx, dy]: Point, rotation: QuarterTurn): Point {
  switch (rotation) {
    case 0:
      return [dx, dy];
    case 90:
      return [dy, -dx];
    case 180:
      return [-dx, -dy];
    case 270:
      return [-dy, dx];
  }
}
export const visualSize = (visible: Rect, rotation: QuarterTurn): { width: number; height: number } =>
  rotation === 90 || rotation === 270 ? { width: visible.height, height: visible.width } : { width: visible.width, height: visible.height };

// ---- Контент stream ----

function lookupRawStream(doc: PDFDocument, reference: PDFObject): PDFRawStream {
  const stream = doc.context.lookup(reference);
  if (!(stream instanceof PDFRawStream)) throw new Error('object is not a stream of a loaded document');
  return stream;
}

const rawBytes = (doc: PDFDocument, reference: PDFObject): Uint8Array => decodePDFRawStream(lookupRawStream(doc, reference)).decode();

/** Хуудасны бүх контент stream-ийг (decode хийж) нэг мөр болгон — latin1 (bytes алдагдахгүй) */
export function pageContentStreams(doc: PDFDocument, page: PDFPage): string[] {
  const contents = page.node.Contents();
  if (!contents) return [];
  const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
  return refs.map((ref) => Buffer.from(rawBytes(doc, ref)).toString('latin1'));
}

const TOKEN = /<[0-9A-Fa-f\s]*>|\/[^\s/<>[\]()]+|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|[A-Za-z*'"]+/g;

export interface DrawnImage {
  name: string;
  /** Нэгж квадрат → user space */
  matrix: Matrix;
}
export interface DrawnText {
  fontName: string;
  size: number;
  /** `<…>` дотрох hex (Identity-H, 2 байт/glyph) */
  hex: string;
  /** Текстийн space → user space (Tm × CTM) */
  matrix: Matrix;
}
export interface PageOperations {
  images: DrawnImage[];
  texts: DrawnText[];
  graphicsStates: string[];
}

/** pdf-lib-ийн үүсгэдэг q/Q/cm/BT/Tf/Tm/Tj/Do/gs үйлдлүүдийг л ойлгоно (бусдыг алгасна) */
export function interpretContent(content: string): PageOperations {
  const result: PageOperations = { images: [], texts: [], graphicsStates: [] };
  const stack: Matrix[] = [];
  let ctm = IDENTITY;
  let tm = IDENTITY;
  let fontName = '';
  let fontSize = 0;
  let operands: string[] = [];
  const numbers = (): number[] => operands.map(Number);
  for (const token of content.match(TOKEN) ?? []) {
    if (!/^[A-Za-z*'"]+$/.test(token)) {
      operands.push(token);
      continue;
    }
    switch (token) {
      case 'q':
        stack.push(ctm);
        break;
      case 'Q':
        ctm = stack.pop() ?? ctm;
        break;
      case 'cm':
        ctm = multiply(numbers() as unknown as Matrix, ctm);
        break;
      case 'BT':
        tm = IDENTITY;
        break;
      case 'Tm':
        tm = numbers() as unknown as Matrix;
        break;
      case 'Tf':
        fontName = operands[0].slice(1);
        fontSize = Number(operands[1]);
        break;
      case 'Tj':
        result.texts.push({ fontName, size: fontSize, hex: operands[0].slice(1, -1).replace(/\s/g, ''), matrix: multiply(tm, ctm) });
        break;
      case 'Do':
        result.images.push({ name: operands[0].slice(1), matrix: ctm });
        break;
      case 'gs':
        result.graphicsStates.push(operands[0].slice(1));
        break;
    }
    operands = [];
  }
  return result;
}

export function pageOperations(doc: PDFDocument, page: PDFPage): PageOperations {
  return interpretContent(pageContentStreams(doc, page).join('\n'));
}

// ---- Текст ----

function parseToUnicode(cmap: string): Map<number, string> {
  const map = new Map<number, string>();
  const decodeUtf16 = (hex: string): string => String.fromCharCode(...(hex.match(/.{4}/g) ?? []).map((unit) => parseInt(unit, 16)));
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const [, from, to] of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) map.set(parseInt(from, 16), decodeUtf16(to));
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const [, lo, hi, to] of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      for (let code = parseInt(lo, 16); code <= parseInt(hi, 16); code++) map.set(code, decodeUtf16((parseInt(to, 16) + code - parseInt(lo, 16)).toString(16).padStart(4, '0')));
    }
  }
  return map;
}

interface FontInfo {
  baseFont: string;
  toUnicode: Map<number, string>;
}

function pageFonts(doc: PDFDocument, page: PDFPage): Map<string, FontInfo> {
  const fonts = new Map<string, FontInfo>();
  const dict = page.node.Resources()?.lookupMaybe(PDFName.of('Font'), PDFDict);
  if (!dict) return fonts;
  for (const [name, ref] of dict.entries()) {
    const font = doc.context.lookup(ref, PDFDict);
    const toUnicode = font.get(PDFName.of('ToUnicode'));
    if (!toUnicode) continue;
    const baseFont = (font.get(PDFName.of('BaseFont')) as PDFName).decodeText();
    fonts.set(name.decodeText(), { baseFont, toUnicode: parseToUnicode(Buffer.from(rawBytes(doc, toUnicode)).toString('latin1')) });
  }
  return fonts;
}

export interface TextRun {
  text: string;
  size: number;
  /** Шрифтийн BaseFont нэр (жишээ `LOSDMS+DejaVuSans-Bold`) */
  baseFont: string;
  /** Baseline-ийн эхлэл, user space */
  origin: Point;
  /** Baseline-ийн чиглэл (нэгж вектор), user space */
  direction: Point;
}

export function extractTextRuns(doc: PDFDocument, page: PDFPage): TextRun[] {
  const fonts = pageFonts(doc, page);
  return pageOperations(doc, page).texts.map((drawn) => {
    const font = fonts.get(drawn.fontName);
    if (!font) throw new Error(`no ToUnicode map for font ${drawn.fontName}`);
    const text = (drawn.hex.match(/.{4}/g) ?? []).map((code) => font.toUnicode.get(parseInt(code, 16)) ?? '\uFFFD').join('');
    const [dx, dy] = transformVector(drawn.matrix, [1, 0]);
    const scale = Math.hypot(dx, dy);
    return { text, size: drawn.size * scale, baseFont: font.baseFont, origin: transformPoint(drawn.matrix, [0, 0]), direction: [dx / scale, dy / scale] };
  });
}

export const pageText = (doc: PDFDocument, page: PDFPage): string[] => extractTextRuns(doc, page).map((run) => run.text);

// ---- Зураг / QR ----

export interface PageImage {
  ref: PDFRef;
  width: number;
  height: number;
  matrix: Matrix;
  /** DeviceRGB, 8 bit; хэмжээ = width*height*3 */
  pixels: Uint8Array;
}

export function extractImages(doc: PDFDocument, page: PDFPage): PageImage[] {
  const xobjects = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  return pageOperations(doc, page).images.map((drawn) => {
    const ref = xobjects?.get(PDFName.of(drawn.name)) as PDFRef | undefined;
    if (!ref) throw new Error(`XObject ${drawn.name} is not in page resources`);
    const stream = lookupRawStream(doc, ref);
    const number = (key: string): number => stream.dict.lookup(PDFName.of(key), PDFNumber).asNumber();
    return { ref, width: number('Width'), height: number('Height'), matrix: drawn.matrix, pixels: rawBytes(doc, stream) };
  });
}

/** Зургаас QR модулийн матрицыг сэргээнэ (хар = true): харанхуй пикселийн хүрээнээс модулийн хэмжээ/хүрээг тодорхойлно. */
export function readQrMatrix(image: PageImage): boolean[][] {
  const dark = (x: number, y: number): boolean => image.pixels[(y * image.width + x) * 3] < 128;
  let [minX, minY, maxX, maxY] = [image.width, image.height, -1, -1];
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (!dark(x, y)) continue;
      [minX, minY, maxX, maxY] = [Math.min(minX, x), Math.min(minY, y), Math.max(maxX, x), Math.max(maxY, y)];
    }
  }
  const side = maxX - minX + 1;
  if (side !== maxY - minY + 1) throw new Error('QR image is not square');
  // Хамгийн жижиг QR (21 модуль)-оос эхлэн модулийн тоог 4-өөр нэмэгдүүлж, пикселийн хэмжээг бүхэл тоогоор хуваагдахыг шалгана
  for (let modules = 21; modules <= 177; modules += 4) {
    if (side % modules !== 0) continue;
    const scale = side / modules;
    return Array.from({ length: modules }, (_, row) => Array.from({ length: modules }, (_, col) => dark(minX + col * scale + (scale >> 1), minY + row * scale + (scale >> 1))));
  }
  throw new Error('cannot infer QR module size');
}

export function expectedQrMatrix(url: string): boolean[][] {
  const { modules } = QRCode.create(url, { errorCorrectionLevel: 'M' });
  return Array.from({ length: modules.size }, (_, row) => Array.from({ length: modules.size }, (_, col) => modules.get(row, col) === 1));
}

// ---- Metadata / хавсралт ----

export interface Attachment {
  name: string;
  mimeType: string | undefined;
  bytes: Buffer;
}

export function readAttachments(doc: PDFDocument): Attachment[] {
  const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict)?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict)?.lookupMaybe(PDFName.of('Names'), PDFArray);
  if (!names) return [];
  const attachments: Attachment[] = [];
  for (let i = 0; i < names.size(); i += 2) {
    const name = names.lookup(i, PDFString, PDFHexString).decodeText();
    const spec = names.lookup(i + 1, PDFDict);
    const stream = lookupRawStream(doc, spec.lookup(PDFName.of('EF'), PDFDict).get(PDFName.of('F')) as PDFObject);
    const subtype = (stream.dict.get(PDFName.of('Subtype')) as PDFName | undefined)?.decodeText();
    attachments.push({ name, mimeType: subtype?.replace('#2F', '/'), bytes: Buffer.from(decodePDFRawStream(stream).decode()) });
  }
  return attachments;
}

// ---- Хэмжүүр ----

/** Тестэд текстийн өргөнийг хэмжих DejaVu шрифтүүд (түр PDFDocument-д embed хийсэн) */
export async function loadMeasureFonts(): Promise<{ regular: PDFFont; bold: PDFFont }> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  return {
    regular: await doc.embedFont(await loadFontBytes('regular')),
    bold: await doc.embedFont(await loadFontBytes('bold')),
  };
}
