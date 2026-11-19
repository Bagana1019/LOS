import { Logger } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { ReportKey, type OrgDirectory } from '@los/contracts';
import { actors, hasTestDb } from '../../test-utils/factories';
import { ORG_DIRECTORY_TTL_MS, directoryName, type OrgDirectorySource } from '../../shared/org-directory';
import { EXPORT_HEADER_ROW, XLSX_MIME } from './excel.exporter';
import { bootReport, getReport, resetAndSeed, type ReportEnv } from './report.test-helpers';

// Excel экспорт (бодит SQL, 8 тайлан): салбар / ЗЭЗ-ийн багана UUID биш нэр. Fixture-ийн id: branch-1/2, officer-1/2.
const WIDE = { dateFrom: '2000-01-01', dateTo: '2100-01-01', pageSize: 100 };
const NAMES: OrgDirectory = { branches: { 'branch-1': 'Төв салбар', 'branch-2': 'Баянзүрх салбар' }, users: { 'officer-1': 'Бат Болд', 'officer-2': 'Сараа Дорж' } };
const WITH_IDS = ReportKey.filter((k) => k !== 'deposit-balances'); // депозит: Core өгөгдөл, салбар/ЗЭЗ баганагүй

describe.skipIf(!hasTestDb)('report: Excel экспортын салбар/ЗЭЗ-ийн нэр (DB)', () => {
  let env: ReportEnv;
  const admin = actors.admin();
  const state: { value: OrgDirectory | Error } = { value: NAMES };
  const source: OrgDirectorySource & { fetch: ReturnType<typeof vi.fn> } = {
    fetch: vi.fn(async () => { if (state.value instanceof Error) throw state.value; return state.value; }),
  };
  let warn: ReturnType<typeof vi.spyOn>;
  let tick = 0;

  beforeAll(async () => { env = await bootReport({ directory: source }); });
  afterAll(async () => { await env.t.close(); });
  beforeEach(async () => {
    await resetAndSeed(env);
    // resetAndSeed цагийг ижил агшинд буцаадаг тул тест бүрт өөр агшин (TTL-ээс их алхамтай) — лавлахын кэш хуучирч шинээр авна
    env.t.clock.set(new Date(Date.parse('2026-10-28T02:00:00Z') + ++tick * (ORG_DIRECTORY_TTL_MS + 1)));
    source.fetch.mockClear();
    state.value = NAMES;
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => { warn.mockRestore(); });

  const download = (key: string, query: Record<string, string | number>) => env.http().get(`/api/reports/${key}/export`).query(query).set(admin).buffer(true)
    .parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });

  /** Excel-ийн (баганы толгой → утгууд). */
  async function sheet(key: string, query: Record<string, string | number> = WIDE): Promise<Record<string, string[]>> {
    const res = await download(key, query);
    expect(res.status, key).toBe(200);
    expect(String(res.headers['content-type'])).toContain(XLSX_MIME);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as unknown as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    const out: Record<string, string[]> = {};
    for (let c = 1; c <= ws.columnCount; c++) {
      const label = String(ws.getRow(EXPORT_HEADER_ROW).getCell(c).value);
      out[label] = [];
      for (let r = EXPORT_HEADER_ROW + 1; r <= ws.rowCount; r++) {
        if (ws.getRow(r).getCell(1).value === 'Нийт') break;
        out[label].push(String(ws.getRow(r).getCell(c).value ?? ''));
      }
    }
    return out;
  }

  it.each(WITH_IDS)('%s: Салбар/ЗЭЗ багана нь JSON-ийн id-г лавлахаар хөрвүүлсэн нэр, UUID биш', async (key) => {
    const json = await getReport(env, admin, key, WIDE);
    const cols = await sheet(key);
    expect(json.total).toBeGreaterThan(0);
    expect(cols['Салбар']).toEqual(json.rows.map((r) => directoryName(NAMES.branches, String(r.branchId))));
    expect(cols['ЗЭЗ']).toEqual(json.rows.map((r) => directoryName(NAMES.users, String(r.officerId))));
    for (const v of cols['Салбар']!) expect(Object.values(NAMES.branches), `${key} салбар "${v}"`).toContain(v);
    for (const v of cols['ЗЭЗ']!) expect([...Object.values(NAMES.users), 'Систем'], `${key} ЗЭЗ "${v}"`).toContain(v);
  });

  it('лавлахад байхгүй id → id хэвээр (зөвхөн branch-2 нэртэй)', async () => {
    state.value = { branches: { 'branch-2': 'Баянзүрх салбар' }, users: {} };
    const cols = await sheet('outstanding-balance');
    expect(new Set(cols['Салбар'])).toEqual(new Set(['branch-1', 'Баянзүрх салбар']));
    expect(cols['ЗЭЗ']!.every((v) => v.startsWith('officer-') || v === 'Систем')).toBe(true);
  });

  it('лавлах унавал экспорт 200, id-тай, warning лог; report_run аудит бичигдэнэ', async () => {
    state.value = new Error('gateway сервис руу холбогдож чадсангүй');
    const cols = await sheet('outstanding-balance');
    expect(new Set(cols['Салбар'])).toEqual(new Set(['branch-1', 'branch-2']));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await env.t.prisma.reportRun.count({ where: { reportKey: 'outstanding-balance' } })).toBe(1);
  });

  it('batch: олон мөртэй экспортод лавлахыг нэг л удаа дуудна; депозит (id баганагүй) тайланд огт дуудахгүй', async () => {
    const cols = await sheet('outstanding-balance');
    expect(cols['Салбар']!.length).toBeGreaterThan(1);
    expect(source.fetch).toHaveBeenCalledTimes(1);
    source.fetch.mockClear();
    await sheet('deposit-balances', {});
    expect(source.fetch).not.toHaveBeenCalled();
  });

  it('"Шүүлт" мөрөнд салбар = нэр; JSON (UI) id хэвээр', async () => {
    const res = await download('outstanding-balance', { ...WIDE, branchId: 'branch-1' });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as unknown as ArrayBuffer);
    expect(String(wb.worksheets[0]!.getRow(3).getCell(1).value)).toContain('Салбар = Төв салбар');
    const json = await getReport(env, admin, 'outstanding-balance', { ...WIDE, branchId: 'branch-1' });
    expect(new Set(json.rows.map((r) => r.branchId))).toEqual(new Set(['branch-1']));
  });
});
