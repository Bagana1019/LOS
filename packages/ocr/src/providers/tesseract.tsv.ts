// Tesseract TSV гаралтыг OcrPage/OcrLine/OcrWord болгох цэвэр parser (I/O байхгүй).
// Багана: level page_num block_num par_num line_num word_num left top width height conf text
// level: 1=хуудас, 2=блок, 3=догол мөр, 4=мөр, 5=үг. conf -1 = үг биш мөр (өөрөө текстгүй) → алгасна.
import type { OcrBox, OcrLine, OcrPage, OcrWord } from '../types';

const MIN_COLUMNS = 11;
const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
/** Дундаж (6 орон хүртэл — float хуримтлагдсан алдаа гарахгүй: 0.99 × N → 0.99) */
const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1e6) / 1e6);

interface PageDraft {
  width: number;
  height: number;
  lines: Map<string, { box: OcrBox | null; words: OcrWord[] }>;
}

const unionBox = (boxes: readonly OcrBox[]): OcrBox => {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  return { x, y, width: right - x, height: bottom - y };
};

/**
 * TSV → хуудсууд (page_num өсөх дарааллаар, pageNo = TSV-ийн page_num). Эвдэрсэн/богино мөр, тоо биш талбар, conf < 0, хоосон үгийг алгасна.
 * Үгийн conf (0..100) → 0..1. Мөрийн conf = үгсийн дундаж; хуудасны meanConfidence = хуудасны бүх үгийн дундаж.
 * Хуудасны хэмжээ level-1 мөрөөс; байхгүй бол хайрцгуудын хамгийн их хүрээнээс.
 */
export function parseTesseractTsv(tsv: string): OcrPage[] {
  const pages = new Map<number, PageDraft>();
  const draftOf = (pageNo: number): PageDraft => {
    let d = pages.get(pageNo);
    if (!d) {
      d = { width: 0, height: 0, lines: new Map() };
      pages.set(pageNo, d);
    }
    return d;
  };

  for (const row of tsv.split(/\r?\n/)) {
    if (row === '' || row.startsWith('level\t')) continue;
    const cols = row.split('\t');
    if (cols.length < MIN_COLUMNS) continue;
    const nums = cols.slice(0, 11).map((c) => Number(c));
    if (nums.some((n) => !Number.isFinite(n))) continue;
    const [level, pageNo, blockNo, parNo, lineNo, , left, top, width, height, conf] = nums;
    const box: OcrBox = { x: left, y: top, width, height };
    const page = draftOf(pageNo);
    if (level === 1) {
      page.width = width;
      page.height = height;
      continue;
    }
    const lineKey = `${blockNo}.${parNo}.${lineNo}`;
    if (level === 4) {
      const existing = page.lines.get(lineKey);
      if (existing) existing.box = box;
      else page.lines.set(lineKey, { box, words: [] });
      continue;
    }
    if (level !== 5 || conf < 0) continue;
    const text = cols.slice(11).join('\t').trim();
    if (text === '') continue;
    let line = page.lines.get(lineKey);
    if (!line) {
      line = { box: null, words: [] };
      page.lines.set(lineKey, line);
    }
    line.words.push({ text, confidence: clamp01(conf / 100), box });
  }

  return [...pages.entries()]
    .sort(([a], [b]) => a - b)
    .map(([pageNo, draft]) => {
      const lines: OcrLine[] = [];
      for (const l of draft.lines.values()) {
        if (l.words.length === 0) continue;
        lines.push({
          text: l.words.map((w) => w.text).join(' '),
          confidence: mean(l.words.map((w) => w.confidence)),
          box: l.box ?? unionBox(l.words.map((w) => w.box)),
          words: l.words,
        });
      }
      const boxes = lines.map((l) => l.box);
      return {
        pageNo,
        width: draft.width > 0 ? draft.width : Math.max(0, ...boxes.map((b) => b.x + b.width)),
        height: draft.height > 0 ? draft.height : Math.max(0, ...boxes.map((b) => b.y + b.height)),
        text: lines.map((l) => l.text).join('\n'),
        lines,
        meanConfidence: mean(lines.flatMap((l) => l.words.map((w) => w.confidence))),
      };
    });
}
