import { describe, expect, it, vi } from 'vitest';
import type { ReportExportQuery, ReportFilterDef, ReportQuery, RequestContext } from '@los/contracts';
import type { Clock } from '@los/nest-common';
import type { PrismaService } from '../../prisma.service';
import type { OrgSettings } from '../../shared/org-settings';
import { OrgDirectoryService } from '../../shared/org-directory';
import type { CoreDepositPort } from '../../integrations/core-deposit/core-deposit.port';
import { ReportService } from './report.service';
import { F, col } from './report-filters';
import type { ReportRegistry } from './report-registry';
import type { ReportDefinition, ReportInput } from './report-types';

// F11-7: branchId / officerId / productId / currency нь status-тай адил буруу утгад 400 INVALID_FILTER (DB-гүй, детерминистик).
const UUID_A = '00000000-0000-4000-8000-000000000101';
const UUID_B = '00000000-0000-4000-8000-000000000201';
const admin: RequestContext = { userId: 'admin-1', roles: ['ADMIN'], branchId: null, orgId: 'org-1', customerId: null, correlationId: 'c-1' };
const manager: RequestContext = { userId: 'bm-1', roles: ['BRANCH_MANAGER'], branchId: UUID_A, orgId: 'org-1', customerId: null, correlationId: 'c-2' };
const json = (o: Partial<ReportQuery> = {}) => ({ sortDir: 'asc', page: 1, pageSize: 20, ...o }) as ReportQuery;
const xlsx = (o: Partial<ReportExportQuery> = {}) => ({ sortDir: 'asc', ...o }) as ReportExportQuery;

interface Known { products?: string[]; branches?: string[]; officers?: string[] }

function fixture(known: Known = {}, filters: ReportFilterDef[] = [F.branch, F.officer, F.product, F.currency]) {
  const runs: ReportInput[] = [];
  const def: ReportDefinition = {
    key: 'overdue-loans', title: 'Туршилт', description: 'd', columns: [col('name', 'Нэр', 'string')], filters, defaultSort: { sortBy: 'name', sortDir: 'asc' }, totalKeys: [],
    dataSource: () => 'origination',
    run: async (_deps, input) => { runs.push(input); return { rows: [{ name: 'А' }], total: 1 }; },
  };
  const product = { findFirst: vi.fn(async ({ where }: { where: { id: string; orgId: string } }) => (known.products?.includes(where.id) && where.orgId === 'org-1' ? { id: where.id } : null)) };
  const loanApplication = {
    findFirst: vi.fn(async ({ where }: { where: { orgId: string; branchId?: string; officerId?: string } }) => {
      const hit = where.orgId === 'org-1' && ((where.branchId && known.branches?.includes(where.branchId)) || (where.officerId && known.officers?.includes(where.officerId)));
      return hit ? { id: 'la-1' } : null;
    }),
  };
  const reportRun = { create: vi.fn(async () => ({})) };
  const prisma = { product: { ...product, findMany: async () => [] }, loanApplication, reportRun } as unknown as PrismaService;
  const clock = { now: () => new Date('2026-10-28T02:00:00Z'), today: () => '2026-10-28' } as unknown as Clock;
  const settings = { get: async () => 50_000 } as unknown as OrgSettings;
  const registry = { get: (k: string) => (k === def.key ? def : undefined), all: () => [def], has: (k: string) => k === def.key } as unknown as ReportRegistry;
  const deposit = { mode: 'mock', listBalances: async () => [] } as unknown as CoreDepositPort;
  const directory = new OrgDirectoryService({ fetch: async () => ({ branches: {}, users: {} }) }, clock as never);
  return { service: new ReportService(prisma, clock, settings, registry, deposit, directory), runs, product, loanApplication, reportRun };
}

const failure = async (p: Promise<unknown>): Promise<{ status: number; body: { code?: string; message?: string } }> => {
  try { await p; } catch (e) {
    const err = e as { getStatus?: () => number; getResponse?: () => { code?: string; message?: string } };
    return { status: err.getStatus?.() ?? 0, body: err.getResponse?.() ?? {} };
  }
  throw new Error('expected the call to be rejected');
};

describe('ReportService: шүүлтийн утгын шалгалт (F11-7) — бүгд INVALID_FILTER (400)', () => {
  it.each([
    ['currency', { currency: 'EUR' }, 'Валют'],
    ['branchId', { branchId: 'notauuid' }, 'Салбар'],
    ['officerId', { officerId: 'notauuid' }, 'ЗЭЗ'],
    ['productId', { productId: 'notauuid' }, 'Бүтээгдэхүүн'],
  ] as const)('%s=%j → 400 INVALID_FILTER, монгол мессежэд шүүлтийн нэр ба утга; тайлан ажиллахгүй', async (_k, query, label) => {
    const { service, runs } = fixture();
    const value = Object.values(query)[0];
    const err = await failure(service.run(admin, 'overdue-loans', json(query)));
    expect(err.status).toBe(400);
    expect(err.body.code).toBe('INVALID_FILTER');
    expect(err.body.message).toBe(`"${label}" шүүлтийн утга буруу: ${value}`);
    expect(runs).toHaveLength(0);
  });

  it('excel экспорт ч адил: 400 INVALID_FILTER, тайлан ажиллахгүй, report_run аудит бичигдэхгүй', async () => {
    for (const query of [{ branchId: 'notauuid' }, { officerId: 'Систем' }, { productId: 'notauuid' }, { currency: 'EUR' }]) {
      const { service, runs, reportRun } = fixture();
      const err = await failure(service.export(admin, 'overdue-loans', xlsx(query)));
      expect(err.body.code, JSON.stringify(query)).toBe('INVALID_FILTER');
      expect(runs).toHaveLength(0);
      expect(reportRun.create).not.toHaveBeenCalled();
    }
  });

  it('currency: том/жижиг үсэг үл ялгана (usd → USD); declare хийгээгүй тайланд үл тооно', async () => {
    const lower = fixture();
    await lower.service.run(admin, 'overdue-loans', json({ currency: 'usd' }));
    expect(lower.runs[0]?.filters.currency).toBe('USD');
    const undeclared = fixture({}, [F.branch]);
    await undeclared.service.run(admin, 'overdue-loans', json({ currency: 'EUR' }));
    expect(undeclared.runs[0]?.filters.currency).toBeNull();
  });

  it('UUID хэлбэртэй branchId/officerId: DB-ээс асуухгүй, тодорхойгүй салбар нь 0 мөр (400 биш)', async () => {
    const { service, runs, loanApplication } = fixture();
    await service.run(admin, 'overdue-loans', json({ branchId: UUID_B, officerId: UUID_A }));
    expect(loanApplication.findFirst).not.toHaveBeenCalled();
    expect(runs[0]?.filters).toMatchObject({ branchId: UUID_B, officerId: UUID_A });
  });

  it('UUID биш боловч origination-д аль хэдийн хэрэглэгдсэн id (хуучин/dev өгөгдөл) зөвшөөрөгдөнө, байгууллагаар хязгаарлагдан хайна', async () => {
    const { service, runs, loanApplication } = fixture({ branches: ['branch-1'], officers: ['officer-1'] });
    await service.run(admin, 'overdue-loans', json({ branchId: 'branch-1', officerId: 'officer-1' }));
    expect(runs[0]?.filters).toMatchObject({ branchId: 'branch-1', officerId: 'officer-1' });
    expect(loanApplication.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { orgId: 'org-1', branchId: 'branch-1' } }));
    expect(loanApplication.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { orgId: 'org-1', officerId: 'officer-1' } }));
  });

  it('productId: каталогт (өөрийн байгууллагад) байгаа бол зөвшөөрнө; UUID хэлбэртэй ч байхгүй бол 400; өөр байгууллагын бүтээгдэхүүн 400', async () => {
    const { service, runs, product } = fixture({ products: [UUID_A] });
    await service.run(admin, 'overdue-loans', json({ productId: UUID_A }));
    expect(runs[0]?.filters.productId).toBe(UUID_A);
    expect(product.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: UUID_A, orgId: 'org-1' } }));
    expect((await failure(service.run(admin, 'overdue-loans', json({ productId: UUID_B })))).body.code).toBe('INVALID_FILTER');
    const foreign = fixture({ products: [UUID_A] });
    expect((await failure(foreign.service.run({ ...admin, orgId: 'org-2' }, 'overdue-loans', json({ productId: UUID_A })))).body.code).toBe('INVALID_FILTER');
  });

  it('хоосон / зөвхөн хоосон зайтай id шүүлт = шүүлтгүй (DB-ээс асуухгүй); хоосон зайгаар хүрээлсэн id trim хийгдэнэ', async () => {
    const { service, runs, product, loanApplication } = fixture({ products: [UUID_A] });
    await service.run(admin, 'overdue-loans', json({ branchId: '', officerId: '   ', productId: '' }));
    expect(runs[0]?.filters).toMatchObject({ branchId: null, officerId: null, productId: null });
    expect(product.findFirst).not.toHaveBeenCalled();
    expect(loanApplication.findFirst).not.toHaveBeenCalled();
    await service.run(admin, 'overdue-loans', json({ branchId: ` ${UUID_B} `, productId: ` ${UUID_A} ` }));
    expect(runs[1]?.filters).toMatchObject({ branchId: UUID_B, productId: UUID_A });
  });

  it('BRANCH_MANAGER: хүрээнээс гадуурх зөв салбарын шүүлт үл тоогдоно (200), харин утга нь буруу бол 400', async () => {
    const { service, runs } = fixture();
    await service.run(manager, 'overdue-loans', json({ branchId: UUID_B }));
    expect(runs[0]?.filters.branchId).toBe(UUID_A); // хүрээ давуу
    expect((await failure(service.run(manager, 'overdue-loans', json({ branchId: 'notauuid' })))).body.code).toBe('INVALID_FILTER');
  });

  it('declare хийгээгүй id шүүлтийг (ж: ямар ч салбар шүүлтгүй тайлан) шалгахгүй, үл тооно', async () => {
    const { service, runs, loanApplication } = fixture({}, [F.currency]);
    await service.run(admin, 'overdue-loans', json({ branchId: 'notauuid', productId: 'notauuid' }));
    expect(runs[0]?.filters).toMatchObject({ branchId: null, productId: null });
    expect(loanApplication.findFirst).not.toHaveBeenCalled();
  });

  it('sortBy: тодорхойгүй багана аль хэдийн 400 INVALID_SORT (регресс)', async () => {
    const { service } = fixture();
    expect((await failure(service.run(admin, 'overdue-loans', json({ sortBy: 'nope' })))).body.code).toBe('INVALID_SORT');
  });
});
