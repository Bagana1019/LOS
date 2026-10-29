// Хуудаслалтын хөрвүүлэлт: API (`page` + `pageSize`, эсвэл `limit` + `offset`) ↔ repository `PageRequest`. Хариу үргэлж нэг хэлбэртэй.
import type { Page, PageRequest } from '../../common/persistence';

export interface PageEnvelope<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  /** 1-ээс эхэлнэ */
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export const pageRequestOf = (q: { page: number; pageSize: number }): Required<PageRequest> => ({
  limit: q.pageSize,
  offset: (q.page - 1) * q.pageSize,
});

export function toEnvelope<T>(p: Page<T>): PageEnvelope<T> {
  const size = Math.max(p.limit, 1);
  return {
    items: p.items,
    total: p.total,
    limit: p.limit,
    offset: p.offset,
    page: Math.floor(p.offset / size) + 1,
    pageSize: p.limit,
    hasMore: p.offset + p.items.length < p.total,
  };
}

const DAY_MS = 86_400_000;
/** `YYYY-MM-DD` -> тухайн өдрийн эхлэл (UTC) */
export const startOfDayUtc = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
/** `createdTo` өдрийг ОРУУЛАХ ⇒ дараагийн өдрийн эхлэл (repository-д exclusive) */
export const endExclusiveUtc = (iso: string): Date => new Date(startOfDayUtc(iso).getTime() + DAY_MS);
