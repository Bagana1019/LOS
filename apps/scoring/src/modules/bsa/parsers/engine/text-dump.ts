// Текст dump ↔ StatementText. samples/ дахь `.txt` dump болон synthetic fixture-д ашиглана (StatementTextService-гүй parse).
// Формат: хуудсыг '\f', мөрийг '\n', нүдийг TAB-аар (TAB байхгүй мөр нэг нүд — engine 2+ зайгаар өөрөө таслана).
import type { StatementFileMeta, StatementText, StatementTextLine, StatementTextPage, StatementTextSource } from '../statement.types';

export function syntheticMeta(overrides: Partial<StatementFileMeta> = {}): StatementFileMeta {
  return { fileName: 'dump.txt', mimeType: 'text/plain', sizeBytes: 0, sha256: '0'.repeat(64), ...overrides };
}

export function statementTextFromDump(
  dump: string,
  opts: { source?: StatementTextSource; meta?: Partial<StatementFileMeta> } = {},
): StatementText {
  const pages: StatementTextPage[] = dump.split('\f').map((pageText, i) => {
    const lines: StatementTextLine[] = pageText
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((raw) => {
        const cells = raw.includes('\t') ? raw.split('\t').map((c) => c.trim()) : [raw.trim()];
        return { text: cells.filter((c) => c !== '').join(' '), cells };
      });
    return { pageNo: i + 1, lines };
  });
  return { source: opts.source ?? 'TEXT', pages, meta: syntheticMeta(opts.meta) };
}

/** statementTextFromDump-ийн урвуу (fixture үүсгэхэд) */
export function statementTextToDump(text: StatementText): string {
  return text.pages.map((p) => p.lines.map((l) => (l.cells.length > 1 ? l.cells.join('\t') : l.text)).join('\n')).join('\f');
}
