import { BsaLosOverview, BsaLosPushResponse, BsaSuspicionListResponse, BsaCombinedSummary, type BankCode, type BsaAnalysisDetails, type BsaLosCreateAnalysisBody, type BsaResolveSuspicionsRequest, type ReviewStatus, type SuspicionFlag } from '@los/contracts';
import { API, apiDownload, apiFetch, authFetch, originationFetch, qs } from '../../lib/api';
import { ApiError } from '../../lib/http';
import { banksField, type BsaCategory } from './bsa.helpers';

// LOS талын (origination) BSA: `/origination/applications/:id/bsa…`; scoring-ийн шинжилгээ: `/scoring/bsa/analyses/:id…` (gateway-ээр).
const orig = (id: string): string => `/applications/${encodeURIComponent(id)}/bsa`;
const sc = (id: string): string => `/scoring/bsa/analyses/${encodeURIComponent(id)}`;

export const fetchOverview = (appId: string): Promise<BsaLosOverview> => originationFetch(orig(appId), { schema: BsaLosOverview });
export const createAnalysis = (appId: string, body: BsaLosCreateAnalysisBody): Promise<unknown> => originationFetch(`${orig(appId)}/analyses`, { method: 'POST', json: body });
export const pushAnalysis = (appId: string, analysisId: string): Promise<BsaLosPushResponse> => originationFetch(`${orig(appId)}/analyses/${encodeURIComponent(analysisId)}/push`, { method: 'POST', json: {}, schema: BsaLosPushResponse });
export const syncPayment = (appId: string): Promise<{ updated: number }> => originationFetch(`${orig(appId)}/sync-payment`, { method: 'POST', json: {} });

/** scoring `AnalysisOverview.warnings`: шинжилгээний (хугацаа/ангилал/хамрах хугацаа) болон импорт ажлын анхааруулга, алдаа. */
export interface AnalysisWarning { code: string; message: string; severity: 'ERROR' | 'WARNING'; scope: 'ANALYSIS' | 'JOB' }
export interface BsaAnalysisBrief {
  id: string; status: 'DRAFT' | 'ANALYZED'; version: number; applicationId: string;
  summary: { dtiIncome: number; existingDebtServiceMonthly: number; dtiPercent: number | null; netCashFlowMonthly: number; pendingSuspiciousCount: number } | null;
  /** Одоогийн гүйлгээнээс тооцсон дэлгэрэнгүй (аргачлал, задаргаа, ӨОХ-ийн тойм); тооцоолоогүй бол null. */
  details: BsaAnalysisDetails | null;
  warnings: AnalysisWarning[];
  /** Хадгалагдсан хураангуй одоогийн гүйлгээ/параметрээс ялгаатай. */
  summaryStale: boolean;
}
export interface BsaJobBrief { id: string; fileName: string; status: string; bankCode?: string | null; errors?: { code: string; message: string }[] }
/** scoring `GET /bsa/analyses/:id` хариу: `{ analysis: {...мета}, summary, ... }` (задгай биш) — UI-н хүлээдэг хавтгай хэлбэр рүү хөрвүүлнэ. */
export interface ScoringAnalysisOverview {
  analysis: { id: string; applicationId: string; status: 'DRAFT' | 'ANALYZED'; version: number };
  summary: BsaAnalysisBrief['summary'];
  details?: BsaAnalysisDetails | null;
  warnings?: AnalysisWarning[];
  summaryStale?: boolean;
}
export const toAnalysisBrief = (o: ScoringAnalysisOverview): BsaAnalysisBrief => ({
  id: o.analysis.id, status: o.analysis.status, version: o.analysis.version, applicationId: o.analysis.applicationId, summary: o.summary ?? null,
  details: o.details ?? null, warnings: o.warnings ?? [], summaryStale: o.summaryStale ?? false,
});
export const fetchAnalysis = async (id: string): Promise<BsaAnalysisBrief> => toAnalysisBrief(await apiFetch<ScoringAnalysisOverview>(sc(id)));
export const fetchJobs = (id: string): Promise<{ items: BsaJobBrief[] }> => apiFetch(`${sc(id)}/imports`);
export const recalculate = (id: string): Promise<unknown> => apiFetch(`${sc(id)}/recalculate`, { method: 'POST', json: {} });
export const fetchSuspicions = (id: string, q: { status?: ReviewStatus; flag?: SuspicionFlag; offset?: number; limit?: number }): Promise<BsaSuspicionListResponse> =>
  apiFetch(`${sc(id)}/suspicions${qs(q)}`, { schema: BsaSuspicionListResponse });
export const resolveSuspicions = (id: string, body: BsaResolveSuspicionsRequest): Promise<unknown> => apiFetch(`${sc(id)}/suspicions/resolve`, { method: 'POST', json: body });
export const fetchCombined = (appId: string): Promise<BsaCombinedSummary> => apiFetch(`/scoring/bsa/applications/${encodeURIComponent(appId)}/combined`, { schema: BsaCombinedSummary });
export const downloadReport = (id: string): Promise<void> => apiDownload(`${sc(id)}/report.pdf`, 'bsa-report.pdf');
export const downloadIncomeSample = (id: string): Promise<void> => apiDownload(`${sc(id)}/income-sample.xlsx`, 'income-sample.xlsx');

/** BSA-FR-2.1/2.6: амжилтгүй (банк танигдаагүй) ажлыг банкаа гараар сонгож дахин оруулна; `bankCode` өгөхгүй бол автоматаар таниулна. */
export const retryJob = (jobId: string, bankCode?: BankCode): Promise<unknown> =>
  apiFetch(`/scoring/bsa/jobs/${encodeURIComponent(jobId)}/retry`, { method: 'POST', json: bankCode ? { bankCode } : {} });
/** Ангиллын жагсаалт (идэвхтэй) — «Ангилал солих» Select ба гүйлгээний ангиллын нэр. */
export const fetchCategories = (): Promise<BsaCategory[]> => apiFetch('/scoring/bsa/categories');

/** `bank` өгвөл `banks` талбараар файл бүрт тэр банкийг заана (автомат таних дарагдана); өгөхгүй бол сервер таниулна. */
export async function uploadStatements(id: string, files: File[], bank?: BankCode): Promise<void> {
  const form = new FormData();
  const banks = banksField(files.length, bank);
  if (banks) form.append('banks', banks);
  for (const f of files) form.append('files', f);
  const res = await authFetch(`${API}${sc(id)}/imports`, { method: 'POST', body: form });
  if (!res.ok) throw new ApiError(res.status, null, res.statusText);
}
