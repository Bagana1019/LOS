// OcrResult → мөр/үгийн загвар (глобал тэмдэгтийн offset-той). Extractor бүр үүнийг ашиглана.
// Мөрийн текст = үгсийг ганц зайгаар залгасан (жинхэнэ OCR шиг); үггүй мөр бол мөрийн текстийг үгэнд хуваана.
import type { OcrResult } from '../types';

export interface DocWord {
  text: string;
  /** глобал offset [start, end) */
  start: number;
  end: number;
  conf: number;
  /** хайрцаг (пиксел); ердийн текстэд x=0 */
  x: number;
  right: number;
  height: number;
}

export interface DocLine {
  idx: number;
  page: number;
  text: string;
  /** глобал offset [start, end) */
  start: number;
  end: number;
  conf: number;
  words: DocWord[];
  /** үгсийн хайрцаг бодит (OCR-аас) эсэх — баганан байрлал тооцоход */
  hasBoxes: boolean;
}

export interface OcrDoc {
  /** Бүх мөр '\n'-ээр */
  text: string;
  /** Тоон задлалтад зориулсан хуулбар: тоон токен доторх O/I/S/B-г цифр болгосон, offset ЯГ ижил */
  numText: string;
  lines: DocLine[];
  lineAt(offset: number): DocLine | undefined;
  /** [start,end) хэсэгт давхцсан үгсийн итгэлийн дундаж; үг олдохгүй бол тухайн мөрийн итгэл */
  spanConf(start: number, end: number): number;
}

const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

/** Цифртэй андуурагдах тэмдэгт (OCR): O/o/О/о→0, I/l/|→1, S→5, B→8 */
const DIGIT_CONFUSION: Readonly<Record<string, string>> = { O: '0', o: '0', О: '0', о: '0', I: '1', l: '1', '|': '1', S: '5', B: '8' };

/**
 * Тоон токен (цифр + O/I/l/S/B + . , ' : / - , зай-гүй, захад нь үсэг залгаагүй) дотор ≥ 1 цифр, нийт ≥ 4 тэмдэгт бол
 * андуурагдсан тэмдэгтийг цифр болгоно ('1,8OO,OOO' → '1,800,000', '2O3O.O4.I2'). Урт ХАДГАЛНА (offset өөрчлөгдөхгүй).
 * Цифргүй үг ('SOB', 'BOLO'), богино токен ('I2') хөндөгдөхгүй; үсэг залгасан үг ('Y892110384') ч хөндөгдөхгүй.
 */
export function normalizeDigitLookalikes(text: string): string {
  return text.replace(/(?<![\p{L}\p{N}])[0-9OoОоIl|SB][0-9OoОоIl|SB.,'’:/-]*[0-9OoОоIl|SB](?![\p{L}])/gu, (tok) => {
    const digits = tok.replace(/[^0-9]/g, '').length;
    if (digits < 1 || tok.replace(/[^0-9OoОоIl|SB]/g, '').length < 4) return tok;
    return tok.replace(/[OoОоIl|SB]/g, (c) => DIGIT_CONFUSION[c] ?? c);
  });
}

export function buildDoc(ocr: OcrResult): OcrDoc {
  const lines: DocLine[] = [];
  let text = '';
  const pushLine = (page: number, parts: Array<{ text: string; conf: number; x: number; right: number; height: number }>, lineConf: number, hasBoxes: boolean): void => {
    if (parts.length === 0) return;
    const start = text === '' && lines.length === 0 ? 0 : text.length + 1;
    let local = 0;
    const words: DocWord[] = parts.map((p) => {
      const w: DocWord = { text: p.text, start: start + local, end: start + local + p.text.length, conf: p.conf, x: p.x, right: p.right, height: p.height };
      local += p.text.length + 1;
      return w;
    });
    const lineText = parts.map((p) => p.text).join(' ');
    text += (lines.length === 0 ? '' : '\n') + lineText;
    lines.push({ idx: lines.length, page, text: lineText, start, end: start + lineText.length, conf: lineConf, words, hasBoxes });
  };

  for (const page of ocr.pages) {
    if (page.lines.length > 0) {
      for (const l of page.lines) {
        const real = l.words.filter((w) => w.text.trim() !== '');
        if (real.length > 0) {
          pushLine(page.pageNo, real.map((w) => ({ text: w.text.trim(), conf: w.confidence, x: w.box.x, right: w.box.x + w.box.width, height: w.box.height })), l.confidence, true);
        } else {
          const toks = l.text.split(/\s+/).filter(Boolean);
          pushLine(page.pageNo, toks.map((t) => ({ text: t, conf: l.confidence, x: 0, right: 0, height: 0 })), l.confidence, false);
        }
      }
    } else {
      for (const raw of page.text.split(/\r?\n/)) {
        const toks = raw.split(/\s+/).filter(Boolean);
        pushLine(page.pageNo, toks.map((t) => ({ text: t, conf: page.meanConfidence, x: 0, right: 0, height: 0 })), page.meanConfidence, false);
      }
    }
  }

  const words = lines.flatMap((l) => l.words);
  return {
    text,
    numText: normalizeDigitLookalikes(text),
    lines,
    lineAt(offset) {
      return lines.find((l) => offset >= l.start && offset <= l.end);
    },
    spanConf(start, end) {
      const hit = words.filter((w) => w.end > start && w.start < end);
      if (hit.length > 0) return mean(hit.map((w) => w.conf));
      return lines.find((l) => start >= l.start && start <= l.end)?.conf ?? ocr.meanConfidence;
    },
  };
}
