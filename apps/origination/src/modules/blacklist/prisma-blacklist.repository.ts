import { Inject, Injectable } from '@nestjs/common';
import type { AmlSubjectType } from '@los/contracts';
import { enqueueOutbox } from '@los/database';
import { BLACKLIST_PRISMA } from './blacklist.prisma';
import {
  DuplicateBlacklistEntryError, StaleBlacklistEntryError,
  type BlacklistChangedEvent, type BlacklistListFilter, type BlacklistRepository, type BlacklistRow,
} from './blacklist.repository';

// Зөвхөн энэ repository-н ашигладаг delegate-ийн хэлбэр: unit typecheck нь generate хийсэн client шаардахгүй.
// Бодит PrismaClient (.prisma/client-origination) үүнд бүтцээрээ таарна — blacklist.prisma.ts-д шалгагдана.
type BlacklistRecord = Omit<BlacklistRow, 'customerType'> & { customerType: string };
interface BlacklistDelegate {
  findFirst(args: { where: object }): Promise<BlacklistRecord | null>;
  findMany(args: { where: object; orderBy: object[]; skip: number; take: number }): Promise<BlacklistRecord[]>;
  count(args: { where: object }): Promise<number>;
  create(args: { data: BlacklistRow }): Promise<unknown>;
  updateMany(args: { where: object; data: object }): Promise<{ count: number }>;
}
interface OutboxDelegate { create(args: { data: { id: string; type: string; payload: object } }): Promise<unknown> }
interface Tx { blacklist: BlacklistDelegate; outbox: OutboxDelegate }
export interface BlacklistPrismaClient extends Tx { $transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> }

const toRow = (r: BlacklistRecord): BlacklistRow => ({ ...r, customerType: r.customerType as AmlSubjectType });
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

  async findByKey(orgId: string, registerNoHash: string, listType: string) {
    const r = await this.prisma.blacklist.findFirst({ where: { orgId, registerNoHash, listType } });
    return r && toRow(r);
  }

  /**
   * Мөр ба outbox нэг $transaction-д. CLAUDE.md §3.2.4.
   * Шинэчлэх нь `updatedAt`-ын compare-and-set: UPDATE ... WHERE id AND updated_at = expected. Зэрэг ирсэн хоёр засвараас
   * хожсон нь мөрийг түгжиж, ялагдсан нь commit-ийн дараа WHERE-ийг дахин үнэлж 0 мөр олно → StaleBlacklistEntryError (транзакц буцна).
   * `updatedAt`-ыг service тодорхой дамжуулдаг (Prisma `@updatedAt` нь утга өгөөгүй үед л автоматаар тавьдаг) тул CAS-д
   * ашиглах утга ба event.changedAt-д гарах утга ижил хэвээр.
   */
  async saveWithEvent(row: BlacklistRow, event: BlacklistChangedEvent, expectedUpdatedAt: Date | null) {
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
      });
    } catch (e) {
      if (isBlacklistUniqueViolation(e)) throw new DuplicateBlacklistEntryError();
      throw e;
    }
  }
}
