import {
  MerchantDashboard, MerchantErrorBody, MerchantProfile, MerchantView, OtpSent, Paged, PlanView, PosLeaseAdminView, PosLeaseListItem, PosLeaseView, PosLeaseWithOtp, PosQuote, StoreView,
  type MerchantCreate, type MerchantErrorCode, type MerchantStatus, type MerchantStatusChange, type MerchantUpdate, type PlanCreate, type PlanUpdate, type PosLeaseAccept, type PosLeaseCancel,
  type PosLeaseCreate, type PosLeaseDeliver, type PosLeaseReview, type PosLeaseSettle, type PosLeaseStatus, type PosLeaseSubmit, type PosQuoteRequest, type StoreCreate, type StoreUpdate,
} from '@los/contracts';
import { z } from 'zod';
import { API } from './api';

/** Gateway proxy: `/api/<service>/<зам>` → origination `/api/<зам>` (docs/00-foundation.md §2). Merchant API бүгд origination-д. */
export const ORIGINATION_API = `${API}/origination`;
// Мерчант POS портал ↔ gateway (docs/05 §8). Хариу бүр @los/contracts-ын zod схемээр шалгагдана. Auth (gateway Module 0) хараахан байхгүй:
// cookie-тэй (`credentials: 'include'`), x-correlation-id толгойтой; 401/403 → UI "хандах эрхгүй" төлөв.

export type ApiErrorCode = MerchantErrorCode | 'INTERNAL' | 'NETWORK_ERROR' | 'INVALID_RESPONSE' | 'UNKNOWN';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly correlationId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;

/** crypto.randomUUID нь зөвхөн secure context-д байдаг тул нөөц хувилбартай. */
export function newId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** POS-BR-12: нэг оролдлогод нэг Idempotency-Key; ижил агуулгаар дахин оролдвол ижил key, агуулга өөрчлөгдвөл шинэ key. */
export function createIdempotencyKeeper(generate: () => string = newId) {
  let current: { fingerprint: string; key: string } | null = null;
  return {
    keyFor(payload: unknown): string {
      const fingerprint = JSON.stringify(payload);
      if (!current || current.fingerprint !== fingerprint) current = { fingerprint, key: generate() };
      return current.key;
    },
    reset(): void {
      current = null;
    },
  };
}

type QueryValue = string | number | boolean | readonly string[] | null | undefined;

export function buildQuery(query?: Record<string, QueryValue>): string {
  if (!query) return '';
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      if (v.length > 0) sp.set(k, v.join(','));
    } else sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

const LooseError = z.object({ code: z.string(), message: z.string().optional() });

function statusToCode(status: number): ApiErrorCode {
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status >= 500) return 'INTERNAL';
  return 'UNKNOWN';
}

/** Алдааны хариуг ApiError болгоно. Сервер MerchantErrorBody-оос өөр бие (gateway, 500 INTERNAL) өгвөл HTTP status-аар код тодорхойлно. */
export function toApiError(status: number, json: unknown, correlationId?: string): ApiError {
  const body = MerchantErrorBody.safeParse(json);
  if (body.success) return new ApiError(status, body.data.code, body.data.message, body.data.details, correlationId);
  const loose = LooseError.safeParse(json);
  const code = status >= 500 || status === 401 || status === 403 || status === 404 ? statusToCode(status) : 'UNKNOWN';
  return new ApiError(status, code, loose.success ? loose.data.message ?? loose.data.code : `HTTP ${status}`, undefined, correlationId);
}

const isAbortError = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

interface RequestOptions<S extends z.ZodTypeAny> {
  schema: S;
  method?: 'GET' | 'POST' | 'PATCH';
  query?: Record<string, QueryValue>;
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

/** Нэг HTTP дуудлага + хариуны схем шалгалт. Сүлжээний алдаа → NETWORK_ERROR, схем зөрсөн → INVALID_RESPONSE. */
export async function request<S extends z.ZodTypeAny>(path: string, o: RequestOptions<S>): Promise<z.output<S>> {
  const correlationId = newId();
  const headers: Record<string, string> = { accept: 'application/json', 'x-correlation-id': correlationId };
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  if (o.idempotencyKey) headers['idempotency-key'] = o.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(`${ORIGINATION_API}${path}${buildQuery(o.query)}`, {
      method: o.method ?? 'GET',
      credentials: 'include',
      headers,
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
      signal: o.signal,
    });
  } catch (e) {
    if (isAbortError(e)) throw e;
    throw new ApiError(0, 'NETWORK_ERROR', 'Network error', undefined, correlationId);
  }
  const text = await res.text().catch(() => '');
  let json: unknown;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  if (!res.ok) throw toApiError(res.status, json, correlationId);
  const parsed = o.schema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw new ApiError(res.status, 'INVALID_RESPONSE', 'Response does not match the contract', { issues }, correlationId);
  }
  return parsed.data;
}

// ───────────── Параметрийн төрлүүд ─────────────
export interface DashboardParams { from?: string; to?: string; storeId?: string }
export interface LeaseListParams { status?: readonly PosLeaseStatus[]; storeId?: string; q?: string; from?: string; to?: string; page?: number; pageSize?: number }
export interface AdminLeaseListParams extends LeaseListParams { merchantId?: string }
export interface MerchantListParams { status?: MerchantStatus; q?: string; page?: number; pageSize?: number }
export interface PlanListParams { merchantId?: string; isActive?: boolean }
type Opts = { signal?: AbortSignal };

const PagedLeases = Paged(PosLeaseListItem);
const PagedMerchants = Paged(MerchantView);
const idPath = (id: string) => encodeURIComponent(id);

// ───────────── Мерчант портал ─────────────
export const getProfile = (o: Opts = {}) => request('/merchant-portal/me', { schema: MerchantProfile, ...o });
export const getDashboard = (q: DashboardParams, o: Opts = {}) => request('/merchant-portal/dashboard', { schema: MerchantDashboard, query: { ...q }, ...o });
export const createQuote = (body: z.input<typeof PosQuoteRequest>, o: Opts = {}) => request('/merchant-portal/quotes', { schema: PosQuote, method: 'POST', body, ...o });
export const createLease = (body: z.input<typeof PosLeaseCreate>, idempotencyKey: string, o: Opts = {}) =>
  request('/merchant-portal/leases', { schema: PosLeaseWithOtp, method: 'POST', body, idempotencyKey, ...o });
export const listLeases = (q: LeaseListParams, o: Opts = {}) => request('/merchant-portal/leases', { schema: PagedLeases, query: { ...q }, ...o });
export const getLease = (id: string, o: Opts = {}) => request(`/merchant-portal/leases/${idPath(id)}`, { schema: PosLeaseView, ...o });
export const resendConsentOtp = (id: string, o: Opts = {}) => request(`/merchant-portal/leases/${idPath(id)}/otp/consent`, { schema: OtpSent, method: 'POST', body: {}, ...o });
export const submitLease = (id: string, body: z.input<typeof PosLeaseSubmit>, o: Opts = {}) => request(`/merchant-portal/leases/${idPath(id)}/submit`, { schema: PosLeaseView, method: 'POST', body, ...o });
export const requestAcceptOtp = (id: string, o: Opts = {}) => request(`/merchant-portal/leases/${idPath(id)}/otp/accept`, { schema: OtpSent, method: 'POST', body: {}, ...o });
export const acceptLease = (id: string, body: z.input<typeof PosLeaseAccept>, o: Opts = {}) => request(`/merchant-portal/leases/${idPath(id)}/accept`, { schema: PosLeaseView, method: 'POST', body, ...o });
export const deliverLease = (id: string, body: z.input<typeof PosLeaseDeliver>, o: Opts = {}) => request(`/merchant-portal/leases/${idPath(id)}/deliver`, { schema: PosLeaseView, method: 'POST', body, ...o });
export const cancelLease = (id: string, body: z.input<typeof PosLeaseCancel>, o: Opts = {}) => request(`/merchant-portal/leases/${idPath(id)}/cancel`, { schema: PosLeaseView, method: 'POST', body, ...o });

// ───────────── Back-office ─────────────
export const listMerchants = (q: MerchantListParams, o: Opts = {}) => request('/merchants', { schema: PagedMerchants, query: { ...q }, ...o });
export const createMerchant = (body: z.input<typeof MerchantCreate>, o: Opts = {}) => request('/merchants', { schema: MerchantView, method: 'POST', body, ...o });
export const getMerchant = (id: string, o: Opts = {}) => request(`/merchants/${idPath(id)}`, { schema: MerchantView, ...o });
export const updateMerchant = (id: string, body: z.input<typeof MerchantUpdate>, o: Opts = {}) => request(`/merchants/${idPath(id)}`, { schema: MerchantView, method: 'PATCH', body, ...o });
export const changeMerchantStatus = (id: string, body: z.input<typeof MerchantStatusChange>, o: Opts = {}) => request(`/merchants/${idPath(id)}/status`, { schema: MerchantView, method: 'POST', body, ...o });
export const listStores = (merchantId: string, o: Opts = {}) => request(`/merchants/${idPath(merchantId)}/stores`, { schema: z.array(StoreView), ...o });
export const createStore = (merchantId: string, body: z.input<typeof StoreCreate>, o: Opts = {}) => request(`/merchants/${idPath(merchantId)}/stores`, { schema: StoreView, method: 'POST', body, ...o });
export const updateStore = (merchantId: string, storeId: string, body: z.input<typeof StoreUpdate>, o: Opts = {}) =>
  request(`/merchants/${idPath(merchantId)}/stores/${idPath(storeId)}`, { schema: StoreView, method: 'PATCH', body, ...o });
export const listPlans = (q: PlanListParams, o: Opts = {}) => request('/pos-plans', { schema: z.array(PlanView), query: { ...q }, ...o });
export const createPlan = (body: z.input<typeof PlanCreate>, o: Opts = {}) => request('/pos-plans', { schema: PlanView, method: 'POST', body, ...o });
export const updatePlan = (id: string, body: z.input<typeof PlanUpdate>, o: Opts = {}) => request(`/pos-plans/${idPath(id)}`, { schema: PlanView, method: 'PATCH', body, ...o });
export const listAdminLeases = (q: AdminLeaseListParams, o: Opts = {}) => request('/pos-leases', { schema: PagedLeases, query: { ...q }, ...o });
export const getAdminLease = (id: string, o: Opts = {}) => request(`/pos-leases/${idPath(id)}`, { schema: PosLeaseAdminView, ...o });
export const reviewLease = (id: string, body: z.input<typeof PosLeaseReview>, o: Opts = {}) => request(`/pos-leases/${idPath(id)}/review`, { schema: PosLeaseAdminView, method: 'POST', body, ...o });
export const settleLease = (id: string, body: z.input<typeof PosLeaseSettle>, o: Opts = {}) => request(`/pos-leases/${idPath(id)}/settle`, { schema: PosLeaseAdminView, method: 'POST', body, ...o });

// ───────────── TanStack Query түлхүүр ─────────────
export const merchantKeys = {
  me: () => ['merchant', 'me'] as const,
  dashboard: (p: DashboardParams) => ['merchant', 'dashboard', p] as const,
  quote: (p: z.input<typeof PosQuoteRequest>) => ['merchant', 'quote', p] as const,
  leases: (p: LeaseListParams) => ['merchant', 'leases', p] as const,
  leasesAll: () => ['merchant', 'leases'] as const,
  lease: (id: string) => ['merchant', 'lease', id] as const,
  dashboardAll: () => ['merchant', 'dashboard'] as const,
};
export const backOfficeKeys = {
  merchants: (p: MerchantListParams) => ['backoffice', 'merchants', p] as const,
  merchantsAll: () => ['backoffice', 'merchants'] as const,
  merchant: (id: string) => ['backoffice', 'merchant', id] as const,
  stores: (merchantId: string) => ['backoffice', 'stores', merchantId] as const,
  plans: (p: PlanListParams) => ['backoffice', 'plans', p] as const,
  plansAll: () => ['backoffice', 'plans'] as const,
  leases: (p: AdminLeaseListParams) => ['backoffice', 'leases', p] as const,
  leasesAll: () => ['backoffice', 'leases'] as const,
  lease: (id: string) => ['backoffice', 'lease', id] as const,
};
