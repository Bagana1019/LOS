import {
  DuplicateBlacklistEntryError, StaleBlacklistEntryError,
  type BlacklistChangedEvent, type BlacklistListFilter, type BlacklistRepository, type BlacklistRow,
} from './blacklist.repository';

/** Тест болон локал ажиллуулалтад. Мөр ба event хоёр хамт бичигдэх (эсвэл хоёул бичигдэхгүй) гэрээг Prisma-тай адил хадгална. */
export class InMemoryBlacklistRepository implements BlacklistRepository {
  private readonly rows = new Map<string, BlacklistRow>();
  /** Outbox-ийн дүрс: бичигдсэн дарааллаар. */
  readonly events: BlacklistChangedEvent[] = [];

  async list(orgId: string, filter: BlacklistListFilter) {
    const { search } = filter;
    const matched = [...this.rows.values()]
      .filter((r) => r.orgId === orgId)
      .filter((r) => filter.isActive === undefined || r.isActive === filter.isActive)
      .filter((r) => filter.listType === undefined || r.listType === filter.listType)
      .filter((r) => !search || r.name.toLowerCase().includes(search.text.toLowerCase()) || r.registerNoHash === search.registerNoHash)
      .sort((a, b) => b.registeredAt.getTime() - a.registeredAt.getTime() || a.id.localeCompare(b.id));
    return { total: matched.length, items: matched.slice(filter.offset, filter.offset + filter.limit).map((r) => ({ ...r })) };
  }

  async findById(orgId: string, id: string) {
    const row = this.rows.get(id);
    return row && row.orgId === orgId ? { ...row } : null;
  }

  async findByKey(orgId: string, registerNoHash: string, listType: string) {
    const row = [...this.rows.values()].find((r) => r.orgId === orgId && r.registerNoHash === registerNoHash && r.listType === listType);
    return row ? { ...row } : null;
  }

  async saveWithEvent(row: BlacklistRow, event: BlacklistChangedEvent, expectedUpdatedAt: Date | null) {
    // Шалгалт ба бичилт хоорондоо await-гүй тул атомик (Prisma-н transaction + CAS-тай адил).
    const current = this.rows.get(row.id);
    if (expectedUpdatedAt === null) {
      if (current) throw new DuplicateBlacklistEntryError();
    } else if (!current || current.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
      throw new StaleBlacklistEntryError();
    }
    const clash = [...this.rows.values()].some((r) => r.id !== row.id && r.orgId === row.orgId && r.registerNoHash === row.registerNoHash && r.listType === row.listType);
    if (clash) throw new DuplicateBlacklistEntryError();
    this.rows.set(row.id, { ...row });
    this.events.push(event);
  }
}
