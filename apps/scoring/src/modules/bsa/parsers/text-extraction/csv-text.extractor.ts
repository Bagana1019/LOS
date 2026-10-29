// CSV → StatementText (source 'CSV'). RFC 4180 (хашилт, давхар хашилт, хашилт доторх шинэ мөр), delimiter auto-detect (, ; TAB |),
// кодчилол: text-decoding.ts. Бичлэг (record) бүр нэг StatementTextLine; нүд бүр багана (хоосон нүд хадгална — CSV-д байрлал чухал).
// Зөвхөн УНШИНА — formula-injection (=, +, -, @) энд хамааралгүй (бид файл үүсгэхгүй).
import { cleanCellText, joinCells } from './cell-text';
import { CSV_DELIMITER_CANDIDATES } from './text-extraction.defaults';
import { decodeTextBytes } from './text-decoding';
import type { StatementTextLine } from '../statement.types';
import type { CsvDelimiter, CsvTextOptions } from './types';

/**
 * RFC 4180 parser: цэвэр функц. Хашилт зөвхөн талбарын эхэнд нээгдэнэ; нээгдсэний дараа `""` = нэг `"`.
 * Хаагдаагүй хашилт файлын төгсгөл хүртэл талбар болно (хайхрамжгүй, throw хийхгүй). CRLF, CR, LF бүгд бичлэгийн төгсгөл.
 * Хоосон мөр = [''] бичлэг (бичлэгийн дугаарлалт тасрахгүй).
 */
export function parseCsv(text: string, delimiter: string, maxRecords = Number.POSITIVE_INFINITY): string[][] {
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let wasQuoted = false;
  const n = text.length;
  const endField = () => {
    row.push(field);
    field = '';
    wasQuoted = false;
  };
  const endRecord = () => {
    endField();
    records.push(row);
    row = [];
  };
  for (let i = 0; i < n && records.length < maxRecords; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else inQuotes = false;
      continue;
    }
    if (ch === '"' && !wasQuoted && field.trim() === '') {
      inQuotes = true;
      wasQuoted = true;
      field = '';
    } else if (ch === delimiter) endField();
    else if (ch === '\n') endRecord();
    else if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      endRecord();
    } else field += ch;
  }
  if (records.length < maxRecords && (field !== '' || row.length > 0 || wasQuoted)) endRecord();
  return records;
}

/**
 * Delimiter таних: нэр дэвшигч бүрээр эхний N бичлэгийг задалж, "нүдний тоо ≥ 2 ба моод (хамгийн олон давтагдсан) тоотой тэнцүү"
 * бичлэгийн тоог харьцуулна. Тэнцвэл моод нүдний тоо их нь, тэнцвэл дараалал (, ; TAB |) ялна. Олдохгүй бол ','.
 */
export function detectCsvDelimiter(text: string, options: Pick<CsvTextOptions, 'sniffRecords' | 'sniffMaxChars'>): CsvDelimiter {
  const sample = text.length > options.sniffMaxChars ? text.slice(0, options.sniffMaxChars) : text;
  let best: { d: CsvDelimiter; matched: number; modal: number } | null = null;
  for (const d of CSV_DELIMITER_CANDIDATES) {
    const counts = parseCsv(sample, d, options.sniffRecords).map((r) => r.length).filter((c) => c >= 2);
    if (counts.length === 0) continue;
    const freq = new Map<number, number>();
    for (const c of counts) freq.set(c, (freq.get(c) ?? 0) + 1);
    let modal = 0;
    let matched = 0;
    for (const [c, f] of freq) if (f > matched || (f === matched && c > modal)) [modal, matched] = [c, f];
    if (!best || matched > best.matched || (matched === best.matched && modal > best.modal)) best = { d, matched, modal };
  }
  return best?.d ?? ',';
}

export interface CsvExtraction {
  lines: StatementTextLine[];
  delimiter: CsvDelimiter;
  encoding: string;
}

/**
 * @returns хоосон бус бичлэг бүрийн line; `y` = файл дахь бичлэгийн дугаар (1-ээс; хоосон бичлэг оролцоно) — алдааны байршил.
 */
export function extractCsvText(content: Buffer, options: CsvTextOptions): CsvExtraction {
  const { text, encoding } = decodeTextBytes(content, options);
  const delimiter = options.delimiter ?? detectCsvDelimiter(text, options);
  const lines: StatementTextLine[] = [];
  parseCsv(text, delimiter).forEach((record, i) => {
    const cells = record.map(cleanCellText);
    if (cells.every((c) => c === '')) return;
    lines.push({ text: joinCells(cells), cells, y: i + 1 });
  });
  return { lines, delimiter, encoding };
}
