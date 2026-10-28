import ExcelJS from 'exceljs';
import { describe, expect, it, vi } from 'vitest';
import type { ReportColumn, ReportRow } from '@los/contracts';
import { EXPORT_HEADER_ROW, EXPORT_YIELD_EVERY, FORMAT, MOCK_DATA_NOTICE, buildReportWorkbook, type ExportMeta } from './excel.exporter';

const columns: ReportColumn[] = [
  { key: 'name', label: 'Зээлдэгч', type: 'string', width: 20 },
  { key: 'amount', label: 'Дүн', type: 'money', width: 16 },
  { key: 'count', label: 'Тоо', type: 'number' },
  { key: 'ratio', label: 'Хувь', type: 'percent', width: 10 },
  { key: 'due', label: 'Огноо', type: 'date', width: 12 },
  { key: 'state', label: 'Төлөв', type: 'status', options: [{ value: 'OK', label: 'Хэвийн' }] },
  { key: 'flag', label: 'Тэмдэг', type: 'string' },
];
const meta = (o: Partial<ExportMeta> = {}): ExportMeta => ({ title: 'Туршилтын тайлан', asOf: '2026-10-28', generatedAt: '2026-10-28T02:00:00.000Z', filterLines: ['Салбар = branch-1', 'Валют = MNT (₮)'], mixedCurrency: false, ...o });
const rows: ReportRow[] = [
  { name: 'Бат Болд', amount: 1234.5, count: 3, ratio: 0.25, due: '2026-11-05', state: 'OK', flag: true },
  { name: 'Дорж', amount: 0, count: 0, ratio: 0, due: null, state: 'UNKNOWN', flag: false },
  { name: null, amount: null, count: null, ratio: null, due: '2027-01-31', state: null, flag: null },
];
const load = async (buf: Buffer) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf as unknown as ArrayBuffer); return wb.worksheets[0]; };

describe('buildReportWorkbook', () => {
  it('гарчгийн мөрүүд, толгой (bold), өргөн, freeze, autofilter', async () => {
    const ws = await load(await buildReportWorkbook(columns, rows, { amount: 1234.5, count: 3 }, meta()));
    expect(ws.name).toBe('Туршилтын тайлан');
    expect(ws.getCell(1, 1).value).toBe('Туршилтын тайлан');
    expect(ws.getCell(1, 1).font?.bold).toBe(true);
    expect(ws.getCell(2, 1).value).toBe('Огноо (байдлаар): 2026-10-28');
    expect(ws.getCell(3, 1).value).toBe('Шүүлт: Салбар = branch-1; Валют = MNT (₮)');
    expect(ws.getCell(4, 1).value).toBe('Үүсгэсэн: 2026-10-28T02:00:00.000Z');
    columns.forEach((c, i) => {
      const cell = ws.getCell(EXPORT_HEADER_ROW, i + 1);
      expect(cell.value).toBe(c.label);
      expect(cell.font?.bold).toBe(true);
      expect(ws.getColumn(i + 1).width).toBe(c.width ?? 14);
    });
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: EXPORT_HEADER_ROW });
    expect(String(ws.autoFilter)).toBe('A5:G8');
  });

  it('өгөгдөл: тоо/огноо/хувь/төлөв/null/boolean ба формат', async () => {
    const ws = await load(await buildReportWorkbook(columns, rows, undefined, meta()));
    const r1 = ws.getRow(6);
    expect(r1.getCell(1).value).toBe('Бат Болд');
    expect(r1.getCell(2).value).toBe(1234.5);
    expect(r1.getCell(2).numFmt).toBe(FORMAT.money);
    expect(r1.getCell(3).numFmt).toBe(FORMAT.number);
    expect(r1.getCell(4).value).toBe(0.25);
    expect(r1.getCell(4).numFmt).toBe(FORMAT.percent);
    expect(r1.getCell(5).value).toEqual(new Date(Date.UTC(2026, 10, 5)));
    expect(r1.getCell(5).numFmt).toBe(FORMAT.date);
    expect(r1.getCell(6).value).toBe('Хэвийн');
    expect(r1.getCell(7).value).toBe(true);
    const r2 = ws.getRow(7);
    expect(r2.getCell(2).value).toBe(0); // 0 нь хоосон биш
    expect(r2.getCell(5).value ?? null).toBeNull();
    expect(r2.getCell(6).value).toBe('UNKNOWN'); // шошгогүй код өөрөө
    expect(r2.getCell(7).value).toBe(false);
    const r3 = ws.getRow(8);
    for (const i of [1, 2, 3, 4, 6, 7]) expect(r3.getCell(i).value ?? null, `col ${i}`).toBeNull();
    expect(r3.getCell(5).value).toEqual(new Date(Date.UTC(2027, 0, 31)));
  });

  it('нийлбэр мөр: "Нийт", bold, формат; нийлбэргүй баганад хоосон', async () => {
    const ws = await load(await buildReportWorkbook(columns, rows, { amount: 1234.5, count: 3 }, meta()));
    const tr = ws.getRow(EXPORT_HEADER_ROW + rows.length + 1);
    expect(tr.getCell(1).value).toBe('Нийт');
    expect(tr.getCell(1).font?.bold).toBe(true);
    expect(tr.getCell(2).value).toBe(1234.5);
    expect(tr.getCell(2).numFmt).toBe(FORMAT.money);
    expect(tr.getCell(2).font?.bold).toBe(true);
    expect(tr.getCell(3).value).toBe(3);
    expect(tr.getCell(3).numFmt).toBe(FORMAT.number);
    expect(tr.getCell(4).value ?? null).toBeNull();
  });

  it('нийлбэргүй (totals байхгүй) → "Нийт" мөр үүсэхгүй', async () => {
    const ws = await load(await buildReportWorkbook(columns, rows, undefined, meta()));
    expect(ws.rowCount).toBe(EXPORT_HEADER_ROW + rows.length);
  });

  it('олон валют: тайлбартай "Нийт" мөр, нийлбэр тоогүй', async () => {
    const ws = await load(await buildReportWorkbook(columns, rows, undefined, meta({ mixedCurrency: true })));
    const tr = ws.getRow(EXPORT_HEADER_ROW + rows.length + 1);
    expect(tr.getCell(1).value).toBe('Нийт');
    expect(tr.getCell(2).value).toBe('Олон валюттай тул нийлбэр бодоогүй');
    expect(tr.getCell(3).value ?? null).toBeNull();
  });

  it('хоосон мөр: хүчинтэй файл; шүүлтгүй бол "—"', async () => {
    const ws = await load(await buildReportWorkbook(columns, [], undefined, meta({ filterLines: [] })));
    expect(ws.getCell(3, 1).value).toBe('Шүүлт: —');
    expect(ws.getCell(EXPORT_HEADER_ROW, 1).value).toBe('Зээлдэгч');
    expect(String(ws.autoFilter)).toBe('A5:G5');
  });

  it('sheet нэр: хориотой тэмдэгтийг арилгаж, 31 тэмдэгтэд таслана', async () => {
    const ws = await load(await buildReportWorkbook(columns, [], undefined, meta({ title: 'Зээлийн/үлдэгдэл: [дэлгэрэнгүй] тайлан? ' + 'я'.repeat(40) })));
    expect(ws.name.length).toBeLessThanOrEqual(31);
    expect(ws.name).not.toMatch(/[\\/?*[\]:]/);
  });

  describe('өгөгдлийн эх сурвалж (NFR-4/5): core-mock зохиомол өгөгдлийг файлд тодорхой тэмдэглэнэ', () => {
    it('core-mock: гарчиг (улаан bold), хуудасны нэр, огноо, үүсгэсэн мөрөнд "ЗОХИОМОЛ (MOCK)"; толгойн мөр хэвээр 5', async () => {
      const ws = await load(await buildReportWorkbook(columns, rows, undefined, meta({ title: 'Депозит дансны үлдэгдэл', dataSource: 'core-mock' })));
      expect(ws.name).toBe('MOCK Депозит дансны үлдэгдэл');
      expect(ws.getCell(1, 1).value).toBe(`Депозит дансны үлдэгдэл — ${MOCK_DATA_NOTICE}`);
      expect(ws.getCell(1, 1).font?.bold).toBe(true);
      expect(ws.getCell(1, 1).font?.color?.argb).toBe('FFC00000');
      expect(String(ws.getCell(2, 1).value)).toContain('mock өгөгдөл огнооноос хамаарахгүй');
      expect(String(ws.getCell(4, 1).value)).toContain(`Эх сурвалж: ${MOCK_DATA_NOTICE}`);
      expect(ws.getCell(EXPORT_HEADER_ROW, 1).value).toBe('Зээлдэгч');
      expect(ws.getCell(EXPORT_HEADER_ROW + 1, 1).value).toBe('Бат Болд');
    });

    it('origination (эсвэл тодорхойгүй): өөрчлөлтгүй; core: "Эх сурвалж: Core"', async () => {
      for (const dataSource of [undefined, 'origination'] as const) {
        const ws = await load(await buildReportWorkbook(columns, rows, undefined, meta({ dataSource })));
        expect(ws.name).toBe('Туршилтын тайлан');
        expect(ws.getCell(1, 1).value).toBe('Туршилтын тайлан');
        expect(ws.getCell(4, 1).value).toBe('Үүсгэсэн: 2026-10-28T02:00:00.000Z');
      }
      const core = await load(await buildReportWorkbook(columns, rows, undefined, meta({ dataSource: 'core' })));
      expect(core.getCell(4, 1).value).toBe('Үүсгэсэн: 2026-10-28T02:00:00.000Z; Эх сурвалж: Core');
      expect(String(core.getCell(1, 1).value)).not.toContain('MOCK');
    });
  });

  describe('том экспорт (streaming writer)', () => {
    const bigRow = (i: number): ReportRow => ({ name: `Зээлдэгч ${i}`, amount: 1000.5 + i, count: i, ratio: (i % 100) / 100, due: '2026-11-05', state: 'OK', flag: i % 2 === 0 });

    it('олон мөр: бүгд, дарааллаараа, нийлбэр мөр хамт буцаж уншигдана', async () => {
      const n = EXPORT_YIELD_EVERY * 3 + 7;
      const bigRows = Array.from({ length: n }, (_, i) => bigRow(i));
      const ws = await load(await buildReportWorkbook(columns, bigRows, { amount: 42, count: n }, meta()));
      expect(ws.rowCount).toBe(EXPORT_HEADER_ROW + n + 1);
      expect(ws.getRow(EXPORT_HEADER_ROW + 1).getCell(1).value).toBe('Зээлдэгч 0');
      expect(ws.getRow(EXPORT_HEADER_ROW + EXPORT_YIELD_EVERY).getCell(1).value).toBe(`Зээлдэгч ${EXPORT_YIELD_EVERY - 1}`);
      expect(ws.getRow(EXPORT_HEADER_ROW + n).getCell(2).value).toBe(1000.5 + n - 1);
      expect(ws.getRow(EXPORT_HEADER_ROW + n + 1).getCell(1).value).toBe('Нийт');
      expect(ws.getRow(EXPORT_HEADER_ROW + n + 1).getCell(2).value).toBe(42);
      expect(String(ws.autoFilter)).toBe(`A5:G${EXPORT_HEADER_ROW + n}`);
    }, 60_000);

    it('EXPORT_YIELD_EVERY мөр тутамд event loop-д амс өгнө (бусад хүсэлт гацахгүй)', async () => {
      const n = EXPORT_YIELD_EVERY * 4;
      const count = async (rowCount: number): Promise<number> => {
        const spy = vi.spyOn(globalThis, 'setImmediate');
        try { await buildReportWorkbook(columns, Array.from({ length: rowCount }, (_, i) => bigRow(i)), undefined, meta()); return spy.mock.calls.length; } finally { spy.mockRestore(); }
      };
      const base = await count(0);
      expect((await count(n)) - base).toBeGreaterThanOrEqual(4);
    }, 60_000);

    it('20,000 мөрийн бичилт event loop-ийг удаан гацаахгүй (өмнө нь синхрон ExcelJS ≈ секундээр гацаж байсан)', async () => {
      const bigRows = Array.from({ length: 20_000 }, (_, i) => bigRow(i));
      let worst = 0; let last = performance.now();
      const timer = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last - 10); last = now; }, 10);
      try {
        const buf = await buildReportWorkbook(columns, bigRows, undefined, meta());
        await new Promise((r) => setTimeout(r, 30)); // төгсгөлийн блок timer-д тусах боломж
        expect(buf.length).toBeGreaterThan(100_000);
      } finally {
        clearInterval(timer);
      }
      expect(worst, `хамгийн урт гацалт ${Math.round(worst)} мс`).toBeLessThan(1000); // streaming: ≈ 0.15с; өмнөх синхрон бичилт ≥ 2с
    }, 120_000);
  });
});
