import { BsaLosOverview, BsaLosPushResponse, BsaSuspicionListResponse, BsaCombinedSummary, type BsaLosCreateAnalysisBody, type BsaResolveSuspicionsRequest, type ReviewStatus, type SuspicionFlag } from '@los/contracts';
import { API, apiDownload, apiFetch, authFetch, originationFetch, qs } from '../../lib/api';
import { ApiError } from '../../lib/http';

// LOS талын (origination) BSA: `/origination/applications/:id/bsa…`; scoring-ийн шинжилгээ: `/scoring/bsa/analyses/:id…` (gateway-ээр).
const orig = (id: string): string => `/applications/${encodeURIComponent(id)}/bsa`;
const sc = (id: string): string => `/scoring/bsa/analyses/${encodeURIComponent(id)}`;

export const fetchOverview = (appId: string): Promise<BsaLosOverview> => originationFetch(orig(appId), { schema: BsaLosOverview });
export const createAnalysis = (appId: string, body: BsaLosCreateAnalysisBody): Promise<unknown> => originationFetch(`${orig(appId)}/analyses`, { method: 'POST', json: body });
export const pushAnalysis = (appId: string, analysisId: string): Promise<BsaLosPushResponse> => originationFetch(`${orig(appId)}/analyses/${encodeURIComponent(analysisId)}/push`, { method: 'POST', json: {}, schema: BsaLosPushResponse });
export const syncPayment = (appId: string): Promise<{ updated: number }> => originationFetch(`${orig(appId)}/sync-payment`, { method: 'POST', json: {} });

export interface BsaAnalysisBrief {
  id: string; status: 'DRAFT' | 'ANALYZED'; version: number; applicationId: string;
  summary: { dtiIncome: number; existingDebtServiceMonthly: number; dtiPercent: number | null; netCashFlowMonthly: number; pendingSuspiciousCount: number } | null;
}
export interface BsaJobBrief { id: string; fileName: string; status: string }
export const fetchAnalysis = (id: string): Promise<BsaAnalysisBrief> => apiFetch(sc(id));
export const fetchJobs = (id: string): Promise<{ items: BsaJobBrief[] }> => apiFetch(`${sc(id)}/imports`);
export const recalculate = (id: string): Promise<unknown> => apiFetch(`${sc(id)}/recalculate`, { method: 'POST', json: {} });
export const fetchSuspicions = (id: string, q: { status?: ReviewStatus; flag?: SuspicionFlag; offset?: number; limit?: number }): Promise<BsaSuspicionListResponse> =>
  apiFetch(`${sc(id)}/suspicions${qs(q)}`, { schema: BsaSuspicionListResponse });
export const resolveSuspicions = (id: string, body: BsaResolveSuspicionsRequest): Promise<unknown> => apiFetch(`${sc(id)}/suspicions/resolve`, { method: 'POST', json: body });
export const fetchCombined = (appId: string): Promise<BsaCombinedSummary> => apiFetch(`/scoring/bsa/applications/${encodeURIComponent(appId)}/combined`, { schema: BsaCombinedSummary });
export const downloadReport = (id: string): Promise<void> => apiDownload(`${sc(id)}/report.pdf`, 'bsa-report.pdf');
export const downloadIncomeSample = (id: string): Promise<void> => apiDownload(`${sc(id)}/income-sample.xlsx`, 'income-sample.xlsx');

export async function uploadStatements(id: string, files: File[]): Promise<void> {
  const form = new FormData();
  for (const f of files) form.append('files', f);
  const res = await authFetch(`${API}${sc(id)}/imports`, { method: 'POST', body: form });
  if (!res.ok) throw new ApiError(res.status, null, res.statusText);
}
