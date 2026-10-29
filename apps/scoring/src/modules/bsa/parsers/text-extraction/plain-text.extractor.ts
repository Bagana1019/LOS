// Энгийн текст → StatementText (source 'TEXT'). Мөр бүр нэг line; нүд = TAB эсвэл ≥ 2 зайн дараалал (цуваа тусгаарлагч нэг тусгаарлагч).
// Form feed (\f) = хуудасны таслал (statementTextFromDump-ийн хэлбэртэй нийцнэ). Хоосон мөрийг алгасна.
import { cleanCellText, joinCells } from './cell-text';
import { decodeTextBytes } from './text-decoding';
import type { StatementTextLine, StatementTextPage } from '../statement.types';
import type { CsvTextOptions } from './types';

const CELL_SEPARATOR_RE = / *\t[\t ]*| {2,}/;

/** Нэг мөрийг нүдэнд хуваана (хоосон нүд гарахгүй). */
export function splitPlainTextCells(line: string): string[] {
  return line
    .replace(/\u00a0/g, ' ')
    .trim()
    .split(CELL_SEPARATOR_RE)
    .map(cleanCellText)
    .filter((c) => c !== '');
}

/** `y` = хуудас доторх мөрийн дугаар (1-ээс; хоосон мөр оролцоно). Мөртэй хуудас олдохгүй бол pages = []. */
export function extractPlainText(content: Buffer, options: Pick<CsvTextOptions, 'cp1251Dominance' | 'remapMongolianCp1251'>): StatementTextPage[] {
  const { text } = decodeTextBytes(content, options);
  const pages: StatementTextPage[] = [];
  text.split('\f').forEach((pageText, p) => {
    const lines: StatementTextLine[] = [];
    pageText.split(/\r\n|\r|\n/).forEach((raw, i) => {
      const cells = splitPlainTextCells(raw);
      if (cells.length > 0) lines.push({ text: joinCells(cells), cells, y: i + 1 });
    });
    pages.push({ pageNo: p + 1, lines });
  });
  return pages.some((pg) => pg.lines.length > 0) ? pages : [];
}
