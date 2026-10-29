import { Inject, Injectable } from '@nestjs/common';
import type { DomainEvent, PosLeaseStatus } from '@los/contracts';
import type { Prisma } from './client';
import { DomainError, LeaseKeyConflict } from '../../domain/errors';
import type { LeaseDashboardRow, LeaseEventRecord, LeaseRecord, TimelineInput } from '../../domain/records';
import { LeaseRepository, type LeaseFilter, type LeaseScope, type Page, type PageArgs } from '../repositories';
import { DASHBOARD_SELECT, dashboardRowOf, eventToRecord, leaseMutable, leaseToCreate, leaseToRecord, num, timelineToCreate } from './mappers';
import { writeOutbox } from './outbox';
import { clampPage, escapeLike, isUuid, uniqueViolation, violates } from './prisma-errors';
import { PrismaService } from './prisma.service';

// POS-FR-5/6/8/11: лизинг, timeline, dashboard-ын мөр, өдрийн лимитийн нийлбэр.
const ACCEPTED_STATUSES: PosLeaseStatus[] = ['ACCEPTED', 'DELIVERED', 'SETTLED']; // POS-BR-9
const EXPIRABLE_STATUSES: PosLeaseStatus[] = ['DRAFT', 'REFERRED', 'APPROVED'];

/**
 * Tenant хил (docs/05 §13): scope-ийн бүх нөхцөл query бүрт заавал орно. uuid биш ID → таарах мөр байхгүй (null).
 * `branchId` (BRANCH_MANAGER) = мерчантын ОДООГИЙН салбар (`merchant.branch_id`, docs/05 §2, §8) — `pos_lease.branch_id` (үүсгэх үеийн түүхэн хуулбар, POS-BR-13) биш.
 */
function scopeWhere(scope: LeaseScope): Prisma.PosLeaseWhereInput | null {
  if ([scope.merchantId, scope.storeId].some((id) => id && !isUuid(id))) return null;
  return {
    orgId: scope.orgId,
    ...(scope.merchantId ? { merchantId: scope.merchantId } : {}),
    ...(scope.storeId ? { storeId: scope.storeId } : {}),
    ...(scope.branchId ? { merchant: { branchId: scope.branchId } } : {}),
  };
}

@Injectable()
export class PrismaLeaseRepository extends LeaseRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) { super(); }

  /** Лизинг + эхний timeline + event НЭГ транзакцид. POS-BR-12: (merchant_id, idempotency_key) / lease_no давхцвал LeaseKeyConflict (юу ч бичигдэхгүй). */
  async insertLease(l: LeaseRecord, timeline: TimelineInput, events: DomainEvent[]): Promise<LeaseRecord> {
    // DB-ийн `pos_lease_version_check` (version >= 1)-ийг мэдэгдэхүйц алдаагаар урьдчилан шалгана (санах ойн хэрэгжүүлэлттэй ижил).
    if (!Number.isInteger(l.version) || l.version < 1) throw new Error(`pos_lease_version_check violated: version must be an integer >= 1 (got ${l.version})`);
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.posLease.create({ data: leaseToCreate(l) });
        await tx.posLeaseEvent.create({ data: timelineToCreate(l, timeline) });
        await writeOutbox(tx, events);
        return created;
      });
      return leaseToRecord(row);
    } catch (e) {
      throw await this.translateConflict(e, l);
    }
  }

  /** Optimistic lock (version): тэнцүү биш бол CONCURRENT_UPDATE; хадгалагдсан мөрийг буцаана (version + 1). Timeline + event нэг tx (POS-FR-11, POS-FR-10). */
  async saveLease(l: LeaseRecord, timeline: TimelineInput, events: DomainEvent[]): Promise<LeaseRecord> {
    if (!isUuid(l.id)) throw new DomainError('NOT_FOUND', 'lease not found');
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        // Optimistic lock: зөвхөн хадгалагдсан version тэнцүү үед шинэчилнэ. count 0 бол timeline/outbox бичихээс ӨМНӨ шидэж, tx бүхлээрээ буцна.
        const res = await tx.posLease.updateMany({ where: { id: l.id, orgId: l.orgId, version: l.version }, data: { ...leaseMutable(l), version: l.version + 1 } });
        if (res.count === 0) {
          const exists = (await tx.posLease.count({ where: { id: l.id, orgId: l.orgId } })) > 0;
          throw exists ? new DomainError('CONCURRENT_UPDATE', 'lease was modified concurrently') : new DomainError('NOT_FOUND', 'lease not found');
        }
        await tx.posLeaseEvent.create({ data: timelineToCreate(l, timeline) });
        await writeOutbox(tx, events);
        return tx.posLease.findUniqueOrThrow({ where: { id: l.id } });
      });
      return leaseToRecord(row);
    } catch (e) {
      throw await this.translateConflict(e, l);
    }
  }

  async findLease(scope: LeaseScope, id: string): Promise<LeaseRecord | null> {
    const scoped = scopeWhere(scope);
    if (!scoped || !isUuid(id)) return null;
    const row = await this.prisma.posLease.findFirst({ where: { ...scoped, id } });
    return row ? leaseToRecord(row) : null;
  }

  async findByIdempotencyKey(merchantId: string, key: string): Promise<LeaseRecord | null> {
    if (!isUuid(merchantId)) return null;
    const row = await this.prisma.posLease.findUnique({ where: { merchantId_idempotencyKey: { merchantId, idempotencyKey: key } } });
    return row ? leaseToRecord(row) : null;
  }

  /** createdAt буурах эрэмбэтэй; ижил createdAt-д leaseNo буурах (хуудаслалт тогтвортой). from/to = createdAt ∈ [from, to). */
  async listLeases(scope: LeaseScope, f: LeaseFilter, page: PageArgs): Promise<Page<LeaseRecord>> {
    const scoped = scopeWhere(scope);
    if (!scoped) return { items: [], total: 0 };
    const where: Prisma.PosLeaseWhereInput = {
      ...scoped,
      ...(f.statuses?.length ? { status: { in: f.statuses } } : {}),
      ...(f.from || f.to ? { createdAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lt: f.to } : {}) } } : {}),
      ...(f.leaseNoLike ? { leaseNo: { contains: escapeLike(f.leaseNoLike), mode: 'insensitive' as const } } : {}),
      ...(f.buyerPhoneSuffix ? { buyerPhone: { endsWith: escapeLike(f.buyerPhoneSuffix) } } : {}),
      ...(f.buyerRegisterHash ? { buyerRegisterHash: f.buyerRegisterHash } : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.posLease.count({ where }),
      this.prisma.posLease.findMany({ where, orderBy: [{ createdAt: 'desc' }, { leaseNo: 'desc' }], ...clampPage(page) }),
    ]);
    return { items: rows.map(leaseToRecord), total };
  }

  /** (at, id) өсөх эрэмбэ. id нь UUIDv7 тул ижил `at`-д оруулсан дараалал хадгалагдана. */
  async timeline(leaseId: string): Promise<LeaseEventRecord[]> {
    if (!isUuid(leaseId)) return [];
    const rows = await this.prisma.posLeaseEvent.findMany({ where: { leaseId }, orderBy: [{ at: 'asc' }, { id: 'asc' }] });
    return rows.map(eventToRecord);
  }

  /** createdAt ∈ [from, to). Эрэмбэ баталгаагүй (dashboard нийлбэр тоолно). */
  async dashboardRows(scope: LeaseScope, from: Date, to: Date): Promise<LeaseDashboardRow[]> {
    const scoped = scopeWhere(scope);
    if (!scoped) return [];
    const rows = await this.prisma.posLease.findMany({ where: { ...scoped, createdAt: { gte: from, lt: to } }, select: DASHBOARD_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return rows.map(dashboardRowOf);
  }

  /** acceptedAt ∈ [from, to) ба status ∈ ACCEPTED/DELIVERED/SETTLED лизингийн санхүүжилтийн нийлбэр (POS-BR-9). Decimal-аар яг нийлбэрлэнэ. */
  async sumAcceptedFinanced(merchantId: string, from: Date, to: Date): Promise<number> {
    if (!isUuid(merchantId)) return 0;
    const agg = await this.prisma.posLease.aggregate({
      _sum: { financedAmount: true },
      where: { merchantId, status: { in: ACCEPTED_STATUSES }, acceptedAt: { gte: from, lt: to } },
    });
    return agg._sum.financedAmount ? num(agg._sum.financedAmount) : 0;
  }

  /** Хугацаа нь дууссан (expiresAt < now, хатуу), төлөв нь DRAFT/REFERRED/APPROVED лизингүүд; expiresAt өсөх эрэмбэ. */
  async listExpirable(now: Date, limit: number): Promise<LeaseRecord[]> {
    const rows = await this.prisma.posLease.findMany({
      where: { status: { in: EXPIRABLE_STATUSES }, expiresAt: { lt: now } },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: Math.max(0, limit),
    });
    return rows.map(leaseToRecord);
  }

  /**
   * P2002 → LeaseKeyConflict. Хоёр unique зэрэг зөрчигдвэл IDEMPOTENCY давамгайлна (санах ойн хэрэгжүүлэлттэй ижил):
   * Postgres аль индексийг түрүүлж шалгасан нь тодорхойгүй тул lease_no-оор унасан үед idempotency түлхүүрийг давхар шалгана.
   */
  private async translateConflict(e: unknown, l: Pick<LeaseRecord, 'merchantId' | 'idempotencyKey'>): Promise<unknown> {
    const v = uniqueViolation(e);
    if (violates(v, 'PosLease', 'idempotency_key')) return new LeaseKeyConflict('IDEMPOTENCY');
    if (violates(v, 'PosLease', 'lease_no')) {
      const sameKey = await this.prisma.posLease.findUnique({ where: { merchantId_idempotencyKey: { merchantId: l.merchantId, idempotencyKey: l.idempotencyKey } }, select: { id: true } });
      return new LeaseKeyConflict(sameKey ? 'IDEMPOTENCY' : 'LEASE_NO');
    }
    return e;
  }
}
