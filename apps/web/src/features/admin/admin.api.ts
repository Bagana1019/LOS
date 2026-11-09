// M13 · Админ API. Gateway-ээр л: origination → `/origination/...`, өөрийн (iam) → `/admin/...`.
import {
  AdminBranchDto, AdminUserDto, ApprovalLevelDto, AuditLogPage, PricingTierSet, ProductAdminDto, SubmitChangeResult,
  type AuditLogQuery, type ContractNumberTemplateBody, type ProductCreateRequest, type ProductSetActiveRequest, type ProductUpdateRequest,
  type ReplaceApprovalLevelsRequest, type SavePricingTiersRequest,
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

// ── Бүтээгдэхүүний админ (FR-13, Q-124 хэв маяг): унших шууд, бичих бүр 4 нүдний санал ──
export const fetchProducts = () => originationFetch<ProductAdminDto[]>('/products', { schema: z.array(ProductAdminDto) });
export const proposeProductCreate = (body: ProductCreateRequest) => originationFetch<SubmitChangeResult>('/products', { method: 'POST', body, schema: SubmitChangeResult });
export const proposeProductUpdate = (id: string, body: ProductUpdateRequest) => originationFetch<SubmitChangeResult>(`/products/${encodeURIComponent(id)}`, { method: 'PUT', body, schema: SubmitChangeResult });
export const proposeProductActive = (id: string, body: ProductSetActiveRequest) => originationFetch<SubmitChangeResult>(`/products/${encodeURIComponent(id)}/active`, { method: 'POST', body, schema: SubmitChangeResult });

// ── Үнэлгээний шатлал (FR-5.5): `PUT` шууд хадгална (settings:manage) ──
export const fetchPricingTiers = (productId: string | null) => originationFetch<PricingTierSet>(`/loan-terms/pricing/tiers${qs({ productId: productId ?? undefined })}`, { schema: PricingTierSet });
export const savePricingTiers = (body: SavePricingTiersRequest) => originationFetch<PricingTierSet>('/loan-terms/pricing/tiers', { method: 'PUT', body, schema: PricingTierSet });
