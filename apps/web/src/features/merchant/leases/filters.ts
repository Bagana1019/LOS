import { PosLeaseStatus } from '@los/contracts';
import { dateInputToIso } from '../../../lib/format';
import type { LeaseListParams } from '../../../lib/merchant-api';
// Жагсаалтын шүүлт ↔ URL (хуваалцаж болохуйц). URL-д огноо 'YYYY-MM-DD', status нь таслалаар тусгаарласан жагсаалт.
// Хайлтын текст `q` URL-д ОРОХГҮЙ: энэ нь бүтэн регистр эсвэл утасны цифр байж болно (POS-FR-8) — хөтчийн түүх, access log, хуваалцсан холбоосонд PII үлдэхгүй (POS-BR-7).
// `q` зөвхөн компонентын төлөвт (LeaseList) байж, API-ийн query-д л дамжина.

export const DEFAULT_PAGE_SIZE = 20;
export const PAGE_SIZE_OPTIONS = [10, 20, 50] as const;

export interface LeaseFilters {
  status: PosLeaseStatus[];
  storeId?: string;
  /** Хайлтын текст. URL-аас уншихгүй, URL-д бичихгүй (дээрх тайлбар); зөвхөн `filtersToParams`-аар API руу. */
  q?: string;
  /** 'YYYY-MM-DD' */
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const posInt = (v: string | null, fallback: number, max = 1000): number => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : fallback;
};

export function parseLeaseFilters(sp: URLSearchParams): LeaseFilters {
  const status = (sp.get('status') ?? '').split(',').map((s) => s.trim()).filter((s): s is PosLeaseStatus => (PosLeaseStatus as readonly string[]).includes(s));
  const storeId = sp.get('store');
  const from = sp.get('from');
  const to = sp.get('to');
  return {
    status: [...new Set(status)],
    ...(storeId && UUID_RE.test(storeId) ? { storeId } : {}),
    ...(from && DATE_RE.test(from) ? { from } : {}),
    ...(to && DATE_RE.test(to) ? { to } : {}),
    page: posInt(sp.get('page'), 1),
    pageSize: PAGE_SIZE_OPTIONS.includes(Number(sp.get('pageSize')) as 10 | 20 | 50) ? Number(sp.get('pageSize')) : DEFAULT_PAGE_SIZE,
  };
}

/** Шүүлт → '?status=...&page=2' (анхдагч утгыг оруулахгүй). `q` хэзээ ч орохгүй (PII). */
export function filtersToSearch(f: LeaseFilters): string {
  const sp = new URLSearchParams();
  if (f.status.length) sp.set('status', f.status.join(','));
  if (f.storeId) sp.set('store', f.storeId);
  if (f.from) sp.set('from', f.from);
  if (f.to) sp.set('to', f.to);
  if (f.page > 1) sp.set('page', String(f.page));
  if (f.pageSize !== DEFAULT_PAGE_SIZE) sp.set('pageSize', String(f.pageSize));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/** Шүүлт → API query (огноо → ISO, +08:00). */
export function filtersToParams(f: LeaseFilters): LeaseListParams {
  return {
    ...(f.status.length ? { status: f.status } : {}),
    ...(f.storeId ? { storeId: f.storeId } : {}),
    ...(f.q ? { q: f.q } : {}),
    ...(f.from ? { from: dateInputToIso(f.from, 'start') } : {}),
    ...(f.to ? { to: dateInputToIso(f.to, 'end') } : {}),
    page: f.page,
    pageSize: f.pageSize,
  };
}

export const hasActiveFilters = (f: LeaseFilters): boolean => f.status.length > 0 || !!f.storeId || !!f.q || !!f.from || !!f.to;
