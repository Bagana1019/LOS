import { Writable } from 'node:stream';
import ExcelJS from 'exceljs';
import type { ReportColumn, ReportRow } from '@los/contracts';
import { yieldToEventLoop } from './concurrency';
import { labelOf } from './report-labels';

// NFR-9: тайлангийн Excel. Гарчгийн 4 мөр (нэр, огноо, шүүлт, үүсгэсэн), 5-р мөр хүснэгтийн толгой (bold, freeze, autofilter), дараа нь өгөгдөл, төгсгөлд нийлбэр.
export const EXPORT_HEADER_ROW = 5;
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const FORMAT = { money: '#,##0.00', number: '#,##0', percent: '0.00%', date: 'yyyy-mm-dd' } as const;

export interface ExportMeta {
  title: string;
  asOf: string;
  generatedAt: string;
  /** "Салбар: branch-1" гэх мэт шүүлтийн тайлбар мөрүүд. */
  filterLines: string[];
  /** Олон валюттай → нийлбэр бодоогүй. */
  mixedCurrency: boolean;
  /** Өгөгдлийн эх сурвалж. 'core-mock' бол гарчиг/хуудасны нэр/толгойд "ЗОХИОМОЛ (MOCK)" гэж тодорхой тэмдэглэнэ (NFR-4/5 — жинхэнэ тайлангаас ялгагдах). */
  dataSource?: 'origination' | 'core-mock' | 'core';
}

export const MOCK_DATA_NOTICE = 'ЗОХИОМОЛ (MOCK) ӨГӨГДӨЛ — Core-оос биш';

const sheetName = (title: string): string => title.replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || 'Тайлан';

function cellValue(c: ReportColumn, v: ReportRow[string] | undefined): ExcelJS.CellValue {
  if (v === null || v === undefined) return null;
  switch (c.type) {
    case 'date': {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v));
      return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : String(v);
    }
    case 'money': case 'number': case 'percent':
      return typeof v === 'number' ? v : Number(v);
    case 'status':
      return labelOf(c.options, String(v));
    default:
      return typeof v === 'boolean' ? v : String(v);
  }
}

const numFmt = (c: ReportColumn): string | undefined => (c.type === 'money' ? FORMAT.money : c.type === 'number' ? FORMAT.number : c.type === 'percent' ? FORMAT.percent : c.type === 'date' ? FORMAT.date : undefined);

/** Хэдэн мөр тутамд event loop-д амс өгөх вэ (хэмжилт: 23 баганатай 500 мөр ≈ 20–40 мс). */
export const EXPORT_YIELD_EVERY = 500;

/** Бичсэн бүх chunk-ийг Buffer болгон цуглуулдаг sink (xlsx шахагдсан тул жижиг: 50k мөр ≈ 5MB). */
class BufferSink extends Writable {
  private readonly chunks: Buffer[] = [];
  _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void { this.chunks.push(chunk); cb(); }
  toBuffer(): Buffer { return Buffer.concat(this.chunks); }
}

/** Гарчгийн 4 мөр. core-mock бол зохиомол гэдгийг гарчиг, огноо, эх сурвалжийн мөрөнд тодорхой бичнэ. */
function titleLines(meta: ExportMeta): string[] {
  const mock = meta.dataSource === 'core-mock';
  return [
    mock ? `${meta.title} — ${MOCK_DATA_NOTICE}` : meta.title,
    `Огноо (байдлаар): ${meta.asOf}${mock ? ' (mock өгөгдөл огнооноос хамаарахгүй)' : ''}`,
    `Шүүлт: ${meta.filterLines.length ? meta.filterLines.join('; ') : '—'}`,
    `Үүсгэсэн: ${meta.generatedAt}${mock ? `; Эх сурвалж: ${MOCK_DATA_NOTICE}` : meta.dataSource === 'core' ? '; Эх сурвалж: Core' : ''}`,
  ];
}

/**
 * NFR-1/9: ExcelJS-ийн STREAMING writer — мөр бүрийг commit хийж шууд шахан бичнэ (бүх cell-ийг санах ойд барьдаггүй),
 * EXPORT_YIELD_EVERY мөр тутамд event loop-д амс өгнө. Ингэснээр том экспорт ижил процесс дахь бусад хүсэлтийг (төлбөрийн callback…) гацаахгүй.
 * Streaming горимд views / баганы өргөн / autofilter нь эхний мөрийг commit хийхээс өмнө тодорхойлогдсон байх ёстой.
 */
export async function buildReportWorkbook(columns: ReportColumn[], rows: ReportRow[], totals: Record<string, number> | undefined, meta: ExportMeta): Promise<Buffer> {
  const sink = new BufferSink();
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: sink, useStyles: true, useSharedStrings: false });
  wb.creator = 'LOS Radix';
  wb.created = new Date(meta.generatedAt);
  const lastCol = Math.max(columns.length, 1);
  const lastDataRow = EXPORT_HEADER_ROW + rows.length;
  const mock = meta.dataSource === 'core-mock';
  const ws = wb.addWorksheet(sheetName(mock ? `MOCK ${meta.title}` : meta.title), { views: [{ state: 'frozen', ySplit: EXPORT_HEADER_ROW }] });
  ws.autoFilter = { from: { row: EXPORT_HEADER_ROW, column: 1 }, to: { row: Math.max(lastDataRow, EXPORT_HEADER_ROW), column: lastCol } }; // мөрийн тоо урьдчилан мэдэгдэнэ; sheet төгсгөлд бичигдэнэ
  columns.forEach((c, i) => { ws.getColumn(i + 1).width = c.width ?? 14; });

  titleLines(meta).forEach((text, i) => {
    const row = ws.getRow(i + 1);
    const cell = row.getCell(1);
    cell.value = text;
    if (i === 0) cell.font = mock ? { bold: true, size: 14, color: { argb: 'FFC00000' } } : { bold: true, size: 14 };
    row.commit();
  });

  const header = ws.getRow(EXPORT_HEADER_ROW);
  columns.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.value = c.label;
    cell.font = { bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF4' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = { bottom: { style: 'thin' } };
  });
  header.commit();

  const formats = columns.map(numFmt);
  for (let r = 0; r < rows.length; r++) {
    const src = rows[r];
    const row = ws.getRow(EXPORT_HEADER_ROW + 1 + r);
    for (let i = 0; i < columns.length; i++) {
      const cell = row.getCell(i + 1);
      cell.value = cellValue(columns[i], src[columns[i].key]);
      const fmt = formats[i];
      if (fmt) cell.numFmt = fmt;
    }
    row.commit();
    if ((r + 1) % EXPORT_YIELD_EVERY === 0) await yieldToEventLoop();
  }

  if (totals || meta.mixedCurrency) {
    const row = ws.getRow(lastDataRow + 1);
    row.getCell(1).value = 'Нийт';
    row.getCell(1).font = { bold: true };
    if (meta.mixedCurrency) row.getCell(2).value = 'Олон валюттай тул нийлбэр бодоогүй';
    columns.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      cell.border = { top: { style: 'thin' } };
      if (totals && c.key in totals && i !== 0) {
        cell.value = totals[c.key];
        cell.font = { bold: true };
        const fmt = formats[i];
        if (fmt) cell.numFmt = fmt;
      }
    });
    row.commit();
  }

  ws.commit();
  await wb.commit();
  return sink.toBuffer();
}
