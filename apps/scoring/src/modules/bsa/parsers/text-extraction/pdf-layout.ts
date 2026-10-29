// PDF text item-үүдээс хүснэгтийн мөр, нүд сэргээх ЦЭВЭР функц (pdfjs-ээс хамааралгүй → unit тест хийхэд амар).
//  1) Мөр: baseline y-ээр бүлэглэнэ, хүлцэл = lineToleranceRatio × үсгийн өндөр
//  2) Нүд: мөр доторх item-үүдийг x-ээр эрэмбэлж, хоорондын зай > cellGapRatio × өндөр бол шинэ нүд;
//     зай ≤ wordGapRatio × өндөр бол залгана; завсрын зайд нэг зай оруулна
//  3) Item доторх ≥ 2 зайн дарааллыг (моноширин текст нэг Tj-д) өөрийн геометрээр нэмэлт item болгож тасална
//  4) Босоо/налуу текст (усан тэмдэг, захын тэмдэглэл) хэвтээ мөрөнд ХОЛИХГҮЙ — тус бүр тусдаа мөр болж хуудасны төгсгөлд
//  5) Давхар зурсан (хуурамч bold) ижил item-ийн нэгийг л үлдээнэ. Өөр юу ч хасахгүй.
import { cleanCellText, joinCells } from './cell-text';
import type { StatementTextLine } from '../statement.types';
import type { PdfLayoutOptions } from './types';

export interface PdfTextItem {
  str: string;
  /** Эхлэх x (унших чиглэлд, зүүнээс баруун) */
  x: number;
  /** Baseline y (унших чиглэлд дээрээс доош өсөх) */
  y: number;
  /** Item-ийн өргөн */
  width: number;
  /** Үсгийн өндөр (font size) */
  height: number;
  /** Хуудасны давамгайлсан унших чиглэлтэй нийцэх эсэх; false = босоо/налуу/урвуу (усан тэмдэг, захын тэмдэглэл) */
  upright: boolean;
}

interface Piece {
  text: string;
  x0: number;
  x1: number;
  y: number;
  h: number;
}

const MIN_HEIGHT = 1e-3;

/** Item-ийг trim хийж (өргөнийг тэмдэгтийн дундаж өргөнөөр засна), дотор нь ≥ 2 зайгаар хэсэглэнэ. */
function toPieces(item: PdfTextItem): Piece[] {
  const { str } = item;
  if (str.trim() === '' || ![item.x, item.y, item.width, item.height].every(Number.isFinite)) return [];
  const h = item.height > MIN_HEIGHT ? item.height : MIN_HEIGHT;
  const cw = item.width / str.length; // тэмдэгтийн дундаж өргөн
  const pieces: Piece[] = [];
  let pos = 0;
  // split-ийн тэгш индекс = текст, сондгой = ≥ 2 зайн дараалал (тусгаарлагч)
  str.split(/( {2,})/).forEach((part, i) => {
    const text = part.trim();
    if (i % 2 === 0 && text !== '') {
      const start = pos + (part.length - part.trimStart().length);
      pieces.push({ text: cleanCellText(text), x0: item.x + start * cw, x1: item.x + (start + text.length) * cw, y: item.y, h });
    }
    pos += part.length;
  });
  return pieces;
}

/** Ижил текст, бараг ижил байрлалтай давхар зургийг хасна (O(n·k): y-ээр эрэмбэлсэн цонхонд). */
function dropOverdraw(sorted: Piece[], ratio: number): Piece[] {
  const kept: Piece[] = [];
  for (const p of sorted) {
    const tol = ratio * p.h;
    let dup = false;
    for (let i = kept.length - 1; i >= 0 && p.y - kept[i].y <= tol; i--) {
      const k = kept[i];
      if (k.text === p.text && Math.abs(k.x0 - p.x0) <= tol && Math.abs(k.y - p.y) <= tol) {
        dup = true;
        break;
      }
    }
    if (!dup) kept.push(p);
  }
  return kept;
}

function buildLine(row: Piece[], o: PdfLayoutOptions): StatementTextLine {
  const sorted = [...row].sort((a, b) => a.x0 - b.x0);
  const cells: string[] = [];
  let cur = sorted[0].text;
  let end = sorted[0].x1;
  let prevH = sorted[0].h;
  for (const p of sorted.slice(1)) {
    const gap = p.x0 - end;
    const h = Math.min(prevH, p.h);
    if (gap > o.cellGapRatio * h) {
      cells.push(cur);
      cur = p.text;
    } else cur += gap > o.wordGapRatio * h ? ` ${p.text}` : p.text;
    end = Math.max(end, p.x1);
    prevH = p.h;
  }
  cells.push(cur);
  const y = row.reduce((s, p) => s + p.y, 0) / row.length;
  return { text: joinCells(cells), cells, y: Math.round(y * 100) / 100 };
}

/** Хуудасны item-үүдээс дээрээс доош, мөр бүрд зүүнээс баруун эрэмбээр line-ууд буцаана. */
export function layoutPdfItems(items: readonly PdfTextItem[], options: PdfLayoutOptions): StatementTextLine[] {
  const upright: Piece[] = [];
  const rotated: Piece[] = [];
  for (const item of items) (item.upright ? upright : rotated).push(...toPieces(item));

  const byPosition = (a: Piece, b: Piece) => a.y - b.y || a.x0 - b.x0;
  const flat = dropOverdraw(upright.sort(byPosition), options.overdrawRatio);

  const rows: Piece[][] = [];
  let rowY = 0;
  let rowH = 0;
  for (const p of flat) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(p.y - rowY) <= options.lineToleranceRatio * Math.min(rowH, p.h)) {
      // дундаж y-г шинэчилнэ (гинжин нэгдэл гарахгүйн тулд мөрийн дундажтай харьцуулна)
      rowY = (rowY * last.length + p.y) / (last.length + 1);
      rowH = Math.min(rowH, p.h);
      last.push(p);
    } else {
      rows.push([p]);
      rowY = p.y;
      rowH = p.h;
    }
  }
  const lines = rows.map((r) => buildLine(r, options));
  // Босоо/налуу текст: мөр бүр тусдаа (нэг item = нэг нүд), хуудасны төгсгөлд
  for (const p of rotated.sort(byPosition)) lines.push({ text: p.text, cells: [p.text], y: Math.round(p.y * 100) / 100 });
  return lines;
}
