import type { AmlSubjectType, DomainEvent } from '@los/contracts';

export const BLACKLIST_REPOSITORY = Symbol('BLACKLIST_REPOSITORY');

/** origination.blacklist-ийн мөр. Регистр зөвхөн шифрлэгдсэн хэлбэрээр, хайлт/давхардал hash-аар (CLAUDE.md §6.5). */
export interface BlacklistRow {
  id: string;
  orgId: string;
  branchId: string | null;
  registerNoEncrypted: string;
  registerNoHash: string;
  customerType: AmlSubjectType;
  name: string;
  listType: string;
  reasonCode: string;
  reasonText: string | null;
  registeredBy: string;
  registeredAt: Date;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
  updatedBy: string | null;
}

export type BlacklistChangedEvent = Extract<DomainEvent, { type: 'BlacklistEntryChanged' }>;

export interface BlacklistListFilter {
  /** Нэрийн хэсэг (case-insensitive) ЭСВЭЛ регистрийн hash тэнцүү. */
  search?: { text: string; registerNoHash: string };
  listType?: string;
  isActive?: boolean;
  limit: number;
  offset: number;
}

/** (orgId, registerNoHash, listType) давхардал — идэвхтэй/идэвхгүй аль нь ч байсан. */
export class DuplicateBlacklistEntryError extends Error {
  constructor() {
    super('Blacklist entry with the same register number and list type already exists');
    this.name = 'DuplicateBlacklistEntryError';
  }
}

/** Optimistic lock: мөр уншсанаас хойш өөр хүсэлт өөрчилсөн (updatedAt таарахгүй) эсвэл мөр алга. */
export class StaleBlacklistEntryError extends Error {
  constructor() {
    super('Blacklist entry was modified concurrently');
    this.name = 'StaleBlacklistEntryError';
  }
}

export interface BlacklistRepository {
  /** registeredAt буурахаар (ижил бол id өсөхөөр). */
  list(orgId: string, filter: BlacklistListFilter): Promise<{ total: number; items: BlacklistRow[] }>;
  findById(orgId: string, id: string): Promise<BlacklistRow | null>;
  findByKey(orgId: string, registerNoHash: string, listType: string): Promise<BlacklistRow | null>;
  /**
   * Мөрийг үүсгэх/шинэчлэх БА outbox event-ийг НЭГ транзакцид бичнэ (CLAUDE.md §3.2.4).
   * Event бичигдэхгүй бол мөр ч бичигдэхгүй. Unique давхардал → DuplicateBlacklistEntryError.
   *
   * `expectedUpdatedAt`: `null` = шинэ мөр (зөвхөн create). Огноо = `row`-г үндэслэсэн мөрийн updatedAt; DB-д одоо байгаа
   * мөрийн updatedAt үүнтэй тэнцүү үед л шинэчилнэ (compare-and-set), үгүй бол StaleBlacklistEntryError (мөр, event хоёул бичигдэхгүй).
   * Тиймээс нэг entry-ийн бичилт цуваа болж, `row.updatedAt` (= event.changedAt) commit-ийн дарааллаар өсдөг.
   */
  saveWithEvent(row: BlacklistRow, event: BlacklistChangedEvent, expectedUpdatedAt: Date | null): Promise<void>;
}
