// FR-13.1 · Хар/саарал жагсаалт API. Gateway-ээр: `/origination/blacklist` (GET — нэвтэрсэн дурын дүр; бичих — `blacklist:manage`).
import { AuditLogPage, BlacklistEntry, type BlacklistEntryInput, type BlacklistEntryUpdate, type BlacklistSeverity } from '@los/contracts';
import { z } from 'zod';
import { originationFetch, qs } from '../../lib/api';

export interface BlacklistListParams { q?: string; severity?: BlacklistSeverity; isActive?: boolean; limit: number; offset: number }
const Page = z.object({ total: z.number(), items: z.array(BlacklistEntry) });
export type BlacklistPage = z.infer<typeof Page>;

export const fetchBlacklist = (p: BlacklistListParams) => originationFetch<BlacklistPage>(`/blacklist${qs({ ...p })}`, { schema: Page });
export const createBlacklistEntry = (body: BlacklistEntryInput) => originationFetch<BlacklistEntry>('/blacklist', { method: 'POST', body, schema: BlacklistEntry });
export const updateBlacklistEntry = (id: string, body: BlacklistEntryUpdate) => originationFetch<BlacklistEntry>(`/blacklist/${encodeURIComponent(id)}`, { method: 'PATCH', body, schema: BlacklistEntry });
export const deactivateBlacklistEntry = (id: string) => originationFetch<BlacklistEntry>(`/blacklist/${encodeURIComponent(id)}`, { method: 'DELETE', schema: BlacklistEntry });
/** FR-13.5: нэг бичлэгийн өөрчлөлтийн түүх (origination audit_log; `audit:read` — ADMIN). */
export const fetchBlacklistHistory = (id: string) => originationFetch<AuditLogPage>(`/audit-logs${qs({ entity: 'blacklist', entityId: id, pageSize: 50 })}`, { schema: AuditLogPage });
