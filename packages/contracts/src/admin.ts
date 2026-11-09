import { z } from 'zod';

/**
 * M13 · Админ (FR-13, NFR-7). Батлах түвшин, гэрээний дугаарын загвар, хэрэглэгч-салбар, аудит лог.
 * Мөнгө string/number — API-д number (₮), DB-д Decimal(18,2).
 */

// ── Батлах түвшин (BR-13) ──
export const ApprovalLevelMemberInput = z.object({ userId: z.string().min(1).max(64) });
export const ApprovalLevelInput = z.object({
  levelNo: z.number().int().min(1).max(10),
  name: z.string().trim().min(1).max(120),
  amountFrom: z.number().min(0),
  /** null = дээд хязгааргүй (зөвхөн сүүлийн түвшин) */
  amountTo: z.number().positive().nullable(),
  quorumType: z.enum(['MAJORITY', 'ALL', 'ANY']).default('MAJORITY'),
  slaHours: z.number().int().positive().max(24 * 30),
  members: z.array(ApprovalLevelMemberInput).max(50),
});
/** Нийтлэг (productId = null) түвшнүүдийг бүхэлд нь солино. */
export const ReplaceApprovalLevelsBody = z.object({ levels: z.array(ApprovalLevelInput).min(1).max(10) });
/** Q-124: батлах түвшний өөрчлөлт 4 нүдээр — maker-ийн шалтгаан заавал (MC-BR-4) */
export const ChangeReasonField = z.string().trim().min(3).max(2000);
export const ReplaceApprovalLevelsRequest = ReplaceApprovalLevelsBody.extend({ reason: ChangeReasonField });
export type ReplaceApprovalLevelsRequest = z.infer<typeof ReplaceApprovalLevelsRequest>;
export type ApprovalLevelInput = z.infer<typeof ApprovalLevelInput>;
export type ReplaceApprovalLevelsBody = z.infer<typeof ReplaceApprovalLevelsBody>;

export const ApprovalLevelDto = ApprovalLevelInput.extend({ id: z.string() });
export type ApprovalLevelDto = z.infer<typeof ApprovalLevelDto>;

/** Босго давхцахгүй, завсаргүй: түвшин 1 нь 0-ээс, дараагийн `from` = өмнөх `to`, сүүлийнх нь хязгааргүй. Алдааны мессеж буцаана, зөв бол null. */
export function validateApprovalLevels(levels: readonly Pick<ApprovalLevelInput, 'levelNo' | 'amountFrom' | 'amountTo'>[]): string | null {
  const sorted = [...levels].sort((a, b) => a.levelNo - b.levelNo);
  for (let i = 0; i < sorted.length; i++) {
    const l = sorted[i]!;
    if (l.levelNo !== i + 1) return 'Түвшний дугаар 1-ээс эхэлж дараалсан байх ёстой';
    if (i === 0 && l.amountFrom !== 0) return 'Эхний түвшин 0-ээс эхлэх ёстой';
    if (i > 0 && l.amountFrom !== sorted[i - 1]!.amountTo) return `Түвшин ${l.levelNo}: эхлэх дүн өмнөх түвшний дээд дүнтэй тэнцүү байх ёстой`;
    if (i < sorted.length - 1 && (l.amountTo === null || l.amountTo <= l.amountFrom)) return `Түвшин ${l.levelNo}: дээд дүн эхлэх дүнгээс их байх ёстой`;
    if (i === sorted.length - 1 && l.amountTo !== null) return 'Сүүлийн түвшин дээд хязгааргүй (хоосон) байх ёстой';
  }
  return null;
}

// ── Гэрээний дугаарын загвар (BR-11) ──
export const ContractNumberTemplateBody = z.object({
  pattern: z.string().trim().min(1).max(80).refine((p) => /\{SEQ(?::\d+)?\}/.test(p), '{SEQ} хэсэг заавал байх ёстой'),
  prefix: z.string().trim().max(12).regex(/^[A-Za-z0-9]*$/, 'Угтвар зөвхөн үсэг, тоо'),
  seqScope: z.enum(['DAY', 'BRANCH', 'GLOBAL']),
});
export type ContractNumberTemplateBody = z.infer<typeof ContractNumberTemplateBody>;

// ── Хэрэглэгч-салбар (gateway `iam`) ──
export const ADMIN_BRANCH_BOUND_ROLES = ['OFFICER', 'BRANCH_MANAGER'] as const;
export const AdminUserDto = z.object({
  id: z.string(), username: z.string(), fullName: z.string(), roles: z.array(z.string()),
  branchId: z.string().nullable(), isActive: z.boolean(), lastLoginAt: z.string().nullable(),
  email: z.string().nullable().default(null), phone: z.string().nullable().default(null),
  mustChangePassword: z.boolean().default(false),
});
export type AdminUserDto = z.infer<typeof AdminUserDto>;
export const AdminBranchDto = z.object({ id: z.string(), code: z.string(), name: z.string(), isActive: z.boolean(), activeUserCount: z.number().int().default(0) });
export type AdminBranchDto = z.infer<typeof AdminBranchDto>;
export const AssignUserBranchBody = z.object({ branchId: z.string().uuid().nullable() });
export type AssignUserBranchBody = z.infer<typeof AssignUserBranchBody>;

// ── Салбарын удирдлага (FR-13): нэмэх, засах, идэвхгүй болгох/сэргээх. Устгахгүй — хүсэлт, аудит ID-аар заасан. ──
export const BRANCH_CODE_RE = /^[A-Za-z0-9]{1,12}$/;
export const CreateBranchBody = z.object({
  code: z.string().trim().toUpperCase().regex(BRANCH_CODE_RE, 'Код: үсэг, тоо (1–12 тэмдэгт)'),
  name: z.string().trim().min(2).max(120),
});
export type CreateBranchBody = z.infer<typeof CreateBranchBody>;
export const UpdateBranchBody = z.object({ name: z.string().trim().min(2).max(120) });
export type UpdateBranchBody = z.infer<typeof UpdateBranchBody>;

// ── Хэрэглэгчийн удирдлага (FR-13): нэмэх, засах, дүр оноох, идэвхгүй болгох, нууц үг шинэчлэх ──
export const ADMIN_ASSIGNABLE_ROLES = ['OFFICER', 'BRANCH_MANAGER', 'APPROVER', 'ADMIN', 'COMPLIANCE'] as const;
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,39}$/;
export const PASSWORD_MIN_LENGTH = 12;
/** Нууц үгийн бодлого: ≥12 тэмдэгт, том/жижиг үсэг, тоо (DEMO босго — Q-137-тэй адил тохиргоонд шилжүүлж болно). */
export const PasswordField = z.string().min(PASSWORD_MIN_LENGTH).max(200)
  .refine((p) => /[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p), 'Нууц үг том, жижиг үсэг, тоо агуулсан байх ёстой');
const UserRoles = z.array(z.enum(ADMIN_ASSIGNABLE_ROLES)).min(1).max(5).refine((r) => new Set(r).size === r.length, 'Дүр давхцсан байна');
const OptionalText = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => (v ? v : null));
export const CreateUserBody = z.object({
  username: z.string().trim().toLowerCase().regex(USERNAME_RE, 'Нэвтрэх нэр: жижиг латин үсэг, тоо, . _ - (3–40)'),
  fullName: z.string().trim().min(2).max(120),
  email: OptionalText(160), phone: OptionalText(40),
  roles: UserRoles,
  branchId: z.string().uuid().nullable(),
});
export type CreateUserBody = z.infer<typeof CreateUserBody>;
export const UpdateUserBody = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: OptionalText(160), phone: OptionalText(40),
  roles: UserRoles,
  branchId: z.string().uuid().nullable(),
});
export type UpdateUserBody = z.infer<typeof UpdateUserBody>;
/** Түр нууц үг зөвхөн нэг удаа буцна; хэрэглэгч эхний нэвтрэлтээр заавал солино. */
export const UserCredentialResult = z.object({ user: AdminUserDto, temporaryPassword: z.string() });
export type UserCredentialResult = z.infer<typeof UserCredentialResult>;
export const ChangePasswordBody = z.object({ currentPassword: z.string().min(1).max(200), newPassword: PasswordField });
export type ChangePasswordBody = z.infer<typeof ChangePasswordBody>;

// ── Аудит лог харах (FR-13.5) ──
export const AuditLogQuery = z.object({
  entity: z.string().trim().max(60).optional(),
  entityId: z.string().trim().max(80).optional(),
  actorId: z.string().trim().max(64).optional(),
  action: z.string().trim().max(60).optional(),
  applicationId: z.string().trim().max(64).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditLogQuery = z.infer<typeof AuditLogQuery>;
export const AuditLogRow = z.object({
  id: z.string(), entity: z.string(), entityId: z.string(), action: z.string(), actorId: z.string().nullable(), at: z.string(),
  applicationId: z.string().nullable(), correlationId: z.string().nullable(), beforeJson: z.unknown(), afterJson: z.unknown(),
});
export const AuditLogPage = z.object({ items: z.array(AuditLogRow), total: z.number(), page: z.number(), pageSize: z.number() });
export type AuditLogPage = z.infer<typeof AuditLogPage>;
