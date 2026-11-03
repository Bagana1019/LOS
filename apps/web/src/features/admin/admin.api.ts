// M13 · Админ API. Gateway-ээр л: origination → `/origination/...`, өөрийн (iam) → `/admin/...`.
import {
  AdminBranchDto, AdminUserDto, ApprovalLevelDto, AuditLogPage,
  type AuditLogQuery, type ContractNumberTemplateBody, type ReplaceApprovalLevelsBody,
} from '@los/contracts';
import { z } from 'zod';
import { apiFetch, originationFetch, qs } from '../../lib/api';

export interface SettingView { key: string; value: unknown; description: string; isDefault: boolean; updatedAt: string | null }
export interface TemplateView { id: string | null; pattern: string; prefix: string; seqScope: 'DAY' | 'BRANCH' | 'GLOBAL' }

export const fetchLevels = () => originationFetch<ApprovalLevelDto[]>('/approval-levels', { schema: z.array(ApprovalLevelDto) });
export const saveLevels = (body: ReplaceApprovalLevelsBody) => originationFetch<ApprovalLevelDto[]>('/approval-levels', { method: 'PUT', body, schema: z.array(ApprovalLevelDto) });
export const fetchTemplate = () => originationFetch<TemplateView>('/contract-number-template');
export const saveTemplate = (body: ContractNumberTemplateBody) => originationFetch<TemplateView>('/contract-number-template', { method: 'PUT', body });
export const fetchSettings = () => originationFetch<SettingView[]>('/settings');
export const saveSetting = (key: string, value: unknown) => originationFetch<SettingView>(`/settings/${encodeURIComponent(key)}`, { method: 'PUT', body: { value } });
export const fetchOriginationAudit = (q: Partial<AuditLogQuery>) => originationFetch<AuditLogPage>(`/audit-logs${qs(q)}`, { schema: AuditLogPage });

export const fetchBranches = () => apiFetch<AdminBranchDto[]>('/admin/branches', { schema: z.array(AdminBranchDto) });
export const fetchUsers = () => apiFetch<AdminUserDto[]>('/admin/users', { schema: z.array(AdminUserDto) });
export const assignUserBranch = (userId: string, branchId: string | null) => apiFetch<AdminUserDto>(`/admin/users/${userId}/branch`, { method: 'PUT', body: { branchId }, schema: AdminUserDto });
export const fetchAuthAudit = (q: Partial<AuditLogQuery>) => apiFetch<AuditLogPage>(`/admin/audit-logs${qs(q)}`, { schema: AuditLogPage });
