// FR-13.1: хар жагсаалтын CSV импорт. Header мөр заавал; UTF-8 BOM, CRLF, "..." талбар (таслал, "" -оор зугтаасан хашилт,
// мөр таслалт), ',' эсвэл ';' (header-ээс автоматаар), хоосон мөр алгасна.
const CSV_COLUMNS = ['registerNo', 'customerType', 'name', 'listType', 'reasonCode', 'reasonText'] as const;
const REQUIRED = ['registerNo', 'customerType', 'name', 'reasonCode'];

/** Бүтэц алдаатай файл (header байхгүй, хаагдаагүй хашилт) — бүх файлыг няцаана. */
export class CsvFormatError extends Error {}

/** Өгөгдлийн мөрийн тоо `maxRows`-оос хэтэрсэн (хоосон мөрийг тоолохгүй) — файлыг бүхэлд нь уншихгүйгээр зогсооно. */
export class CsvRowLimitError extends Error {
  constructor(readonly maxRows: number) {
    super(`CSV has more than ${maxRows} data rows`);
  }
}

/** row = 1-based өгөгдлийн мөр (header болон хоосон мөрийг тоолохгүй). */
export type CsvImportRow = { row: number; data: Record<string, string> } | { row: number; error: string };

function detectDelimiter(text: string): string {
  const header = text.split(/\r\n|\n|\r/, 1)[0] ?? '';
  const count = (ch: string) => header.split(ch).length - 1;
  return count(';') > count(',') ? ';' : ',';
}

/**
 * Хоосон (бүх талбар хоосон) мөрийг шууд хаяна: 5 MB-ийн зөвхөн "\n" агуулсан файл санах ойд хуримтлагдахгүй.
 * `maxRecords` (header-тэй нийлсэн) хэтрэхэд шууд зогсоно: 5 MB-ийн "a\n" мөрүүд сая сая объект үүсгэхгүй.
 */
function splitRecords(text: string, delimiter: string, maxRecords: number): string[][] {
  const records: string[][] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let fresh = true; // нээлтийн хашилт зөвхөн талбарын эхэнд хүчинтэй
  const endRecord = () => {
    cells.push(cell);
    if (cells.some((c) => c.trim() !== '')) {
      if (records.length >= maxRecords) throw new CsvRowLimitError(maxRecords - 1);
      records.push(cells);
    }
    cells = [];
    cell = '';
    fresh = true;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
    } else if (ch === '"' && fresh) {
      quoted = true;
      fresh = false;
    } else if (ch === delimiter) {
      cells.push(cell);
      cell = '';
      fresh = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRecord();
    } else {
      cell += ch;
      fresh = false;
    }
  }
  if (quoted) throw new CsvFormatError('Unterminated quoted field');
  endRecord();
  return records;
}

/** `maxRows`: өгөгдлийн мөрийн дээд тоо (header, хоосон мөрийг тоолохгүй); хэтэрвэл CsvRowLimitError. */
export function parseBlacklistCsv(input: string, maxRows = Number.POSITIVE_INFINITY): CsvImportRow[] {
  const text = input.replace(/^\uFEFF/, '');
  const [header, ...body] = splitRecords(text, detectDelimiter(text), maxRows + 1);
  if (!header) throw new CsvFormatError('CSV header row is required');

  const byLowerName = new Map<string, string>(CSV_COLUMNS.map((c) => [c.toLowerCase(), c]));
  const columns = header.map((h) => byLowerName.get(h.trim().toLowerCase()));
  // Төгсгөлийн таслалаас үүссэн нэргүй багана өгөгдөлгүй тул алгасна.
  const unknown = header.map((h) => h.trim()).filter((h, i) => h !== '' && !columns[i]);
  // Header нүдийг echo хийхгүй: header-гүй файлын эхний өгөгдлийн мөр (регистр, нэр) header болж ирдэг (CLAUDE.md §6.5).
  if (unknown.length > 0) throw new CsvFormatError(`${unknown.length} unknown column(s) in the header row; allowed columns: ${CSV_COLUMNS.join(', ')}`);
  const named = columns.filter((c) => c !== undefined);
  const present = new Set(named);
  if (present.size !== named.length) throw new CsvFormatError('Duplicate column in header');
  const missing = REQUIRED.filter((c) => !present.has(c));
  if (missing.length > 0) throw new CsvFormatError(`Missing required column(s): ${missing.join(', ')}`);

  return body.map((cells, i): CsvImportRow => {
    const row = i + 1;
    if (cells.slice(columns.length).some((c) => c.trim() !== '')) return { row, error: 'Row has more columns than the header' };
    const data: Record<string, string> = {};
    columns.forEach((name, idx) => {
      const value = (cells[idx] ?? '').trim();
      if (name && value !== '') data[name] = value;
    });
    return { row, data };
  });
}
