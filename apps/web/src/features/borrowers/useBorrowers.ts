import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AddBorrowerRequest, RecordConsentRequest, UpdateBorrowerRequest } from '@los/contracts';
import * as api from './borrowers.api';
import { isStaleStateError } from './borrowers.utils';

// Query түлхүүр: ['borrowers', applicationId, 'list'|'candidates', …]. Мутаци бүрийн дараа `['borrowers', applicationId]`-г бүхэлд нь шинэчилнэ.
export const borrowersKey = (applicationId: string) => ['borrowers', applicationId] as const;
export const borrowerListKey = (applicationId: string) => [...borrowersKey(applicationId), 'list'] as const;
export const borrowerCandidatesKey = (applicationId: string, registerNo: string) => [...borrowersKey(applicationId), 'candidates', registerNo] as const;

/** 4xx (эрх, олдсонгүй, дүрмийн зөрчил) дахин оролдсоноор засагдахгүй. Сүлжээ/серверийн алдааг л нэг удаа дахин оролдоно. */
const retryTransient = (failureCount: number, error: unknown): boolean => {
  const status = (error as { status?: unknown } | null)?.status;
  return failureCount < 1 && !(typeof status === 'number' && status < 500);
};

export function useBorrowerList(applicationId: string) {
  return useQuery({ queryKey: borrowerListKey(applicationId), queryFn: () => api.fetchBorrowers(applicationId), retry: retryTransient });
}

/** `registerNo` нь нормчилсон хайлтын утга; null бол хайлт эхлээгүй. */
export function useBorrowerCandidates(applicationId: string, registerNo: string | null) {
  return useQuery({
    queryKey: borrowerCandidatesKey(applicationId, registerNo ?? ''),
    queryFn: () => api.fetchCandidates(applicationId, registerNo as string),
    enabled: registerNo !== null,
    retry: retryTransient,
    staleTime: 0,
  });
}

/**
 * Мутаци амжилттай бол жагсаалтыг шинэчилнэ, `onChanged` (жишээ нь wizard-н алхмуудын төлөвийг дахин татах) дуудна.
 * 404/409 алдаа — сервер дээрх төлөв манайхаас зөрсөн тул жагсаалтыг дахин татна.
 */
function useBorrowerMutation<TVars, TData>(applicationId: string, mutationFn: (vars: TVars) => Promise<TData>, onChanged?: () => void) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: borrowersKey(applicationId) });
  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await refresh();
      onChanged?.();
    },
    onError: (error) => {
      if (isStaleStateError(error)) void refresh();
    },
  });
}

export const useAddBorrower = (applicationId: string, onChanged?: () => void) =>
  useBorrowerMutation(applicationId, (body: AddBorrowerRequest) => api.addBorrower(applicationId, body), onChanged);

export const useUpdateBorrower = (applicationId: string, onChanged?: () => void) =>
  useBorrowerMutation(applicationId, (v: { borrowerId: string; body: UpdateBorrowerRequest }) => api.updateBorrower(applicationId, v.borrowerId, v.body), onChanged);

export const useRemoveBorrower = (applicationId: string, onChanged?: () => void) =>
  useBorrowerMutation(applicationId, (v: { borrowerId: string }) => api.removeBorrower(applicationId, v.borrowerId), onChanged);

export const useMakePrimary = (applicationId: string, onChanged?: () => void) =>
  useBorrowerMutation(applicationId, (v: { borrowerId: string }) => api.makePrimary(applicationId, v.borrowerId), onChanged);

export const useRecordConsent = (applicationId: string, onChanged?: () => void) =>
  useBorrowerMutation(applicationId, (v: { borrowerId: string; body: RecordConsentRequest }) => api.recordConsent(applicationId, v.borrowerId, v.body), onChanged);
