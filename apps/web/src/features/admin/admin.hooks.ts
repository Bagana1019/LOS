import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AuditLogQuery, ContractNumberTemplateBody, ReplaceApprovalLevelsBody } from '@los/contracts';
import * as api from './admin.api';

const key = (...p: unknown[]) => ['admin', ...p] as const;

export const useLevels = () => useQuery({ queryKey: key('levels'), queryFn: api.fetchLevels });
export const useUsers = () => useQuery({ queryKey: key('users'), queryFn: api.fetchUsers });
export const useBranches = () => useQuery({ queryKey: key('branches'), queryFn: api.fetchBranches });
export const useSettings = () => useQuery({ queryKey: key('settings'), queryFn: api.fetchSettings });
export const useTemplate = () => useQuery({ queryKey: key('template'), queryFn: api.fetchTemplate });
export const useAudit = (source: 'origination' | 'auth', q: Partial<AuditLogQuery>) =>
  useQuery({ queryKey: key('audit', source, q), queryFn: () => (source === 'auth' ? api.fetchAuthAudit(q) : api.fetchOriginationAudit(q)) });

export function useSaveLevels() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (b: ReplaceApprovalLevelsBody) => api.saveLevels(b), onSuccess: (data) => qc.setQueryData(key('levels'), data) });
}
export function useSaveSetting() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (v: { key: string; value: unknown }) => api.saveSetting(v.key, v.value), onSuccess: () => qc.invalidateQueries({ queryKey: key('settings') }) });
}
export function useSaveTemplate() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (b: ContractNumberTemplateBody) => api.saveTemplate(b), onSuccess: () => qc.invalidateQueries({ queryKey: key('template') }) });
}
export function useAssignBranch() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (v: { userId: string; branchId: string | null }) => api.assignUserBranch(v.userId, v.branchId), onSuccess: () => qc.invalidateQueries({ queryKey: key('users') }) });
}
