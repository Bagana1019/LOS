// ТЕСТИЙН туслах (SYNTHETIC): parser-ийн синтетик хуулгыг (StatementText) бодит файл болгон (CSV | TEXT | PDF) бичнэ. Бүх нэр, данс, дүн,
// гүйлгээний утга зохиомол — бодит банкны хуулга ОГТ ашиглаагүй. Parser-ууд бодит файлаар баталгаажаагүй (TODO(samples)) тул эдгээр
// тест нь зөвхөн pipeline-ийн логикийг шалгана, банкны бодит форматыг БИШ.
import type { BankCode } from '@los/contracts';
import { SYNTHETIC_IBAN } from '@los/ocr';
import { BANK_SPECS, bankStatement, SPEC_OPENING, type SpecOverrides } from '../../parsers/banks/testing/bank-specs';
import type { SynExpected, SynTxn } from '../../parsers/engine/testing/synthetic-statement';
import type { StatementText } from '../../parsers/statement.types';
import { buildPdf, type DrawText, type PdfPageSpec } from '../../parsers/text-extraction/testing/pdf-builder';

export type FileFormat = 'csv' | 'text' | 'pdf';

export interface SynFile {
  content: Buffer;
  fileName: string;
  mimeType: string;
  expected: SynExpected;
  text: StatementText;
}

const csvField = (v: string): string => `"${v.replace(/"/g, '""')}"`;

export function textToCsv(text: StatementText): Buffer {
  const lines: string[] = [];
  for (const page of text.pages) for (const line of page.lines) lines.push(line.cells.map(csvField).join(','));
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** Нүднүүдийг 3 зайгаар тусгаарласан энгийн текст (plain-text extractor ≥ 2 зайгаар хуваана) */
export function textToPlain(text: StatementText): Buffer {
  return Buffer.from(text.pages.map((p) => p.lines.map((l) => l.cells.filter((c) => c !== '').join('   ')).join('\n')).join('\f'), 'utf8');
}

const CHAR_WIDTH = 5.6; // 9pt Helvetica-ийн дундаж өргөнөөс томруулсан (нүднүүд хоорондоо давхцахгүй)
const COLUMN_GAP = 18;
const LINE_STEP = 12;
const PDF_SIZE = 9;

/** PDF text layer: нүд бүрийг багана тус бүрийн тогтмол x-д бичнэ. Зөвхөн Latin үсэг (Helvetica) — Кирилл бичихэд pdf-lib унана */
export async function textToPdf(text: StatementText): Promise<Buffer> {
  const pages: PdfPageSpec[] = text.pages.map((page) => {
    const widths: number[] = [];
    for (const line of page.lines) {
      line.cells.forEach((cell, i) => {
        widths[i] = Math.max(widths[i] ?? 0, cell.length * CHAR_WIDTH);
      });
    }
    const xs: number[] = [];
    let x = 30;
    for (const w of widths) {
      xs.push(x);
      x += w + COLUMN_GAP;
    }
    const height = Math.max(200, page.lines.length * LINE_STEP + 80);
    const texts: DrawText[] = [];
    page.lines.forEach((line, row) => {
      line.cells.forEach((cell, i) => {
        if (cell !== '') texts.push({ text: cell, x: xs[i], y: height - 40 - row * LINE_STEP, size: PDF_SIZE });
      });
    });
    return { texts, width: Math.max(595, x + 30), height };
  });
  return buildPdf({ pages, producer: 'synthetic-test', creator: 'synthetic-test' });
}

export interface BuildFileOptions {
  bank: BankCode;
  txns: SynTxn[];
  opening?: number;
  format?: FileFormat;
  fileName?: string;
  accountNo?: string;
  iban?: string | null;
  holder?: string;
  register?: string | null;
  /** layout дарах (жишээ нь rowsPerPage, showCount) */
  overrides?: SpecOverrides;
  /** PDF/Latin: banner, шошго, банкны нэрийг англиар */
  latin?: boolean;
  /** Файлын текстийг шууд өөрчлөх (тест: мөр хассан, үлдэгдэл эвдсэн…) */
  tamper?: (text: StatementText) => StatementText;
}

/** Банкны таамагласан SYNTHETIC форматаар хуулга үүсгэж файл болгоно */
export async function buildStatementFile(o: BuildFileOptions): Promise<SynFile> {
  const spec = BANK_SPECS[o.bank];
  const format = o.format ?? 'csv';
  const latin = o.latin ?? format === 'pdf';
  const header = {
    accountNo: o.accountNo ?? '5011223344',
    iban: o.iban === undefined ? SYNTHETIC_IBAN : (o.iban ?? undefined),
    holder: o.holder ?? 'Bat-Erdene Bold',
    register: o.register === undefined ? undefined : (o.register ?? undefined),
    ...(o.overrides?.header ?? {}),
  };
  const overrides: SpecOverrides = {
    ...(latin ? { labels: 'en' as const } : {}),
    ...o.overrides,
    header: { ...(latin ? { titleLines: [`SYNTHETIC TEST DATA - NOT A REAL STATEMENT`, ...LATIN_TITLES[o.bank]] } : {}), ...header },
  };
  const { text: rawText, expected } = bankStatement(spec, o.txns, overrides, o.opening ?? SPEC_OPENING);
  const text = o.tamper ? o.tamper(rawText) : rawText;
  const ext = format === 'pdf' ? 'pdf' : format === 'csv' ? 'csv' : 'txt';
  const content = format === 'pdf' ? await textToPdf(text) : format === 'csv' ? textToCsv(text) : textToPlain(text);
  const mimeType = format === 'pdf' ? 'application/pdf' : format === 'csv' ? 'text/csv' : 'text/plain';
  return { content, fileName: o.fileName ?? `synthetic-${o.bank.toLowerCase()}.${ext}`, mimeType, expected, text };
}

/** PDF/Latin горимын гарчиг (банкны нэрийг англиар: detect түлхүүр үг) */
const LATIN_TITLES: Record<BankCode, string[]> = {
  KHAN: ['Khan Bank', 'Account statement'],
  GOLOMT: ['Golomt Bank', 'Account statement'],
  TDB: ['Trade and Development Bank', 'TDB Account statement'],
  XAC: ['XacBank', 'Account statement'],
  CAPITRON: ['Capitron Bank', 'Account statement'],
  STATE: ['State Bank of Mongolia', 'Account statement'],
  MBANK: ['M Bank', 'Account statement'],
};
