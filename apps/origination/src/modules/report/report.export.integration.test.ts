import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { ReportKey, type ReportColumn } from '@los/contracts';
import { maskRegisterNo } from '@los/database';
import { actors, hasTestDb } from '../../test-utils/factories';
import { labelOf } from './report-labels';
import { EXPORT_HEADER_ROW, FORMAT, MOCK_DATA_NOTICE, XLSX_MIME } from './excel.exporter';
import { bootReport, getReport, resetAndSeed, type ReportEnv } from './report.test-helpers';

const WIDE = { dateFrom: '2000-01-01', dateTo: '2100-01-01' };
type Q = Record<string, string | number>;
interface Download { status: number; headers: Record<string, string>; body: Buffer; json: Record<string, unknown> }

describe.skipIf(!hasTestDb)('report: Excel экспорт (HTTP)', () => {
  let env: ReportEnv;
  const admin = actors.admin();
  beforeAll(async () => { env = await bootReport(); });
  afterAll(async () => { await env.t.close(); });
  beforeEach(async () => { await resetAndSeed(env); });

  const download = async (headers: Record<string, string>, key: string, query: Q = {}): Promise<Download> => {
    const res = await env.http().get(`/api/reports/${key}/export`).query(query).set(headers)
      .buffer(true).parse((r, cb) => { const chunks: Buffer[] = []; r.on('data', (c: Buffer) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
    const isXlsx = String(res.headers['content-type']).startsWith(XLSX_MIME);
    return { status: res.status, headers: res.headers as Record<string, string>, body: isXlsx ? (res.body as Buffer) : Buffer.alloc(0), json: isXlsx ? {} : JSON.parse((res.body as Buffer).toString('utf8')) };
  };
  const open = async (buf: Buffer) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf as unknown as ArrayBuffer); return wb; };
  const defs = async (): Promise<Array<{ key: string; title: string; columns: ReportColumn[] }>> => (await env.http().get('/api/reports').set(admin)).body;

  /** Өгөгдлийн мөрүүд (толгойн дараа, "Нийт" мөрийг хасаад). */
  function dataRows(ws: ExcelJS.Worksheet): ExcelJS.Row[] {
    const out: ExcelJS.Row[] = [];
    for (let r = EXPORT_HEADER_ROW + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      if (row.getCell(1).value === 'Нийт') break;
      out.push(row);
    }
    return out;
  }
  const totalsRow = (ws: ExcelJS.Worksheet): ExcelJS.Row | null => {
    for (let r = EXPORT_HEADER_ROW + 1; r <= ws.rowCount; r++) if (ws.getRow(r).getCell(1).value === 'Нийт') return ws.getRow(r);
    return null;
  };
  const ymd = (d: unknown): string => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d));

  describe('хариуны толгой', () => {
    it('xlsx MIME, attachment, UTF-8 filename (LOS_<key>_<asOf YYYYMMDD>.xlsx), Content-Length', async () => {
      const res = await download(admin, 'outstanding-balance');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain(XLSX_MIME);
      expect(res.headers['content-disposition']).toBe(`attachment; filename="LOS_outstanding-balance_20261028.xlsx"; filename*=UTF-8''LOS_outstanding-balance_20261028.xlsx`);
      expect(Number(res.headers['content-length'])).toBe(res.body.length);
      expect(res.body.subarray(0, 2).toString()).toBe('PK'); // zip (xlsx)
      const hist = await download(admin, 'overdue-loans', { asOf: '2026-09-20' });
      expect(hist.headers['content-disposition']).toContain(`filename*=UTF-8''LOS_overdue-loans_20260920.xlsx`);
    });

    it('эрх: 401 / 403 / 404 / 400 нь xlsx биш, аудит бичигдэхгүй', async () => {
      expect((await download(actors.anonymous(), 'overdue-loans')).status).toBe(401);
      expect((await download({ 'x-user-id': 'u', 'x-roles': 'CUSTOMER', 'x-org-id': admin['x-org-id'] }, 'overdue-loans')).status).toBe(403);
      const nf = await download(admin, 'nope');
      expect(nf.status).toBe(404);
      expect(nf.json.code).toBe('REPORT_NOT_FOUND');
      expect((await download(admin, 'overdue-loans', { sortBy: 'nope' })).status).toBe(400);
      expect((await download(admin, 'upcoming-repayments', { dateFrom: '2026-10-02', dateTo: '2026-10-01' })).status).toBe(400);
      expect(await env.t.prisma.reportRun.count()).toBe(0);
    });
  });

  describe('файлын бүтэц (outstanding-balance)', () => {
    it('гарчиг, толгой, freeze, autofilter, формат, өргөн, нийлбэр, кирилл, нуугдмал регистр', async () => {
      const def = (await defs()).find((d) => d.key === 'outstanding-balance')!;
      const json = await getReport(env, admin, 'outstanding-balance');
      const wb = await open((await download(admin, 'outstanding-balance')).body);
      expect(wb.worksheets).toHaveLength(1);
      const ws = wb.worksheets[0];
      expect(ws.name).toBe('Зээлийн үлдэгдлийн дэлгэрэнгүй'.slice(0, 31));

      // гарчгийн 4 мөр
      expect(ws.getCell(1, 1).value).toBe(def.title);
      expect(ws.getCell(1, 1).font?.bold).toBe(true);
      expect(String(ws.getCell(2, 1).value)).toContain('2026-10-28');
      expect(String(ws.getCell(3, 1).value)).toMatch(/^Шүүлт: /);
      expect(String(ws.getCell(4, 1).value)).toMatch(/^Үүсгэсэн: 2026-10-28T02:00:00/);

      // толгойн мөр
      def.columns.forEach((c, i) => {
        const cell = ws.getCell(EXPORT_HEADER_ROW, i + 1);
        expect(cell.value, c.key).toBe(c.label);
        expect(cell.font?.bold, c.key).toBe(true);
        expect(ws.getColumn(i + 1).width, c.key).toBe(c.width ?? 14);
      });
      expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: EXPORT_HEADER_ROW });
      expect(ws.autoFilter).toBeTruthy();
      // уншихад "A5:O11" мөр хэлбэртэй (толгойн мөрөөс сүүлийн өгөгдлийн мөр хүртэл, нийлбэр мөргүй)
      expect(String(ws.autoFilter)).toBe(`A${EXPORT_HEADER_ROW}:${ws.getColumn(def.columns.length).letter}${EXPORT_HEADER_ROW + 6}`);

      // өгөгдөл: JSON-той яг ижил, формат
      const rows = dataRows(ws);
      expect(rows).toHaveLength(json.rows.length);
      expect(rows).toHaveLength(6);
      const idx = (key: string) => def.columns.findIndex((c) => c.key === key) + 1;
      rows.forEach((row, r) => {
        for (const c of def.columns) {
          const cell = row.getCell(idx(c.key));
          const v = json.rows[r][c.key];
          if (v === null) { expect(cell.value ?? null, `${c.key}#${r}`).toBeNull(); continue; }
          if (c.type === 'money') { expect(cell.numFmt).toBe(FORMAT.money); expect(cell.value).toBe(v); }
          else if (c.type === 'date') { expect(cell.numFmt).toBe(FORMAT.date); expect(cell.value).toBeInstanceOf(Date); expect(ymd(cell.value)).toBe(v); }
          else if (c.type === 'status') expect(cell.value).toBe(labelOf(c.options, String(v)));
          else expect(cell.value, `${c.key}#${r}`).toBe(v);
        }
      });
      // кирилл нэр зөв
      const names = rows.map((r) => r.getCell(idx('customerName')).value);
      expect(names).toContain('Бат Болд');
      // регистр нуугдмал: бүтэн регистр файлын ямар ч нүдэнд байхгүй
      const all: string[] = [];
      ws.eachRow((row) => row.eachCell((cell) => all.push(String(cell.value))));
      expect(all.join('\n')).not.toMatch(/УБ9000000\d/);
      expect(rows.map((r) => r.getCell(idx('registerNo')).value)).toContain(maskRegisterNo('УБ90000001'));

      // нийлбэр мөр
      const tr = totalsRow(ws)!;
      expect(tr.number).toBe(EXPORT_HEADER_ROW + 6 + 1);
      expect(tr.getCell(1).font?.bold).toBe(true);
      expect(json.mixedCurrency).toBe(true); // MNT + USD холилдсон тул нийлбэргүй
      expect(tr.getCell(2).value).toBe('Олон валюттай тул нийлбэр бодоогүй');
    });

    it('нэг валют → нийлбэр мөр JSON totals-той ижил, формат тавигдсан', async () => {
      const q = { currency: 'MNT' };
      const json = await getReport(env, admin, 'outstanding-balance', q);
      const def = (await defs()).find((d) => d.key === 'outstanding-balance')!;
      const ws = (await open((await download(admin, 'outstanding-balance', q)).body)).worksheets[0];
      const tr = totalsRow(ws)!;
      expect(json.totals).toBeTruthy();
      for (const [key, total] of Object.entries(json.totals!)) {
        const i = def.columns.findIndex((c) => c.key === key) + 1;
        expect(tr.getCell(i).value, key).toBe(total);
        expect(tr.getCell(i).numFmt).toBe(FORMAT.money);
        expect(tr.getCell(i).font?.bold).toBe(true);
      }
      expect(json.totals).toMatchObject({ disbursedAmount: 2_650_000, paidPrincipal: 140_000, outstandingPrincipal: 2_510_000 });
      expect(String(ws.getCell(3, 1).value)).toBe('Шүүлт: Валют = MNT (₮)');
    });

    it('хувь (percent) ба тоо (number) баганы формат: collateral-assets LTV, pipeline completedSteps', async () => {
      const cdef = (await defs()).find((d) => d.key === 'collateral-assets')!;
      const pct = cdef.columns.filter((c) => c.type === 'percent').map((c) => c.key);
      expect(pct.length).toBeGreaterThan(0);
      const ws = (await open((await download(admin, 'collateral-assets', WIDE)).body)).worksheets[0];
      const rows = dataRows(ws);
      const json = await getReport(env, admin, 'collateral-assets', { ...WIDE, pageSize: 100 });
      expect(rows).toHaveLength(json.rows.length);
      for (const key of pct) {
        const i = cdef.columns.findIndex((c) => c.key === key) + 1;
        const cell = rows.find((r) => r.getCell(i).value !== null)!.getCell(i);
        expect(cell.numFmt).toBe(FORMAT.percent);
        expect(typeof cell.value).toBe('number');
        expect(cell.value as number).toBeLessThanOrEqual(5); // харьцаа (×100 хийгээгүй)
      }
      const pdef = (await defs()).find((d) => d.key === 'pipeline-progress')!;
      for (const c of pdef.columns.filter((x) => x.type === 'number')) {
        const wsP = (await open((await download(admin, 'pipeline-progress')).body)).worksheets[0];
        const i = pdef.columns.findIndex((x) => x.key === c.key) + 1;
        expect(dataRows(wsP)[0].getCell(i).numFmt).toBe(FORMAT.number);
      }
    });

    it('хоосон үр дүн: толгойтой хүчинтэй файл, өгөгдлийн мөргүй', async () => {
      const res = await download(admin, 'overdue-loans', { search: 'NO-SUCH-LOAN' });
      expect(res.status).toBe(200);
      const ws = (await open(res.body)).worksheets[0];
      expect(dataRows(ws)).toHaveLength(0);
      expect(ws.getCell(EXPORT_HEADER_ROW, 1).value).toBe('Гэрээний дугаар');
      expect(String(ws.getCell(3, 1).value)).toContain('NO-SUCH-LOAN');
      expect(await env.t.prisma.reportRun.count()).toBe(1);
      expect((await env.t.prisma.reportRun.findFirst())!.rowCount).toBe(0);
    });
  });

  describe('JSON ба xlsx нэг логик (мөрийн тоо, утга)', () => {
    it.each([...ReportKey])('%s: xlsx мөр = JSON мөр (тоо, дараалал, утга), нийлбэр мөр = totals', async (key) => {
      const query: Q = { ...WIDE, pageSize: 100 };
      const json = await getReport(env, admin, key, query);
      const def = (await defs()).find((d) => d.key === key)!;
      const res = await download(admin, key, query);
      expect(res.status).toBe(200);
      const ws = (await open(res.body)).worksheets[0];
      const rows = dataRows(ws);
      expect(json.total).toBeGreaterThan(0);
      expect(rows).toHaveLength(json.total);
      expect(rows).toHaveLength(json.rows.length);
      rows.forEach((row, r) => def.columns.forEach((c, i) => {
        const v = json.rows[r][c.key];
        const cell = row.getCell(i + 1).value;
        const where = `${key}.${c.key}#${r}`;
        if (v === null || v === undefined) return expect(cell ?? null, where).toBeNull();
        if (c.type === 'date') return expect(ymd(cell), where).toBe(v);
        if (c.type === 'status') return expect(cell, where).toBe(labelOf(c.options, String(v)));
        expect(cell, where).toBe(v);
      }));
      const tr = totalsRow(ws);
      if (json.totals) {
        expect(tr).not.toBeNull();
        for (const [k, total] of Object.entries(json.totals)) expect(tr!.getCell(def.columns.findIndex((c) => c.key === k) + 1).value, `${key}.${k}`).toBe(total);
      } else if (json.mixedCurrency) {
        expect(tr!.getCell(2).value).toBe('Олон валюттай тул нийлбэр бодоогүй');
      }
      // бүтэн регистр хэзээ ч файлд байхгүй
      const text: string[] = [];
      ws.eachRow((row) => row.eachCell((cell) => text.push(String(cell.value))));
      expect(text.join('\n')).not.toMatch(/УБ9000000\d/);
    });

    it('эрэмбэ шүүлт экспортод мөн хэрэгжинэ (sortBy/sortDir)', async () => {
      const q = { sortBy: 'contractNo', sortDir: 'desc' };
      const json = await getReport(env, admin, 'outstanding-balance', q);
      const ws = (await open((await download(admin, 'outstanding-balance', q)).body)).worksheets[0];
      expect(dataRows(ws).map((r) => r.getCell(1).value)).toEqual(json.rows.map((r) => r.contractNo));
      expect(dataRows(ws)[0].getCell(1).value).toBe('B10026LN');
    });

    it('хуудаслалтыг үл тооно: pageSize=10 үед ч бүх мөр', async () => {
      const ws = (await open((await download(admin, 'outstanding-balance', { pageSize: 10 })).body)).worksheets[0];
      expect(dataRows(ws)).toHaveLength(6);
      const wsMore = (await open((await download(admin, 'pipeline-progress', { page: 3, pageSize: 10 })).body)).worksheets[0];
      expect(dataRows(wsMore)).toHaveLength(10);
    });
  });

  describe('хүрээ (NFR-3)', () => {
    it('ЗЭЗ зөвхөн өөрийн мөр экспортолно; аудитад хүрээ ба хэрэглэгч', async () => {
      const res = await download(actors.officer('officer-2'), 'outstanding-balance');
      const ws = (await open(res.body)).worksheets[0];
      expect(dataRows(ws).map((r) => r.getCell(1).value).sort()).toEqual(['B10026LC', 'B10026LN']);
      const run = (await env.t.prisma.reportRun.findFirst())!;
      expect(run.runBy).toBe('officer-2');
      expect(run.rowCount).toBe(2);
      expect((run.paramsJson as { scope: unknown }).scope).toEqual({ branchId: null, officerId: 'officer-2' });
    });

    it('салбарын захирал: өөр салбарын branchId-г үл тооно', async () => {
      const ws = (await open((await download(actors.branchManager('bm-1', 'branch-1'), 'outstanding-balance', { branchId: 'branch-2' })).body)).worksheets[0];
      expect(dataRows(ws)).toHaveLength(4);
      expect((await env.t.prisma.reportRun.findFirst())!.paramsJson).toMatchObject({ scope: { branchId: 'branch-1', officerId: null } });
    });
  });

  describe('аудит (report_run, NFR-4/5)', () => {
    it('амжилттай экспорт бүрт 1 мөр: key, format, params, rowCount, runBy', async () => {
      await download(admin, 'overdue-loans', { currency: 'MNT', branchId: 'branch-1', sortBy: 'dpd', sortDir: 'desc' });
      const runs = await env.t.prisma.reportRun.findMany();
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ reportKey: 'overdue-loans', format: 'XLSX', rowCount: 1, runBy: admin['x-user-id'], orgId: admin['x-org-id'] });
      expect(runs[0].paramsJson).toMatchObject({
        query: { asOf: '2026-10-28', currency: 'MNT', branchId: 'branch-1', sortBy: 'dpd', sortDir: 'desc', search: null },
        scope: { branchId: null, officerId: null }, registerMasked: true,
      });
      expect(runs[0].runAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    });

    it('хайлтын утга (регистр) аудитад нуугдмал', async () => {
      await download(admin, 'outstanding-balance', { search: 'УБ90000003' });
      const run = (await env.t.prisma.reportRun.findFirst())!;
      const q = (run.paramsJson as { query: { search: string } }).query;
      expect(q.search).toBe(maskRegisterNo('УБ90000003'));
      expect(JSON.stringify(run.paramsJson)).not.toContain('90000003');
    });

    it('регистр хэлбэртэй хайлт Excel-ийн толгойд ч нуугдмал; нэр/гэрээний хайлт хэвээр', async () => {
      const reg = (await open((await download(admin, 'outstanding-balance', { search: 'УБ90000003' })).body)).worksheets[0];
      expect(String(reg.getCell(3, 1).value)).toBe(`Шүүлт: Хайх (регистр, гэрээний дугаар, нэр) = ${maskRegisterNo('УБ90000003')}`);
      const name = (await open((await download(admin, 'outstanding-balance', { search: 'Болд' })).body)).worksheets[0];
      expect(String(name.getCell(3, 1).value)).toContain('= Болд');
    });

    it('JSON харах (GET reports/:key) нь аудитад бичигдэхгүй', async () => {
      await getReport(env, admin, 'overdue-loans');
      expect(await env.t.prisma.reportRun.count()).toBe(0);
    });

    it('зэрэгцээ 2 экспорт → 2 аудит мөр, хоёулаа ижил файл', async () => {
      const [a, b] = await Promise.all([download(admin, 'overdue-loans', { currency: 'MNT' }), download(actors.approver(), 'overdue-loans', { currency: 'MNT' })]);
      expect(a.status).toBe(200); expect(b.status).toBe(200);
      const rowsOf = async (d: Download) => dataRows((await open(d.body)).worksheets[0]).map((r) => r.getCell(1).value);
      expect(await rowsOf(a)).toEqual(await rowsOf(b));
      expect(await env.t.prisma.reportRun.count()).toBe(2);
      const again = await download(admin, 'overdue-loans', { currency: 'MNT' });
      expect(again.status).toBe(200);
      expect(await env.t.prisma.reportRun.count()).toBe(3); // давтан экспорт бүр шинэ аудит (идемпотент өгөгдөл, давтагдахгүй мөр биш)
    });
  });

  describe('report.max_export_rows', () => {
    const setMax = async (v: number) => {
      await env.t.prisma.setting.upsert({ where: { orgId_key: { orgId: admin['x-org-id'], key: 'report.max_export_rows' } }, create: { orgId: admin['x-org-id'], key: 'report.max_export_rows', valueJson: v }, update: { valueJson: v } });
    };

    it('мөрийн тоо хязгаараас хэтэрвэл 422 EXPORT_TOO_LARGE, аудитгүй; яг хязгаартай тэнцүү бол OK', async () => {
      await setMax(5);
      const res = await download(admin, 'outstanding-balance');
      expect(res.status).toBe(422);
      expect(res.json.code).toBe('EXPORT_TOO_LARGE');
      expect(String(res.json.message)).toContain('6');
      expect(await env.t.prisma.reportRun.count()).toBe(0);
      // шүүлтээр нарийсгавал болно
      expect((await download(admin, 'outstanding-balance', { branchId: 'branch-2' })).status).toBe(200);
      await setMax(6);
      const ok = await download(admin, 'outstanding-balance');
      expect(ok.status).toBe(200);
      expect(dataRows((await open(ok.body)).worksheets[0])).toHaveLength(6);
      expect(await env.t.prisma.reportRun.count()).toBe(2);
    });

    it('буруу тохиргоо (0, сөрөг, тоо биш) → анхдагч 50,000', async () => {
      for (const v of [0, -3]) { await setMax(v); expect((await download(admin, 'outstanding-balance')).status).toBe(200); }
      await env.t.prisma.setting.update({ where: { orgId_key: { orgId: admin['x-org-id'], key: 'report.max_export_rows' } }, data: { valueJson: 'abc' } });
      expect((await download(admin, 'outstanding-balance')).status).toBe(200);
    });

    it('JSON тайланд хязгаар үйлчлэхгүй (хуудаслалттай)', async () => {
      await setMax(1);
      expect((await getReport(env, admin, 'outstanding-balance')).total).toBe(6);
    });
  });

  describe('deposit-balances (Core mock)', () => {
    it('экспорт: JSON-той ижил, данс нуугдмал', async () => {
      const json = await getReport(env, admin, 'deposit-balances', { pageSize: 100 });
      const def = (await defs()).find((d) => d.key === 'deposit-balances')!;
      const res = await download(admin, 'deposit-balances');
      expect(res.status).toBe(200);
      const ws = (await open(res.body)).worksheets[0];
      expect(dataRows(ws)).toHaveLength(json.rows.length);
      const text: string[] = [];
      ws.eachRow((row) => row.eachCell((cell) => text.push(String(cell.value))));
      const joined = text.join('\n');
      for (const row of json.rows) {
        const acc = String(row.accountNo ?? '');
        if (acc) expect(joined).toContain(acc); // JSON-д нуугдмал дугаар файлд ч яг ижил нуугдмал
      }
      expect(def.columns.some((c) => c.key === 'accountNo')).toBe(true);
      const accountCell = dataRows(ws)[0].getCell(def.columns.findIndex((c) => c.key === 'accountNo') + 1).value;
      expect(String(accountCell)).toContain('*');
    });
  });

  // Finding: mock (зохиомол) үлдэгдэл Excel/JSON/аудитад ямар ч тэмдэглэгээгүй байсан тул жинхэнэ тайлангаас ялгагдахгүй, хойно тогтоох боломжгүй байв.
  describe('өгөгдлийн эх сурвалж: mock (зохиомол) өгөгдлийн тэмдэглэгээ', () => {
    afterEach(() => { vi.unstubAllEnvs(); });

    it('JSON: deposit-balances dataSource="core-mock", бусад тайлан "origination"', async () => {
      expect((await getReport(env, admin, 'deposit-balances')).dataSource).toBe('core-mock');
      for (const key of ReportKey.filter((k) => k !== 'deposit-balances')) expect((await getReport(env, admin, key, WIDE)).dataSource, key).toBe('origination');
    });

    it('Excel: гарчиг, хуудасны нэр, огноо, эх сурвалжийн мөрөнд "ЗОХИОМОЛ (MOCK)"; толгой/өгөгдлийн байрлал өөрчлөгдөөгүй', async () => {
      const json = await getReport(env, admin, 'deposit-balances', { pageSize: 100 });
      const res = await download(admin, 'deposit-balances');
      expect(res.status).toBe(200);
      const ws = (await open(res.body)).worksheets[0];
      expect(ws.name).toBe('MOCK Депозит дансны үлдэгдэл');
      expect(ws.getCell(1, 1).value).toBe(`Депозит дансны үлдэгдэл — ${MOCK_DATA_NOTICE}`);
      expect(String(ws.getCell(2, 1).value)).toContain('mock өгөгдөл огнооноос хамаарахгүй');
      expect(String(ws.getCell(4, 1).value)).toContain(MOCK_DATA_NOTICE);
      expect(ws.getCell(EXPORT_HEADER_ROW, 1).value).toBe('Харилцагч');
      expect(dataRows(ws)).toHaveLength(json.rows.length);
    });

    it('Excel: жинхэнэ (origination) тайлан MOCK тэмдэглэгээгүй', async () => {
      const ws = (await open((await download(admin, 'overdue-loans')).body)).worksheets[0];
      const head = [1, 2, 3, 4].map((r) => String(ws.getCell(r, 1).value)).join('\n');
      expect(head).not.toMatch(/MOCK|ЗОХИОМОЛ/);
      expect(ws.name).not.toContain('MOCK');
    });

    it('аудит: report_run.params_json.dataSource бүртгэгдэнэ (core-mock | origination)', async () => {
      await download(admin, 'deposit-balances');
      await download(admin, 'overdue-loans');
      const runs = await env.t.prisma.reportRun.findMany({ orderBy: { runAt: 'asc' } });
      expect(runs.map((r) => [r.reportKey, (r.paramsJson as { dataSource?: string }).dataSource])).toEqual([['deposit-balances', 'core-mock'], ['overdue-loans', 'origination']]);
    });

    it('production + mock горим: deposit-balances экспорт 501 (файл, аудит үүсэхгүй); JSON харалт болон бусад тайлангийн экспорт хэвийн', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      const res = await download(admin, 'deposit-balances');
      expect(res.status).toBe(501);
      expect(res.json.code).toBe('INTEGRATION_NOT_IMPLEMENTED');
      expect(String(res.json.message)).toContain('mock');
      expect(await env.t.prisma.reportRun.count()).toBe(0);
      expect((await getReport(env, admin, 'deposit-balances')).dataSource).toBe('core-mock');
      expect((await download(admin, 'overdue-loans')).status).toBe(200);
      expect(await env.t.prisma.reportRun.count()).toBe(1);
    });
  });
});
