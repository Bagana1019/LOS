import { IDEMPOTENCY_KEY_HEADER, type ApplicationDetail, type ApplicationHistoryResponse, type ApplicationListResponse, type CreateApplicationRequest, type TransitionRequest } from '@los/contracts';
import { API, authFetch, ORIGINATION, originationDownload, originationFetch, qs } from '../../lib/api';
import { newCorrelationId, readError } from '../../lib/http';

// Gateway → origination: `/api/origination/applications…` (apps/origination/src/modules/application).
const enc = encodeURIComponent;
export type ListParams = Record<string, string | number | undefined>;

export const fetchApplications = (params: ListParams): Promise<ApplicationListResponse> => originationFetch<ApplicationListResponse>(`/applications${qs(params)}`);
export const fetchApplication = (id: string): Promise<ApplicationDetail> => originationFetch<ApplicationDetail>(`/applications/${enc(id)}`);
export const fetchApplicationHistory = (id: string): Promise<ApplicationHistoryResponse> => originationFetch<ApplicationHistoryResponse>(`/applications/${enc(id)}/history`);
/**
 * `Idempotency-Key` (M1): сервер ижил түлхүүр + ижил биеийг дахин үүсгэхгүй, анхны хүсэлтийг 200-аар буцаана. `apiFetch` нь толгой дэмждэггүй тул `authFetch`
 * (bearer + 401 дээр token шинэчлээд ИЖИЛ толгойгоор давтана). Алдаа нь `apiFetch`-тэй ижил: HTTP → ApiError, сүлжээ → fetch-ийн анхны TypeError.
 */
export async function createApplication(body: CreateApplicationRequest, idempotencyKey?: string): Promise<ApplicationDetail> {
  const correlationId = newCorrelationId();
  const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json', 'x-correlation-id': correlationId };
  if (idempotencyKey) headers[IDEMPOTENCY_KEY_HEADER] = idempotencyKey;
  const res = await authFetch(`${API}${ORIGINATION}/applications`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw await readError(res, correlationId);
  return (await res.json()) as ApplicationDetail;
}
export const transitionApplication = (id: string, body: TransitionRequest): Promise<ApplicationDetail> =>
  originationFetch<ApplicationDetail>(`/applications/${enc(id)}/transition`, { method: 'POST', json: body });
/** Excel (.xlsx) — одоогийн шүүлт, хуудаслалтгүй. */
export const downloadApplications = (params: ListParams): Promise<void> => originationDownload(`/applications/export${qs(params)}`, 'loan-applications.xlsx');
