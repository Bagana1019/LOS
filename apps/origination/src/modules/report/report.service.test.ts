import { HttpStatus } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { Logger } from '@nestjs/common';
import type { ReportColumn, ReportExportQuery, ReportFilterDef, ReportQuery, ReportRow } from '@los/contracts';
import type { Clock } from '@los/nest-common';
import type { PrismaService } from '../../prisma.service';
import type { RequestContext } from '@los/contracts';
import type { OrgSettings } from '../../shared/org-settings';
import { OrgDirectoryService, type OrgDirectorySource } from '../../shared/org-directory';
import type { CoreDepositPort } from '../../integrations/core-deposit/core-deposit.port';
import { EXPORT_CONCURRENCY, EXPORT_MAX_QUEUE, ReportService } from './report.service';
import { EXPORT_STATEMENT_TIMEOUT_MS } from './report-db';
import { EXPORT_HEADER_ROW } from './excel.exporter';
import { F, col } from './report-filters';
import type { ReportRegistry } from './report-registry';
import type { ReportDefinition, ReportInput, ReportRunResult } from './report-types';

// Service-ийн ачааллын хамгаалалт (export semaphore, мөр уншихаас өмнөх хязгаар, mock-ийн тэмдэглэгээ, timeout → 504)-ийг DB-гүйгээр, детерминистик шалгана.
const ctx: RequestContext = { userId: 'admin-1', roles: ['ADMIN'], branchId: null, orgId: 'org-1', customerId: null, correlationId: 'c-1' };
const exportQuery = { sortDir: 'asc' } as ReportExportQuery;
const jsonQuery = { sortDir: 'asc', page: 1, pageSize: 20 } as ReportQuery;

function fixture(o: { source?: 'origination' | 'core-mock' | 'core'; max?: number; run?: (input: ReportInput) => Promise<ReportRunResult>; columns?: ReportColumn[]; filters?: ReportFilterDef[]; directory?: OrgDirectorySource['fetch'] } = {}) {
  const runs: ReportInput[] = [];
  const def: ReportDefinition = {
    key: 'overdue-loans', title: 'Туршилт', description: 'd', columns: o.columns ?? [col('name', 'Нэр', 'string')], filters: o.filters ?? [], defaultSort: { sortBy: 'name', sortDir: 'asc' }, totalKeys: [],
    dataSource: () => o.source ?? 'origination',
    run: async (_deps, input) => { runs.push(input); return o.run ? o.run(input) : { rows: [{ name: 'А' }], total: 1 }; },
  };
  const created: Array<{ data: { paramsJson: Record<string, unknown>; rowCount: number } }> = [];
  const prisma = { product: { findMany: async () => [] }, reportRun: { create: async (args: (typeof created)[number]) => { created.push(args); return {}; } } } as unknown as PrismaService;
  const clock = { now: () => new Date('2026-10-28T02:00:00Z'), today: () => '2026-10-28' } as unknown as Clock;
  const settings = { get: async () => o.max ?? 50_000 } as unknown as OrgSettings;
  const registry = { get: (k: string) => (k === def.key ? def : undefined), all: () => [def], has: (k: string) => k === def.key } as unknown as ReportRegistry;
  const deposit = { mode: 'mock', listBalances: async () => [] } as unknown as CoreDepositPort;
  const directory = { fetch: vi.fn(o.directory ?? (async () => ({ branches: {}, users: {} }))) };
  return { service: new ReportService(prisma, clock, settings, registry, deposit, new OrgDirectoryService(directory, clock as never)), runs, created, directory };
}

const deferred = <T = void>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const settle = async (p: Promise<unknown>) => p.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error: error as { getStatus?: () => number; getResponse?: () => { code?: string } } }));

describe('ReportService.export: ачааллын хамгаалалт', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it(`зэрэг ${EXPORT_CONCURRENCY} экспорт ажиллана, ${EXPORT_MAX_QUEUE} нь дараалалд, илүү нь 429 EXPORT_BUSY (процесс санах ой/pool-оо барагдуулахгүй)`, async () => {
    const gate = deferred();
    let running = 0; let peak = 0;
    const { service } = fixture({ run: async () => { running++; peak = Math.max(peak, running); await gate.promise; running--; return { rows: [{ name: 'А' }], total: 1 }; } });
    const total = EXPORT_CONCURRENCY + EXPORT_MAX_QUEUE + 3;
    const all = Array.from({ length: total }, () => settle(service.export(ctx, 'overdue-loans', exportQuery)));
    await new Promise((r) => setTimeout(r, 30)); // maxExportRows (await) → prepare → slot
    gate.resolve();
    const results = await Promise.all(all);
    const busy = results.filter((r) => !r.ok);
    expect(busy).toHaveLength(3);
    for (const r of busy) {
      if (r.ok) continue;
      expect(r.error.getStatus?.()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect(r.error.getResponse?.().code).toBe('EXPORT_BUSY');
    }
    expect(results.filter((r) => r.ok)).toHaveLength(EXPORT_CONCURRENCY + EXPORT_MAX_QUEUE);
    expect(peak).toBe(EXPORT_CONCURRENCY);
  });

  it('дараалал чөлөөлөгдсөний дараа дахин хэвийн (slot алдагдахгүй)', async () => {
    const { service } = fixture();
    for (let i = 0; i < EXPORT_CONCURRENCY + EXPORT_MAX_QUEUE + 2; i++) expect((await service.export(ctx, 'overdue-loans', exportQuery)).rowCount).toBe(1);
  });

  it('буруу түлхүүр/шүүлт нь slot эзлэхээс өмнө 404/400-аар няцна', async () => {
    const gate = deferred();
    const { service } = fixture({ run: async () => { await gate.promise; return { rows: [], total: 0 }; } });
    const busy = Array.from({ length: EXPORT_CONCURRENCY + EXPORT_MAX_QUEUE }, () => settle(service.export(ctx, 'overdue-loans', exportQuery)));
    await new Promise((r) => setTimeout(r, 30));
    const unknown = await settle(service.export(ctx, 'nope', exportQuery));
    expect(!unknown.ok && unknown.error.getStatus?.()).toBe(HttpStatus.NOT_FOUND);
    const badSort = await settle(service.export(ctx, 'overdue-loans', { ...exportQuery, sortBy: 'zzz' }));
    expect(!badSort.ok && badSort.error.getStatus?.()).toBe(HttpStatus.BAD_REQUEST);
    gate.resolve();
    await Promise.all(busy);
  });

  it('хязгаар (maxRows = report.max_export_rows) ба экспортын statement_timeout-ыг run-д дамжуулна; 422-д мөр уншихгүй', async () => {
    const f = fixture({ max: 10, run: async (input) => ({ rows: [], total: input.maxRows! + 5 }) });
    const res = await settle(f.service.export(ctx, 'overdue-loans', exportQuery));
    expect(!res.ok && res.error.getStatus?.()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(!res.ok && res.error.getResponse?.().code).toBe('EXPORT_TOO_LARGE');
    expect(f.runs).toHaveLength(1);
    expect(f.runs[0]).toMatchObject({ page: 1, pageSize: 11, maxRows: 10, statementTimeoutMs: EXPORT_STATEMENT_TIMEOUT_MS });
    expect(f.created).toHaveLength(0); // амжилтгүй экспорт аудитад орохгүй
  });

  it('JSON тайланд maxRows/экспортын timeout дамжихгүй', async () => {
    const f = fixture();
    await f.service.run(ctx, 'overdue-loans', jsonQuery);
    expect(f.runs[0].maxRows).toBeUndefined();
    expect(f.runs[0].statementTimeoutMs).toBeUndefined();
  });

  it('statement_timeout (Postgres 57014) → 504 REPORT_TIMEOUT (JSON ба экспорт хоёуланд)', async () => {
    const timeout = Object.assign(new Error('Raw query failed. Code: `57014`'), { code: 'P2010', meta: { code: '57014', message: 'canceling statement due to statement timeout' } });
    const f = fixture({ run: async () => { throw timeout; } });
    for (const call of [() => f.service.export(ctx, 'overdue-loans', exportQuery), () => f.service.run(ctx, 'overdue-loans', jsonQuery)]) {
      const res = await settle(call());
      expect(!res.ok && res.error.getStatus?.()).toBe(HttpStatus.GATEWAY_TIMEOUT);
      expect(!res.ok && res.error.getResponse?.().code).toBe('REPORT_TIMEOUT');
    }
    const other = fixture({ run: async () => { throw new Error('өөр алдаа'); } });
    const res = await settle(other.service.export(ctx, 'overdue-loans', exportQuery));
    expect(!res.ok && res.error.getStatus).toBeUndefined(); // тодорхойгүй алдаа 500 хэвээр (HttpException биш)
  });
});

describe('ReportService: өгөгдлийн эх сурвалж (core-mock)', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('JSON хариу dataSource-той (core-mock | origination)', async () => {
    expect((await fixture({ source: 'core-mock' }).service.run(ctx, 'overdue-loans', jsonQuery)).dataSource).toBe('core-mock');
    expect((await fixture({ source: 'origination' }).service.run(ctx, 'overdue-loans', jsonQuery)).dataSource).toBe('origination');
  });

  it('report_run.params_json.dataSource бүртгэгдэнэ (аудитаар хойно ялгах)', async () => {
    for (const source of ['core-mock', 'origination', 'core'] as const) {
      const f = fixture({ source });
      await f.service.export(ctx, 'overdue-loans', exportQuery);
      expect(f.created[0].data.paramsJson.dataSource).toBe(source);
      expect(f.created[0].data.paramsJson.registerMasked).toBe(true);
    }
  });

  it('production-д core-mock өгөгдлийг экспортлохгүй (501), аудит/файл үүсэхгүй; JSON харалт, бусад эх сурвалж зөвшөөрөгдөнө', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const mock = fixture({ source: 'core-mock' });
    const res = await settle(mock.service.export(ctx, 'overdue-loans', exportQuery));
    expect(!res.ok && res.error.getStatus?.()).toBe(HttpStatus.NOT_IMPLEMENTED);
    expect(!res.ok && res.error.getResponse?.().code).toBe('INTEGRATION_NOT_IMPLEMENTED');
    expect(mock.runs).toHaveLength(0); // өгөгдөл уншихаас өмнө
    expect(mock.created).toHaveLength(0);
    expect((await mock.service.run(ctx, 'overdue-loans', jsonQuery)).dataSource).toBe('core-mock');
    for (const source of ['origination', 'core'] as const) expect((await fixture({ source }).service.export(ctx, 'overdue-loans', exportQuery)).rowCount).toBe(1);
  });

  it('production биш орчинд core-mock экспорт ажиллана', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect((await fixture({ source: 'core-mock' }).service.export(ctx, 'overdue-loans', exportQuery)).rowCount).toBe(1);
  });
});

// Excel/CSV экспорт: салбар / ЗЭЗ-ийн UUID биш нэр. Нэр нь gateway-ийн лавлахад (origination өөр schema уншихгүй) — нэг экспортод нэг л удаа авна.
describe('ReportService.export: салбар/ЗЭЗ-ийн нэр (directory)', () => {
  const columns = [col('contractNo', 'Гэрээ', 'string'), col('branchId', 'Салбар', 'string'), col('officerId', 'ЗЭЗ', 'string')];
  const rows: ReportRow[] = [
    { contractNo: 'C1', branchId: 'b1', officerId: 'u1' },
    { contractNo: 'C2', branchId: 'b2', officerId: 'Систем' },
    { contractNo: 'C3', branchId: 'b-gone', officerId: 'u-gone' },
  ];
  const known = async () => ({ branches: { b1: 'Төв салбар', b2: 'Баянзүрх салбар' }, users: { u1: 'Бат Болд' } });
  const named = (directory: OrgDirectorySource['fetch'], data: ReportRow[] = rows) =>
    fixture({ columns, filters: [F.branch, F.officer], directory, run: async () => ({ rows: data, total: data.length }) });

  async function cells(buffer: Buffer): Promise<{ data: string[][]; filterLine: string }> {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    const data: string[][] = [];
    for (let r = EXPORT_HEADER_ROW + 1; r <= ws.rowCount; r++) data.push([1, 2, 3].map((c) => String(ws.getRow(r).getCell(c).value ?? '')));
    return { data, filterLine: String(ws.getRow(3).getCell(1).value) };
  }

  it('мөрүүдэд салбарын нэр, ЗЭЗ-ийн бүтэн нэр гарна (UUID биш)', async () => {
    const { service } = named(known);
    const { data } = await cells((await service.export(ctx, 'overdue-loans', exportQuery)).buffer);
    expect(data[0]).toEqual(['C1', 'Төв салбар', 'Бат Болд']);
    expect(data[1]).toEqual(['C2', 'Баянзүрх салбар', 'Систем']);
  });

  it('"Шүүлт" мөрөнд ч салбар/ЗЭЗ-ийн id биш нэр гарна', async () => {
    const { service } = named(known, [rows[0]!]);
    const { filterLine } = await cells((await service.export(ctx, 'overdue-loans', { ...exportQuery, branchId: 'b1', officerId: 'u1' })).buffer);
    expect(filterLine).toContain('Салбар = Төв салбар');
    expect(filterLine).toContain('ЗЭЗ = Бат Болд');
    expect(filterLine).not.toContain('b1');
  });

  it('лавлахад байхгүй id → id хэвээр (нэр дутсанаас экспорт унахгүй)', async () => {
    const { service } = named(known);
    const { data } = await cells((await service.export(ctx, 'overdue-loans', exportQuery)).buffer);
    expect(data[2]).toEqual(['C3', 'b-gone', 'u-gone']);
  });

  it('лавлах унавал экспорт амжилттай (id-тай), warning лог бичигдэнэ', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, created } = named(async () => { throw new Error('gateway сервис руу холбогдож чадсангүй'); });
    const file = await service.export(ctx, 'overdue-loans', exportQuery);
    const { data } = await cells(file.buffer);
    expect(file.rowCount).toBe(3);
    expect(data[0]).toEqual(['C1', 'b1', 'u1']);
    expect(created).toHaveLength(1); // report_run аудит хэвээр бичигдэнэ
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('batch: N мөрт лавлахыг НЭГ л удаа дуудна (мөр тутамд биш)', async () => {
    const many: ReportRow[] = Array.from({ length: 1200 }, (_, i) => ({ contractNo: `C${i}`, branchId: i % 2 ? 'b1' : 'b2', officerId: 'u1' }));
    const { service, directory } = named(known, many);
    const { data } = await cells((await service.export(ctx, 'overdue-loans', exportQuery)).buffer);
    expect(data).toHaveLength(1200);
    expect(data[1]).toEqual(['C1', 'Төв салбар', 'Бат Болд']);
    expect(directory.fetch).toHaveBeenCalledTimes(1);
  });

  it('id багана байхгүй тайланд, мөр байхгүй үед лавлах огт дуудагдахгүй', async () => {
    const plain = fixture({ directory: known });
    await plain.service.export(ctx, 'overdue-loans', exportQuery);
    const empty = named(known, []);
    await empty.service.export(ctx, 'overdue-loans', exportQuery);
    expect(plain.directory.fetch).not.toHaveBeenCalled();
    expect(empty.directory.fetch).not.toHaveBeenCalled();
  });

  it('JSON (run) нь хэвээр id-тай: UI өөрийн лавлахаар хөрвүүлнэ, лавлах дуудагдахгүй', async () => {
    const { service, directory } = named(known);
    const res = await service.run(ctx, 'overdue-loans', jsonQuery);
    expect(res.rows[0]).toMatchObject({ branchId: 'b1', officerId: 'u1' });
    expect(directory.fetch).not.toHaveBeenCalled();
  });
});
