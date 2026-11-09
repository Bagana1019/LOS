import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChangeRequestPage, type AuditLogQuery, type ContractNumberTemplateBody, type ProductCreateRequest, type ProductSetActiveRequest, type ProductUpdateRequest,
  type ReplaceApprovalLevelsRequest, type SavePricingTiersRequest,
} from '@los/contracts';
import { listRequests } from '../maker-checker/api';
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
  return useMutation({ mutationFn: (b: ReplaceApprovalLevelsRequest) => api.saveLevels(b), onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: key('levels') }), qc.invalidateQueries({ queryKey: ['maker-checker'] })]) });
}
export function useProposeSetting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { key: string; value: unknown; reason: string }) => api.proposeSetting(v.key, v.value, v.reason),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: key('settings') }), qc.invalidateQueries({ queryKey: ['maker-checker'] })]),
  });
}
/** Q-124: тухайн зорилтод хүлээгдэж буй (PENDING) санал — админ хуудсанд анхааруулга, /los/maker-checker руу холбоос. Зөвхөн ADMIN (scope=all). */
export const usePendingChanges = (targetType: string) =>
  useQuery({
    queryKey: ['maker-checker', 'pending', targetType],
    queryFn: ({ signal }) => listRequests({ scope: 'all', status: 'PENDING', targetType, page: 1, pageSize: 20 }, signal),
    select: (p: ChangeRequestPage) => p.items,
  });
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

// ── Бүтээгдэхүүн (4 нүд) ба үнэлгээний шатлал ──
export const useProducts = () => useQuery({ queryKey: key('products'), queryFn: api.fetchProducts });
export function useProductMutation() {
  const qc = useQueryClient();
  type Vars =
    | { kind: 'create'; body: ProductCreateRequest }
    | { kind: 'update'; id: string; body: ProductUpdateRequest }
    | { kind: 'active'; id: string; body: ProductSetActiveRequest };
  return useMutation({
    mutationFn: (v: Vars) => (v.kind === 'create' ? api.proposeProductCreate(v.body) : v.kind === 'update' ? api.proposeProductUpdate(v.id, v.body) : api.proposeProductActive(v.id, v.body)),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: key('products') }), qc.invalidateQueries({ queryKey: ['maker-checker'] })]),
  });
}
export const usePricingTiers = (productId: string | null) => useQuery({ queryKey: key('pricing', productId), queryFn: () => api.fetchPricingTiers(productId), retry: false });
export function useSavePricingTiers() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (b: SavePricingTiersRequest) => api.savePricingTiers(b), onSuccess: () => qc.invalidateQueries({ queryKey: key('pricing') }) });
}
