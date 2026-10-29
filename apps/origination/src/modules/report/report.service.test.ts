import { HttpStatus } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReportExportQuery, ReportQuery } from '@los/contracts';
import type { Clock } from '@los/nest-common';
import type { PrismaService } from '../../prisma.service';
import type { RequestContext } from '@los/contracts';
import type { OrgSettings } from '../../shared/org-settings';
import type { CoreDepositPort } from '../../integrations/core-deposit/core-deposit.port';
import { EXPORT_CONCURRENCY, EXPORT_MAX_QUEUE, ReportService } from './report.service';
import { EXPORT_STATEMENT_TIMEOUT_MS } from './report-db';
import { col } from './report-filters';
import type { ReportRegistry } from './report-registry';
import type { ReportDefinition, ReportInput, ReportRunResult } from './report-types';

// Service-ийн ачааллын хамгаалалт (export semaphore, мөр уншихаас өмнөх хязгаар, mock-ийн тэмдэглэгээ, timeout → 504)-ийг DB-гүйгээр, детерминистик шалгана.
const ctx: RequestContext = { userId: 'admin-1', roles: ['ADMIN'], branchId: null, orgId: 'org-1', customerId: null, correlationId: 'c-1' };
const exportQuery = { sortDir: 'asc' } as ReportExportQuery;
const jsonQuery = { sortDir: 'asc', page: 1, pageSize: 20 } as ReportQuery;

function fixture(o: { source?: 'origination' | 'core-mock' | 'core'; max?: number; run?: (input: ReportInput) => Promise<ReportRunResult> } = {}) {
  const runs: ReportInput[] = [];
  const def: ReportDefinition = {
    key: 'overdue-loans', title: 'Туршилт', description: 'd', columns: [col('name', 'Нэр', 'string')], filters: [], defaultSort: { sortBy: 'name', sortDir: 'asc' }, totalKeys: [],
    dataSource: () => o.source ?? 'origination',
    run: async (_deps, input) => { runs.push(input); return o.run ? o.run(input) : { rows: [{ name: 'А' }], total: 1 }; },
  };
  const created: Array<{ data: { paramsJson: Record<string, unknown>; rowCount: number } }> = [];
  const prisma = { product: { findMany: async () => [] }, reportRun: { create: async (args: (typeof created)[number]) => { created.push(args); return {}; } } } as unknown as PrismaService;
  const clock = { now: () => new Date('2026-10-28T02:00:00Z'), today: () => '2026-10-28' } as unknown as Clock;
  const settings = { get: async () => o.max ?? 50_000 } as unknown as OrgSettings;
  const registry = { get: (k: string) => (k === def.key ? def : undefined), all: () => [def], has: (k: string) => k === def.key } as unknown as ReportRegistry;
  const deposit = { mode: 'mock', listBalances: async () => [] } as unknown as CoreDepositPort;
  return { service: new ReportService(prisma, clock, settings, registry, deposit), runs, created };
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
