import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BlacklistEntryInput, BlacklistEntryUpdate } from '@los/contracts';
import * as api from './blacklist.api';

export const blacklistKey = ['blacklist'] as const;

export const useBlacklistList = (p: api.BlacklistListParams) =>
  useQuery({ queryKey: [...blacklistKey, 'list', p], queryFn: () => api.fetchBlacklist(p), placeholderData: keepPreviousData });
export const useBlacklistHistory = (id: string | null) =>
  useQuery({ queryKey: [...blacklistKey, 'history', id], queryFn: () => api.fetchBlacklistHistory(id as string), enabled: id !== null });

function useInvalidating<V, R>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: blacklistKey }) });
}
export const useCreateBlacklist = () => useInvalidating((b: BlacklistEntryInput) => api.createBlacklistEntry(b));
export const useUpdateBlacklist = () => useInvalidating((v: { id: string; body: BlacklistEntryUpdate }) => api.updateBlacklistEntry(v.id, v.body));
export const useDeactivateBlacklist = () => useInvalidating((id: string) => api.deactivateBlacklistEntry(id));
