import type { ApplicationDetail, ApplicationHistoryResponse, ApplicationListResponse, CreateApplicationRequest, TransitionRequest } from '@los/contracts';
import { originationDownload, originationFetch, qs } from '../../lib/api';

// Gateway → origination: `/api/origination/applications…` (apps/origination/src/modules/application).
const enc = encodeURIComponent;
export type ListParams = Record<string, string | number | undefined>;

export const fetchApplications = (params: ListParams): Promise<ApplicationListResponse> => originationFetch<ApplicationListResponse>(`/applications${qs(params)}`);
export const fetchApplication = (id: string): Promise<ApplicationDetail> => originationFetch<ApplicationDetail>(`/applications/${enc(id)}`);
export const fetchApplicationHistory = (id: string): Promise<ApplicationHistoryResponse> => originationFetch<ApplicationHistoryResponse>(`/applications/${enc(id)}/history`);
export const createApplication = (body: CreateApplicationRequest): Promise<ApplicationDetail> => originationFetch<ApplicationDetail>('/applications', { method: 'POST', json: body });
export const transitionApplication = (id: string, body: TransitionRequest): Promise<ApplicationDetail> =>
  originationFetch<ApplicationDetail>(`/applications/${enc(id)}/transition`, { method: 'POST', json: body });
/** Excel (.xlsx) — одоогийн шүүлт, хуудаслалтгүй. */
export const downloadApplications = (params: ListParams): Promise<void> => originationDownload(`/applications/export${qs(params)}`, 'loan-applications.xlsx');
