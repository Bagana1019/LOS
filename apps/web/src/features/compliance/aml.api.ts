// docs/05-compliance-aml.md §7 · AML hit шийдвэрлэх API. Web → зөвхөн gateway (`/kyc/aml/*` → kyc `/api/aml/*`).
// Дараалал, шийдвэр — gateway route-policy `aml:review` (COMPLIANCE); дэлгэрэнгүй — нэвтэрсэн дурын хэрэглэгч (kyc org-оор шүүнэ).
import { AmlHitQueuePage, AmlScreeningDetail, AmlScreeningResult, type AmlHitReviewRequest } from '@los/contracts';
import { apiFetch, qs } from '../../lib/api';
import type { AmlQueueTab } from './aml.utils';

const KYC_AML = '/kyc/aml';

export interface AmlQueueParams { limit: number; offset: number; status: AmlQueueTab }

/** Харилцагч тутмын ОДООГИЙН шалгалтын hit-үүд, `status`-аар шүүнэ (`ALL` — шүүлтүүргүй, шийдвэрлэгдсэнийг оруулна). */
export const fetchAmlQueue = (p: AmlQueueParams) =>
  apiFetch<AmlHitQueuePage>(`${KYC_AML}/hits${qs({ status: p.status === 'ALL' ? undefined : p.status, limit: p.limit, offset: p.offset })}`, { schema: AmlHitQueuePage });

export const fetchAmlScreening = (id: string) =>
  apiFetch<AmlScreeningDetail>(`${KYC_AML}/screenings/${encodeURIComponent(id)}`, { schema: AmlScreeningDetail });

/** Шийдвэр өөрчлөгдөхгүй; тайлбар заавал (5–2000). Хариу — хадгалагдсан screening. */
export const reviewAmlHit = (hitId: string, body: AmlHitReviewRequest) =>
  apiFetch<AmlScreeningResult>(`${KYC_AML}/hits/${encodeURIComponent(hitId)}/review`, { method: 'POST', body, schema: AmlScreeningResult });
