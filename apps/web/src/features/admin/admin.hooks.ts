import { useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChangeRequestPage, type AuditLogQuery, type ContractNumberTemplateBody, type CreateBranchBody, type CreateUserBody, type ProductCreateRequest, type ProductSetActiveRequest, type ProductUpdateRequest,
  type ReplaceApprovalLevelsRequest, type SavePricingTiersRequest, type UpdateBranchBody, type UpdateUserBody,
} from '@los/contracts';
import { listRequests } from '../maker-checker/api';
import * as api from './admin.api';
import { distinctAuditValues } from './audit-filters';

const key = (...p: unknown[]) => ['admin', ...p] as const;

export const useLevels = () => useQuery({ queryKey: key('levels'), queryFn: api.fetchLevels });
export const useUsers = () => useQuery({ queryKey: key('users'), queryFn: api.fetchUsers });
export const useBranches = () => useQuery({ queryKey: key('branches'), queryFn: api.fetchBranches });
export const useSettings = () => useQuery({ queryKey: key('settings'), queryFn: api.fetchSettings });
export const useTemplate = () => useQuery({ queryKey: key('template'), queryFn: api.fetchTemplate });
export const useAudit = (source: 'origination' | 'auth', q: Partial<AuditLogQuery>) =>
  useQuery({ queryKey: key('audit', source, q), queryFn: () => (source === 'auth' ? api.fetchAuthAudit(q) : api.fetchOriginationAudit(q)) });

/** Contracts `AuditLogQuery.pageSize`-ийн дээд хэмжээ: объект/үйлдлийн сонголтыг API-ийн сүүлийн мөрүүдийн бодит утгаас гаргана. */
const AUDIT_FACET_SAMPLE_SIZE = 200;
const AUDIT_FACET_STALE_MS = 5 * 60_000;
/** F9-24 · Объект/үйлдлийн санал болгох жагсаалт: шүүлтгүй сүүлийн мөрүүдийн бодит (давхардалгүй) утга. */
export const useAuditFacets = (source: 'origination' | 'auth') =>
  useQuery({
    queryKey: key('audit-facets', source),
    queryFn: () => (source === 'auth' ? api.fetchAuthAudit({ pageSize: AUDIT_FACET_SAMPLE_SIZE }) : api.fetchOriginationAudit({ pageSize: AUDIT_FACET_SAMPLE_SIZE })),
    select: (page) => distinctAuditValues(page.items),
    staleTime: AUDIT_FACET_STALE_MS,
  });

/** F9-24 · "Хэн" шүүлт: нэр/нэвтрэх нэрээр хайлт (алдаа гарвал дахин оролдохгүй — хайлтын талбар шууд мэдэгдэнэ). */
export const useAuditActors = (q: string) =>
  useQuery({ queryKey: key('audit-actors', q), queryFn: () => api.fetchAuditActors(q), staleTime: 60_000, retry: false, placeholderData: keepPreviousData });

/** Бичиж дуусахыг хүлээж утгыг хойшлуулна (хайлт бүрийн товчлуур бүрт дуудлага явуулахгүй). */
export function useDebouncedText(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

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

/** FR-13: дүр/салбар/төлөв өөрчлөгдөхөд салбарын хэрэглэгчийн тоо ч өөрчлөгдөх тул хоёуланг шинэчилнэ */
function useAdminMutation<V, R>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: key('users') }), qc.invalidateQueries({ queryKey: key('branches') })]) });
}
export const useCreateBranch = () => useAdminMutation((b: CreateBranchBody) => api.createBranch(b));
export const useUpdateBranch = () => useAdminMutation((v: { id: string; body: UpdateBranchBody }) => api.updateBranch(v.id, v.body));
export const useSetBranchActive = () => useAdminMutation((v: { id: string; active: boolean }) => api.setBranchActive(v.id, v.active));
export const useCreateUser = () => useAdminMutation((b: CreateUserBody) => api.createUser(b));
export const useUpdateUser = () => useAdminMutation((v: { id: string; body: UpdateUserBody }) => api.updateUser(v.id, v.body));
export const useSetUserActive = () => useAdminMutation((v: { id: string; active: boolean }) => api.setUserActive(v.id, v.active));
export const useResetUserPassword = () => useAdminMutation((id: string) => api.resetUserPassword(id));
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
