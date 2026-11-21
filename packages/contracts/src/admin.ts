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

/**
 * Босго давхцахгүй, завсаргүй: түвшин 1 нь 0-ээс, дараагийн `from` = өмнөх `to`, сүүлийнх нь хязгааргүй. Алдааны мессеж буцаана, зөв бол null.
 * F9-9: `members` өгөгдсөн бол түвшин бүрд ≥1 батлагч заавал — батлагчгүй түвшин батлах хүсэлтийг гацаана (илгээхэд `APPROVAL_LEVEL_WITHOUT_MEMBERS`).
 * `members` өгөөгүй дуудлага (зөвхөн босго шалгах) батлагчийг шалгахгүй.
 */
export function validateApprovalLevels(levels: readonly (Pick<ApprovalLevelInput, 'levelNo' | 'amountFrom' | 'amountTo'> & Partial<Pick<ApprovalLevelInput, 'name' | 'members'>>)[]): string | null {
  const sorted = [...levels].sort((a, b) => a.levelNo - b.levelNo);
  for (let i = 0; i < sorted.length; i++) {
    const l = sorted[i]!;
    if (l.levelNo !== i + 1) return 'Түвшний дугаар 1-ээс эхэлж дараалсан байх ёстой';
    if (i === 0 && l.amountFrom !== 0) return 'Эхний түвшин 0-ээс эхлэх ёстой';
    if (i > 0 && l.amountFrom !== sorted[i - 1]!.amountTo) return `Түвшин ${l.levelNo}: эхлэх дүн өмнөх түвшний дээд дүнтэй тэнцүү байх ёстой`;
    if (i < sorted.length - 1 && (l.amountTo === null || l.amountTo <= l.amountFrom)) return `Түвшин ${l.levelNo}: дээд дүн эхлэх дүнгээс их байх ёстой`;
    if (i === sorted.length - 1 && l.amountTo !== null) return 'Сүүлийн түвшин дээд хязгааргүй (хоосон) байх ёстой';
    if (l.members && l.members.length === 0) {
      const label = l.name?.trim() ? ` "${l.name.trim()}"` : '';
      return `Түвшин ${l.levelNo}${label}: дор хаяж нэг батлагч томилох ёстой (батлагчгүй түвшин батлах хүсэлтийг гацаана)`;
    }
  }
  return null;
}

// ── Гэрээний дугаарын загвар (BR-11) ──
/**
 * F9-20 · Тоолуур `seqScope`-оор шинэчлэгдэнэ (origination `counterScopeKey`): DAY = өдөр бүр, BRANCH = салбар тутам, GLOBAL = хэзээ ч.
 * Шинэчлэгдсэн тоолуур 01-ээс эхэлдэг тул хүрээг ялгах хэсэг (`formatContractNo`-ийн дэмждэг токен) дугаарт байхгүй бол (orgId, contractNo) unique-тэй мөргөлдөж
 * батлах үйлдэл унана. Дэмжигдэх токен: {PREFIX} {BRANCH} {YYMMDD} {SEQ[:n]} — өөр огнооны токен (жишээ {YYYYMMDD}) орлуулагдахгүй.
 */
const SCOPE_DISTINGUISHING_TOKEN = {
  DAY: { token: '{YYMMDD}', message: 'Тоолуур өдөр бүр шинээр эхлэх тул загварт өдрийн {YYMMDD} хэсэг заавал байх ёстой, эс бөгөөс маргааш давхардсан дугаар гарна' },
  BRANCH: { token: '{BRANCH}', message: 'Тоолуур салбар тутам тусдаа тоологдох тул загварт салбарын {BRANCH} хэсэг заавал байх ёстой, эс бөгөөс өөр салбарт давхардсан дугаар гарна' },
} as const;

/**
 * BR-11 · F9-21: загварт зөвшөөрөгдөх хэсгүүд. `formatContractNo` (origination/approval.rules.ts) яг эдгээрийг орлуулдаг —
 * жагсаалтад байхгүй `{...}` нь дугаарт хаалттайгаа орно ("LN-{YYYY}-1"). Алдааны мессеж ба UI-ийн заавар энэ нэг жагсаалтаас гарна.
 */
export const CONTRACT_NUMBER_TOKENS = [
  { token: '{PREFIX}', label: 'угтвар' },
  { token: '{BRANCH}', label: 'салбарын код' },
  { token: '{YYMMDD}', label: 'он, сар, өдөр' },
  { token: '{SEQ}', label: 'дараалал' },
  { token: '{SEQ:n}', label: 'n оронтой дараалал' },
] as const;
/** `{SEQ:n}`: тоолуур `next_seq` нь int32 (10 орон); хэтэрвэл `padStart` RangeError шидэж батлалт унана. */
export const CONTRACT_SEQ_MAX_WIDTH = 10;

const BRACED_PART_RE = /\{[^{}]*\}/g;
const KNOWN_PART_RE = /^\{(?:PREFIX|BRANCH|YYMMDD|SEQ(?::\d+)?)\}$/;
const SEQ_PART_RE = /^\{SEQ(?::(\d+))?\}$/;
/** Гэрээний дугаар DMS-д файлын нэр болдог (dms `safeFileStem`) — эдгээр тэмдэгтийг тэнд `_` болгон солидог тул дугаар ≠ файлын нэр болно. */
const FILE_NAME_UNSAFE = '\\/:*?"<>|';
const TOKEN_LIST = CONTRACT_NUMBER_TOKENS.map(({ token, label }) => `${token} (${label})`).join(', ');

const isControlChar = (ch: string): boolean => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f;
const unsafeCharLabel = (ch: string): string => (isControlChar(ch) ? 'хяналтын тэмдэгт' : `"${ch}"`);

function seqPartIssues(parts: readonly string[]): string[] {
  const seqParts = parts.filter((p) => SEQ_PART_RE.test(p));
  if (seqParts.length === 0) return ['{SEQ} хэсэг заавал байх ёстой'];
  const issues = seqParts.length > 1 ? [`{SEQ} хэсэг яг нэг л удаа байх ёстой (одоо ${seqParts.length} удаа байна)`] : [];
  for (const part of seqParts) {
    const width = Number(SEQ_PART_RE.exec(part)?.[1] ?? 0);
    if (width > CONTRACT_SEQ_MAX_WIDTH) issues.push(`{SEQ:n}-ийн n нь ${CONTRACT_SEQ_MAX_WIDTH}-аас ихгүй байх ёстой: ${part}`);
  }
  return issues;
}

/** Загварын текстийг шалгаж, алдаа бүрийн мессежийг (чухал нь эхэнд) буцаана. Зөв бол хоосон. */
function contractPatternIssues(pattern: string): string[] {
  const parts = pattern.match(BRACED_PART_RE) ?? [];
  const literal = pattern.replace(BRACED_PART_RE, '');
  const unknown = [...new Set(parts.filter((p) => !KNOWN_PART_RE.test(p)))];
  const unsafe = [...new Set([...literal].filter((ch) => FILE_NAME_UNSAFE.includes(ch) || isControlChar(ch)).map(unsafeCharLabel))];
  const issues: string[] = [];
  if (unknown.length > 0) issues.push(`Загварт танигдаагүй хэсэг байна: ${unknown.join(', ')}. Зөвхөн дараах хэсгийг ашиглана: ${TOKEN_LIST}`);
  if (/[{}]/.test(literal)) issues.push(`Загварт хаалт ганцаараа байж болохгүй, хэсэг бүр {…} хэлбэрээр бүтэн байх ёстой. Ашиглах хэсгүүд: ${TOKEN_LIST}`);
  if (unsafe.length > 0) issues.push(`Загварт ${unsafe.join(', ')} тэмдэгт байж болохгүй: гэрээний дугаар файлын нэр болдог тул ${[...FILE_NAME_UNSAFE].join(' ')} тэмдэгт хориотой`);
  return [...issues, ...seqPartIssues(parts)];
}

export const ContractNumberTemplateBody = z.object({
  pattern: z.string().trim()
    .min(1, 'Загвар хоосон байж болохгүй')
    .max(80, 'Загвар 80 тэмдэгтээс хэтрэхгүй байх ёстой')
    .superRefine((p, ctx) => { for (const message of contractPatternIssues(p)) ctx.addIssue({ code: z.ZodIssueCode.custom, message }); }),
  prefix: z.string().trim().max(12).regex(/^[A-Za-z0-9]*$/, 'Угтвар зөвхөн үсэг, тоо'),
  seqScope: z.enum(['DAY', 'BRANCH', 'GLOBAL']),
}).superRefine((tpl, ctx) => {
  const rule = tpl.seqScope === 'GLOBAL' ? null : SCOPE_DISTINGUISHING_TOKEN[tpl.seqScope];
  if (rule && !tpl.pattern.includes(rule.token)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pattern'], message: rule.message });
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

// F9-24 · Аудитын "Хэн" шүүлт: нэр/нэвтрэх нэрээр хайж id олно (`GET /admin/audit-actors`, audit:read). Нууц мэдээлэлгүй: зөвхөн id, нэвтрэх нэр, овог нэр.
export const AUDIT_ACTOR_Q_MAX = 60;
export const AUDIT_ACTOR_LIMIT = 20;
export const AuditActorQuery = z.object({ q: z.string().trim().max(AUDIT_ACTOR_Q_MAX).optional() });
export type AuditActorQuery = z.infer<typeof AuditActorQuery>;
export const AuditActorOption = z.object({ id: z.string(), username: z.string(), fullName: z.string() });
export type AuditActorOption = z.infer<typeof AuditActorOption>;
