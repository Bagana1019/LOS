// Текстээс OcrPage/OcrLine/OcrWord хайрцгийг ТОГТМОЛ (deterministic) байдлаар зохиох. MockOcrProvider болон extractor-ийн тестүүд ашиглана.
// Зорилго: доод урсгал (хуулгын parser-ийн нүд таслал) жинхэнэ OCR-тай яг адил ажиллах — тэр тул хайрцаг бодит OCR шиг:
//  - y: мөр бүрт нэмэгдэнэ (хоосон мөр ч зай эзэлнэ)
//  - x: тэмдэгтийн offset × charWidth. Нэг зай = 1 багана; TAB эсвэл 2+ зай = дор хаяж `columnGapCols` багана (өргөн цоорхой)
// Доод урсгалын санал болгох босго: үгсийн цоорхой ≥ 2.5 × дундаж тэмдэгтийн өргөн = шинэ нүд.
import type { OcrBox, OcrLine, OcrPage, OcrWord } from '../types';

export interface MockLayoutOptions {
  /** Нэг тэмдэгтийн өргөн (px) */
  charWidth: number;
  /** Мөрийн өндөр (px) */
  lineHeight: number;
  /** Мөр хоорондын зай (px) */
  lineGap: number;
  marginX: number;
  marginY: number;
  /** TAB-ын зогсоол (баганаар) */
  tabCols: number;
  /** TAB / 2+ зай ордог цоорхойн доод хэмжээ (баганаар) */
  columnGapCols: number;
}

export const MOCK_LAYOUT_DEFAULTS: Readonly<MockLayoutOptions> = {
  charWidth: 14,
  lineHeight: 34,
  lineGap: 16,
  marginX: 60,
  marginY: 60,
  tabCols: 8,
  columnGapCols: 3,
};

/** Итгэл: тогтмол тоо, эсвэл үг/мөрийн дугаараар (тестэд "шуугиантай" хэсгийг дуурайх) */
export type MockConfidence = number | ((word: string, lineIndex: number, pageNo: number) => number);

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
const isWhitespace = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === ' ';
/** Дундаж (6 орон хүртэл — float хуримтлагдсан алдаа гарахгүй: 0.99 × N → 0.99) */
const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1e6) / 1e6);

interface RawWord {
  text: string;
  col: number;
}

/** Нэг мөрийг (TAB/зайтай) үгс болон баганын байрлал руу задална. */
function splitLine(raw: string, layout: MockLayoutOptions): { words: RawWord[]; endCol: number } {
  const chars = Array.from(raw);
  const words: RawWord[] = [];
  let col = 0;
  let cur = '';
  let curCol = 0;
  const flush = (): void => {
    if (cur !== '') words.push({ text: cur, col: curCol });
    cur = '';
  };
  let i = 0;
  while (i < chars.length) {
    if (!isWhitespace(chars[i])) {
      if (cur === '') curCol = col;
      cur += chars[i];
      col += 1;
      i += 1;
      continue;
    }
    flush();
    const before = col;
    let spaces = 0;
    let hasTab = false;
    while (i < chars.length && isWhitespace(chars[i])) {
      if (chars[i] === '\t') {
        hasTab = true;
        col = (Math.floor(col / layout.tabCols) + 1) * layout.tabCols;
      } else {
        spaces += 1;
        col += 1;
      }
      i += 1;
    }
    if ((hasTab || spaces >= 2) && col - before < layout.columnGapCols) col = before + layout.columnGapCols;
  }
  flush();
  return { words, endCol: col };
}

const unionBox = (boxes: readonly OcrBox[]): OcrBox => {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  return { x, y, width: right - x, height: bottom - y };
};

/** Текст ('\f' = хуудасны завсар) → OcrPage[]. Хоосон төгсгөлийн хуудсыг хасна (хамгийн багадаа 1 хуудас үлдэнэ). */
export function layoutTextToPages(text: string, confidence: MockConfidence = 0.99, options: Partial<MockLayoutOptions> = {}): OcrPage[] {
  const layout = { ...MOCK_LAYOUT_DEFAULTS, ...options };
  const confOf = typeof confidence === 'number' ? () => clamp01(confidence) : (w: string, li: number, pn: number) => clamp01(confidence(w, li, pn));
  const pages: OcrPage[] = text.split('\f').map((pageText, pIdx) => {
    const pageNo = pIdx + 1;
    const rawLines = pageText.split(/\r?\n/);
    const lines: OcrLine[] = [];
    const allConf: number[] = [];
    let maxCol = 0;
    rawLines.forEach((raw, lineIndex) => {
      const { words, endCol } = splitLine(raw, layout);
      maxCol = Math.max(maxCol, endCol);
      if (words.length === 0) return;
      const y = layout.marginY + lineIndex * (layout.lineHeight + layout.lineGap);
      const ocrWords: OcrWord[] = words.map((w) => ({
        text: w.text,
        confidence: confOf(w.text, lineIndex, pageNo),
        box: { x: layout.marginX + w.col * layout.charWidth, y, width: Array.from(w.text).length * layout.charWidth, height: layout.lineHeight },
      }));
      ocrWords.forEach((w) => allConf.push(w.confidence));
      lines.push({
        text: ocrWords.map((w) => w.text).join(' '),
        confidence: mean(ocrWords.map((w) => w.confidence)),
        box: unionBox(ocrWords.map((w) => w.box)),
        words: ocrWords,
      });
    });
    return {
      pageNo,
      width: layout.marginX * 2 + maxCol * layout.charWidth,
      height: layout.marginY * 2 + rawLines.length * (layout.lineHeight + layout.lineGap),
      text: lines.map((l) => l.text).join('\n'),
      lines,
      meanConfidence: mean(allConf),
    };
  });
  while (pages.length > 1 && pages[pages.length - 1].lines.length === 0) pages.pop();
  return pages;
}
