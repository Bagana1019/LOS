import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BsaLosCreateAnalysisBody, BsaResolveSuspicionsRequest, ReviewStatus, SuspicionFlag } from '@los/contracts';
import * as api from './bsa.api';

export const bsaKey = (appId: string) => ['bsa', appId] as const;
const analysisKey = (id: string) => ['bsa-analysis', id] as const;

export const useBsaOverview = (appId: string) => useQuery({ queryKey: bsaKey(appId), queryFn: () => api.fetchOverview(appId), retry: false });
export const useCombined = (appId: string, enabled: boolean) => useQuery({ queryKey: ['bsa-combined', appId], queryFn: () => api.fetchCombined(appId), enabled, retry: false });
export const useAnalysis = (id: string) => useQuery({ queryKey: analysisKey(id), queryFn: () => api.fetchAnalysis(id), retry: false, refetchInterval: 4000 });
export const useJobs = (id: string) => useQuery({ queryKey: ['bsa-jobs', id], queryFn: () => api.fetchJobs(id), retry: false, refetchInterval: 4000 });
export const useSuspicions = (id: string, q: { status?: ReviewStatus; flag?: SuspicionFlag }) =>
  useQuery({ queryKey: ['bsa-susp', id, q], queryFn: () => api.fetchSuspicions(id, { ...q, limit: 100 }), retry: false });

function useInvalidating<V, R>(appId: string, analysisId: string | null, fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: bsaKey(appId) }), qc.invalidateQueries({ queryKey: ['bsa-combined', appId] }), qc.invalidateQueries({ queryKey: ['application', appId] }),
        ...(analysisId ? [qc.invalidateQueries({ queryKey: analysisKey(analysisId) }), qc.invalidateQueries({ queryKey: ['bsa-susp', analysisId] }), qc.invalidateQueries({ queryKey: ['bsa-jobs', analysisId] })] : [])]);
    },
  });
}

export const useCreateAnalysis = (appId: string) => useInvalidating(appId, null, (b: BsaLosCreateAnalysisBody) => api.createAnalysis(appId, b));
export const usePush = (appId: string) => useInvalidating(appId, null, (analysisId: string) => api.pushAnalysis(appId, analysisId));
export const useSyncPayment = (appId: string) => useInvalidating(appId, null, () => api.syncPayment(appId));
export const useRecalculate = (appId: string, id: string) => useInvalidating(appId, id, () => api.recalculate(id));
export const useUpload = (appId: string, id: string) => useInvalidating(appId, id, (files: File[]) => api.uploadStatements(id, files));
export const useResolve = (appId: string, id: string) => useInvalidating(appId, id, (b: BsaResolveSuspicionsRequest) => api.resolveSuspicions(id, b));
