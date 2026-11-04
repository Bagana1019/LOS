import { Inject, Injectable } from '@nestjs/common';
import type { AmlSubjectType } from '@los/contracts';
import { enqueueOutbox } from '@los/database';
import { BLACKLIST_PRISMA } from './blacklist.prisma';
import {
  DuplicateBlacklistEntryError, StaleBlacklistEntryError,
  type BlacklistAudit, type BlacklistChangedEvent, type BlacklistListFilter, type BlacklistRepository, type BlacklistRow,
} from './blacklist.repository';

// Зөвхөн энэ repository-н ашигладаг delegate-ийн хэлбэр: unit typecheck нь generate хийсэн client шаардахгүй.
// Бодит PrismaClient (.prisma/client-origination) үүнд бүтцээрээ таарна — blacklist.prisma.ts-д шалгагдана.
type BlacklistRecord = Omit<BlacklistRow, 'customerType' | 'severity' | 'source' | 'pendingSeverity'> & { customerType: string; severity: string; source: string; pendingSeverity: string | null };
interface BlacklistDelegate {
  findFirst(args: { where: object; orderBy?: object[] }): Promise<BlacklistRecord | null>;
  findMany(args: { where: object; orderBy: object[]; skip: number; take: number }): Promise<BlacklistRecord[]>;
  count(args: { where: object }): Promise<number>;
  create(args: { data: BlacklistRow }): Promise<unknown>;
  updateMany(args: { where: object; data: object }): Promise<{ count: number }>;
}
interface OutboxDelegate { create(args: { data: { id: string; type: string; payload: object } }): Promise<unknown> }
interface AuditDelegate { create(args: { data: { orgId: string; entity: string; entityId: string; action: string; actorId: string; beforeJson?: object; afterJson: object; correlationId: string } }): Promise<unknown> }
interface Tx { blacklist: BlacklistDelegate; outbox: OutboxDelegate; auditLog: AuditDelegate }
export interface BlacklistPrismaClient extends Tx { $transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> }

const toRow = (r: BlacklistRecord): BlacklistRow => ({ ...r, customerType: r.customerType as AmlSubjectType, severity: r.severity === 'GREY' ? 'GREY' : 'BLACK', source: r.source as BlacklistRow['source'], pendingSeverity: r.pendingSeverity === 'GREY' ? 'GREY' : r.pendingSeverity === 'BLACK' ? 'BLACK' : null });
/** Зөвхөн blacklist-ийн unique зөрчил: outbox-ийн PK давхардал (eventId) нь код алдаа тул Duplicate болгож далдлахгүй. */
const isBlacklistUniqueViolation = (e: unknown) => {
  const err = e as { code?: unknown; meta?: { modelName?: unknown } } | null;
  return err?.code === 'P2002' && err.meta?.modelName === 'Blacklist';
};
/** Prisma `contains` нь LIKE-ийн `%`, `_`, `\`-г зугтаадаггүй — хэрэглэгчийн текстийг шууд утгаар нь хайлгана. */
const escapeLike = (text: string) => text.replace(/[\\%_]/g, '\\$&');

@Injectable()
export class PrismaBlacklistRepository implements BlacklistRepository {
  constructor(@Inject(BLACKLIST_PRISMA) private readonly prisma: BlacklistPrismaClient) {}

  async list(orgId: string, filter: BlacklistListFilter) {
    const where = {
      orgId,
      ...(filter.isActive !== undefined && { isActive: filter.isActive }),
      ...(filter.listType !== undefined && { listType: filter.listType }),
      ...(filter.severity !== undefined && { severity: filter.severity }),
      ...(filter.search && {
        OR: [{ name: { contains: escapeLike(filter.search.text), mode: 'insensitive' } }, { registerNoHash: filter.search.registerNoHash }],
      }),
    };
    const [total, items] = await Promise.all([
      this.prisma.blacklist.count({ where }),
      this.prisma.blacklist.findMany({ where, orderBy: [{ registeredAt: 'desc' }, { id: 'asc' }], skip: filter.offset, take: filter.limit }),
    ]);
    return { total, items: items.map(toRow) };
  }

  async findById(orgId: string, id: string) {
    const r = await this.prisma.blacklist.findFirst({ where: { id, orgId } });
    return r && toRow(r);
  }

  async findExpired(now: Date, limit: number) {
    const rows = await this.prisma.blacklist.findMany({ where: { isActive: true, validUntil: { lte: now } }, orderBy: [{ validUntil: 'asc' }, { id: 'asc' }], skip: 0, take: limit });
    return rows.map(toRow);
  }

  async findByKey(orgId: string, registerNoHash: string, listType: string) {
    // Идэвхтэй мөр ганц (partial unique); идэвхгүй түүхэн мөр олон байж болох тул идэвхтэйг түрүүлж, үгүй бол хамгийн сүүлд өөрчлөгдсөнийг авна.
    const r = await this.prisma.blacklist.findFirst({ where: { orgId, registerNoHash, listType }, orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }, { id: 'asc' }] });
    return r && toRow(r);
  }

  /**
   * Мөр ба outbox нэг $transaction-д. CLAUDE.md §3.2.4.
   * Шинэчлэх нь `updatedAt`-ын compare-and-set: UPDATE ... WHERE id AND updated_at = expected. Зэрэг ирсэн хоёр засвараас
   * хожсон нь мөрийг түгжиж, ялагдсан нь commit-ийн дараа WHERE-ийг дахин үнэлж 0 мөр олно → StaleBlacklistEntryError (транзакц буцна).
   * `updatedAt`-ыг service тодорхой дамжуулдаг (Prisma `@updatedAt` нь утга өгөөгүй үед л автоматаар тавьдаг) тул CAS-д
   * ашиглах утга ба event.changedAt-д гарах утга ижил хэвээр.
   */
  async saveWithEvent(row: BlacklistRow, event: BlacklistChangedEvent, expectedUpdatedAt: Date | null, audit?: BlacklistAudit) {
    try {
      await this.prisma.$transaction(async (tx) => {
        if (expectedUpdatedAt === null) {
          await tx.blacklist.create({ data: row });
        } else {
          const { id, orgId, ...data } = row;
          const { count } = await tx.blacklist.updateMany({ where: { id, orgId, updatedAt: expectedUpdatedAt }, data });
          if (count !== 1) throw new StaleBlacklistEntryError();
        }
        // id = eventId → relay idempotent; enqueueOutbox нь event-ийг DomainEvent схемээр шалгана.
        await enqueueOutbox(tx, event);
        // FR-13.5: аудит мөр нэг транзакцид (хэн, хэзээ, юуг). PII-гүй.
        if (audit) {
          await tx.auditLog.create({
            data: {
              orgId: row.orgId, entity: 'blacklist', entityId: row.id, action: audit.action, actorId: audit.actorId,
              ...(audit.before && { beforeJson: audit.before }), afterJson: audit.after, correlationId: audit.correlationId,
            },
          });
        }
      });
    } catch (e) {
      if (isBlacklistUniqueViolation(e)) throw new DuplicateBlacklistEntryError();
      throw e;
    }
  }
}
