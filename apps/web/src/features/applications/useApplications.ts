import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateApplicationRequest, TransitionRequest } from '@los/contracts';
import * as api from './applications.api';

export const applicationsKey = ['applications'] as const;
export const applicationListKey = (params: api.ListParams) => [...applicationsKey, 'list', params] as const;
export const applicationDetailKey = (id: string) => [...applicationsKey, 'detail', id] as const;

const retryTransient = (failureCount: number, error: unknown): boolean => {
  const status = (error as { status?: unknown } | null)?.status;
  return failureCount < 1 && !(typeof status === 'number' && status < 500);
};

export const useApplicationList = (params: api.ListParams) =>
  useQuery({ queryKey: applicationListKey(params), queryFn: () => api.fetchApplications(params), placeholderData: keepPreviousData, retry: retryTransient });

export const useApplication = (id: string) =>
  useQuery({ queryKey: applicationDetailKey(id), queryFn: () => api.fetchApplication(id), retry: retryTransient, refetchOnMount: 'always' });

export function useCreateApplication() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (body: CreateApplicationRequest) => api.createApplication(body), onSuccess: () => qc.invalidateQueries({ queryKey: applicationsKey }) });
}

export function useTransition(id: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (body: TransitionRequest) => api.transitionApplication(id, body), onSettled: () => qc.invalidateQueries({ queryKey: applicationsKey }) });
}

/** Алхмын бүрдэл өөрчлөгдсөний дараа wizard-ийн зүүн самбарыг шинэчлэх. */
export function useRefreshApplication(id: string) {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: applicationDetailKey(id) });
}
