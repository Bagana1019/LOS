// M13 · Админ API. Gateway-ээр л: origination → `/origination/...`, өөрийн (iam) → `/admin/...`.
import {
  AdminBranchDto, AdminUserDto, ApprovalLevelDto, AuditLogPage, SubmitChangeResult, UserCredentialResult,
  type AuditLogQuery, type ChangePasswordBody, type CreateBranchBody, type CreateUserBody, type UpdateBranchBody, type UpdateUserBody, type ContractNumberTemplateBody, type ReplaceApprovalLevelsRequest,
} from '@los/contracts';
import { z } from 'zod';
import { apiFetch, originationFetch, qs } from '../../lib/api';

export interface SettingView { key: string; value: unknown; description: string; isDefault: boolean; updatedAt: string | null }
export interface TemplateView { id: string | null; pattern: string; prefix: string; seqScope: 'DAY' | 'BRANCH' | 'GLOBAL' }

export const fetchLevels = () => originationFetch<ApprovalLevelDto[]>('/approval-levels', { schema: z.array(ApprovalLevelDto) });
/** Q-124: батлах түвшний өөрчлөлт 4 нүдээр — санал үүсгэнэ (outcome PENDING = өөр хэрэглэгч батлах хүртэл хэрэгжихгүй). */
export const saveLevels = (body: ReplaceApprovalLevelsRequest) => originationFetch<SubmitChangeResult>('/approval-levels', { method: 'PUT', body, schema: SubmitChangeResult });
export const fetchTemplate = () => originationFetch<TemplateView>('/contract-number-template');
export const saveTemplate = (body: ContractNumberTemplateBody) => originationFetch<TemplateView>('/contract-number-template', { method: 'PUT', body });
export const fetchSettings = () => originationFetch<SettingView[]>('/settings');
export const saveSetting = (key: string, value: unknown) => originationFetch<SettingView>(`/settings/${encodeURIComponent(key)}`, { method: 'PUT', body: { value } });
/** Q-124: `FOUR_EYES_SETTING_KEYS` түлхүүр — санал үүсгэнэ (шалтгаан заавал). */
export const proposeSetting = (key: string, value: unknown, reason: string) =>
  originationFetch<SubmitChangeResult>(`/settings/${encodeURIComponent(key)}`, { method: 'PUT', body: { value, reason }, schema: SubmitChangeResult });
export const fetchOriginationAudit = (q: Partial<AuditLogQuery>) => originationFetch<AuditLogPage>(`/audit-logs${qs(q)}`, { schema: AuditLogPage });

export const fetchBranches = () => apiFetch<AdminBranchDto[]>('/admin/branches', { schema: z.array(AdminBranchDto) });
export const fetchUsers = () => apiFetch<AdminUserDto[]>('/admin/users', { schema: z.array(AdminUserDto) });
export const assignUserBranch = (userId: string, branchId: string | null) => apiFetch<AdminUserDto>(`/admin/users/${userId}/branch`, { method: 'PUT', body: { branchId }, schema: AdminUserDto });
export const fetchAuthAudit = (q: Partial<AuditLogQuery>) => apiFetch<AuditLogPage>(`/admin/audit-logs${qs(q)}`, { schema: AuditLogPage });

// FR-13 · салбар, хэрэглэгчийн удирдлага (устгахгүй — идэвхгүй болгоно)
const post = <T>(path: string, schema: z.ZodType<T>, body?: unknown) => apiFetch<T>(path, { method: 'POST', body, schema });
export const createBranch = (b: CreateBranchBody) => post('/admin/branches', AdminBranchDto, b);
export const updateBranch = (id: string, b: UpdateBranchBody) => apiFetch<AdminBranchDto>(`/admin/branches/${id}`, { method: 'PUT', body: b, schema: AdminBranchDto });
export const setBranchActive = (id: string, active: boolean) => post(`/admin/branches/${id}/${active ? 'reactivate' : 'deactivate'}`, AdminBranchDto);
export const createUser = (b: CreateUserBody) => post('/admin/users', UserCredentialResult, b);
export const updateUser = (id: string, b: UpdateUserBody) => apiFetch<AdminUserDto>(`/admin/users/${id}`, { method: 'PUT', body: b, schema: AdminUserDto });
export const setUserActive = (id: string, active: boolean) => post(`/admin/users/${id}/${active ? 'reactivate' : 'deactivate'}`, AdminUserDto);
export const resetUserPassword = (id: string) => post(`/admin/users/${id}/reset-password`, UserCredentialResult);
export const changeOwnPassword = (b: ChangePasswordBody) => apiFetch<void>('/auth/change-password', { method: 'POST', body: b });
