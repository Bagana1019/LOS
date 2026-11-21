import { AuditLogQuery, type RequestContext } from '@los/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma.service';
import type { MakerCheckerService } from '../maker-checker/maker-checker.service';
import { AdminService } from './admin.service';

// F9-24 follow-up · DB-гүй unit: origination-ы аудит жагсаалтын `where` дүрэм (Postgres-гүй CI-д ч шалгагдана).
// DB-тэй хувилбар: audit-filters.e2e.test.ts.
const CTX: RequestContext = { userId: 'u-1', roles: ['ADMIN'], branchId: null, orgId: 'org-a', customerId: null, correlationId: 'corr-1' };

function setup() {
  const auditLog = { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) };
  const service = new AdminService({ auditLog } as unknown as PrismaService, {} as MakerCheckerService);
  const whereOf = async (query: Record<string, unknown> = {}) => {
    await service.audit(CTX, AuditLogQuery.parse(query));
    return auditLog.findMany.mock.calls[0]![0].where as Record<string, unknown>;
  };
  return { auditLog, whereOf };
}

describe('AdminService.audit · where', () => {
  it('шүүлтгүй бол зөвхөн дуудагчийн байгууллагаар хязгаарлана', async () => {
    expect(await setup().whereOf()).toEqual({ orgId: 'org-a' });
  });

  it('объект: хэсэгчилсэн, том/жижиг үсэг үл ялгах', async () => {
    expect(await setup().whereOf({ entity: 'setting' })).toEqual({ orgId: 'org-a', entity: { contains: 'setting', mode: 'insensitive' } });
  });

  it('үйлдэл: хэсэгчилсэн, том/жижиг үсэг үл ялгах', async () => {
    expect(await setup().whereOf({ action: 'updated' })).toEqual({ orgId: 'org-a', action: { contains: 'updated', mode: 'insensitive' } });
  });

  it('"%", "_", "\\" -г шууд тэмдэгт болгон escape хийнэ', async () => {
    const where = await setup().whereOf({ entity: 'a_b%c\\d', action: '_' });
    expect(where).toMatchObject({ entity: { contains: 'a\\_b\\%c\\\\d' }, action: { contains: '\\_' } });
  });

  it('хоосон/зайтай объект, үйлдэл нь шүүлт нэмэхгүй', async () => {
    expect(await setup().whereOf({ entity: '   ', action: '' })).toEqual({ orgId: 'org-a' });
  });

  it('entityId, actorId, applicationId, огноо өмнөх шигээ яг таарна', async () => {
    const where = await setup().whereOf({ entityId: 'inquiry.stale_days', actorId: 'u-9', applicationId: 'app-1', from: '2026-11-01T00:00:00.000Z', to: '2026-11-30T00:00:00.000Z' });
    expect(where).toEqual({
      orgId: 'org-a', entityId: 'inquiry.stale_days', actorId: 'u-9', applicationId: 'app-1',
      at: { gte: new Date('2026-11-01T00:00:00.000Z'), lte: new Date('2026-11-30T00:00:00.000Z') },
    });
  });

  it('тоолох ба жагсаалт нэг ижил where-ээр ажиллана (хуудаслалтын total зөв)', async () => {
    const { auditLog, whereOf } = setup();
    const where = await whereOf({ entity: 'setting' });
    expect(auditLog.count).toHaveBeenCalledWith({ where });
  });
});
