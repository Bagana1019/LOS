import { z } from 'zod';
import { UserRole } from './enums';
// Maker-Checker ("4 нүдний зарчим") — docs/05-maker-checker.md. Enum, DTO, event нэг файлд (модуль тусгаарлагдсан);
// UserRole-ийг enums.ts-ээс авна, давтахгүй. (SQL CHECK-ийн дүрүүд migration-д давтагдана — шинэ дүр нэмбэл шинэ migration хэрэгтэй.)

export const ChangeRequestStatus = ['PENDING', 'APPLIED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'FAILED'] as const;
export type ChangeRequestStatus = typeof ChangeRequestStatus[number];
/** FOUR_EYES — checker батлах шаардлагатай; DIRECT — policy идэвхгүй тул шууд хэрэгжиж, зөвхөн аудитлагдсан */
export const ChangeRequestMode = ['FOUR_EYES', 'DIRECT'] as const;
export type ChangeRequestMode = typeof ChangeRequestMode[number];
export const ChangeRequestEvent = ['SUBMITTED', 'APPLIED', 'DIRECT_APPLIED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'FAILED'] as const;
export type ChangeRequestEvent = typeof ChangeRequestEvent[number];
export const ChangeRequestScope = ['inbox', 'mine', 'decided', 'all'] as const;
export type ChangeRequestScope = typeof ChangeRequestScope[number];

const MakerCheckerRole = z.enum(UserRole);
const Code = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/, 'UPPER_SNAKE_CASE');

// PostgreSQL TEXT/JSONB NUL (\u0000) хүлээн авдаггүй (500 болно), CHECK нь тэмдэгтийн (code point) тоогоор ажиллана — зорилтот шалгалтыг эндээс давхар хийнэ.
const noNul = (s: string) => !s.includes('\u0000');
const codePoints = (s: string) => [...s].length;
/** Объект/массив доторх бүх string (түлхүүр, утга) NUL-гүй эсэх */
export function hasNoNul(v: unknown): boolean {
  if (typeof v === 'string') return noNul(v);
  if (Array.isArray(v)) return v.every(hasNoNul);
  if (v !== null && typeof v === 'object') return Object.entries(v).every(([k, x]) => noNul(k) && hasNoNul(x));
  return true;
}
const text = (min: number, max: number) =>
  z.string().trim().max(max).refine(noNul, 'NUL тэмдэгт зөвшөөрөгдөхгүй').refine((s) => codePoints(s) >= min, `хамгийн багадаа ${min} тэмдэгт`);
const Comment = text(0, 2000);

// ── Алдааны кодууд (MC-FR-8) ────────────────────────────────────────────────────
/** Backend → UI алдааны кодууд. HTTP статус нь origination/maker-checker.errors.ts-д (бүгдийг заавал тодорхойлно), монгол текст нь mn.maker-checker.json-д (тест шалгана). */
export const MakerCheckerErrorCode = [
  'UNAUTHENTICATED', 'FORBIDDEN', 'MAKER_ROLE_FORBIDDEN', 'SELF_APPROVAL_FORBIDDEN', 'CHECKER_ROLE_FORBIDDEN', 'CHECKER_BRANCH_FORBIDDEN',
  'ONLY_MAKER_CAN_CANCEL', 'NOT_FOUND', 'ALREADY_DECIDED', 'EXPIRED', 'TARGET_HAS_PENDING_CHANGE', 'STALE_TARGET', 'DECISION_IN_PROGRESS',
  'VALIDATION_FAILED', 'HANDLER_NOT_FOUND', 'PAYLOAD_INVALID', 'TARGET_ID_MISMATCH', 'POLICY_LOCKED',
] as const;
export type MakerCheckerErrorCode = typeof MakerCheckerErrorCode[number];

// ── Хүсэлт ──────────────────────────────────────────────────────────────────────
export const SubmitChangeRequest = z.object({
  targetType: Code,
  action: Code,
  /** Засагдах зүйлийн ID; CREATE бол байгалийн түлхүүр (жишээ регистр) — нэг зорилтод нэг PENDING (MC-BR-5) */
  targetId: text(1, 200),
  payload: z.record(z.unknown()).refine(hasNoNul, 'NUL тэмдэгт зөвшөөрөгдөхгүй'),
  /** Maker-ийн шалтгаан — заавал (MC-BR-4) */
  reason: text(3, 2000),
  applicationId: text(1, 64).optional(),
  /** Maker харсан үеийн зорилтын хувилбар; батлах үед өөр байвал FAILED (MC-BR-7). Заагаагүй бол handler snapshot-ийн утга. Хоосон string зөвшөөрөхгүй. */
  baseVersion: text(1, 128).optional(),
});
export type SubmitChangeRequest = z.infer<typeof SubmitChangeRequest>;

export const ApproveChangeRequest = z.object({ comment: Comment.optional() });
export type ApproveChangeRequest = z.infer<typeof ApproveChangeRequest>;
/** Татгалзахад тайлбар заавал (MC-BR-4) */
export const RejectChangeRequest = z.object({ comment: text(3, 2000) });
export type RejectChangeRequest = z.infer<typeof RejectChangeRequest>;
export const CancelChangeRequest = z.object({ comment: Comment.optional() });
export type CancelChangeRequest = z.infer<typeof CancelChangeRequest>;

export const PAGE_SIZES = [10, 20, 50, 100] as const;
export const ListChangeRequestsQuery = z.object({
  scope: z.enum(ChangeRequestScope).default('inbox'),
  status: z.enum(ChangeRequestStatus).optional(),
  targetType: Code.optional(),
  applicationId: text(1, 64).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().refine((n) => (PAGE_SIZES as readonly number[]).includes(n), 'pageSize must be 10/20/50/100').default(20),
});
export type ListChangeRequestsQuery = z.infer<typeof ListChangeRequestsQuery>;

export const ChangeRequestHistoryDto = z.object({
  seq: z.number().int(),
  event: z.enum(ChangeRequestEvent),
  fromStatus: z.enum(ChangeRequestStatus).nullable(),
  toStatus: z.enum(ChangeRequestStatus),
  actorId: z.string().nullable(),
  actorRoles: z.array(z.string()),
  comment: z.string().nullable(),
  data: z.unknown().nullable(),
  at: z.string().datetime(),
});
export type ChangeRequestHistoryDto = z.infer<typeof ChangeRequestHistoryDto>;

export const ChangeRequestDto = z.object({
  id: z.string().uuid(),
  orgId: z.string(),
  branchId: z.string().nullable(),
  targetType: z.string(),
  targetId: z.string(),
  action: z.string(),
  applicationId: z.string().nullable(),
  mode: z.enum(ChangeRequestMode),
  status: z.enum(ChangeRequestStatus),
  payload: z.unknown(),
  /** Maker илгээх үеийн зорилтын төлөв (diff харуулахад) */
  before: z.unknown().nullable(),
  baseVersion: z.string().nullable(),
  reason: z.string(),
  makerId: z.string(),
  makerRoles: z.array(z.string()),
  requiredCheckerRoles: z.array(z.string()),
  checkerId: z.string().nullable(),
  checkerRoles: z.array(z.string()),
  checkerComment: z.string().nullable(),
  failureReason: z.string().nullable(),
  expiresAt: z.string().datetime(),
  decidedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  /** Зөвхөн дэлгэрэнгүй (GET /requests/:id) хариунд */
  history: z.array(ChangeRequestHistoryDto).optional(),
  /** Хүсэлт гаргагч хэрэглэгч өөрөө шийдэж чадах эсэх (UI товч харуулах) */
  canDecide: z.boolean().optional(),
  canCancel: z.boolean().optional(),
});
export type ChangeRequestDto = z.infer<typeof ChangeRequestDto>;

export const ChangeRequestPage = z.object({
  items: z.array(ChangeRequestDto), total: z.number().int(), page: z.number().int(), pageSize: z.number().int(),
});
export type ChangeRequestPage = z.infer<typeof ChangeRequestPage>;

export const SubmitChangeResult = z.object({
  /** PENDING — checker хүлээж байна (HTTP 202); APPLIED_DIRECT — policy идэвхгүй тул шууд хэрэгжсэн (HTTP 201) */
  outcome: z.enum(['PENDING', 'APPLIED_DIRECT']),
  request: ChangeRequestDto,
});
export type SubmitChangeResult = z.infer<typeof SubmitChangeResult>;

export const ChangeRequestSummary = z.object({ inbox: z.number().int(), mine: z.number().int() });
export type ChangeRequestSummary = z.infer<typeof ChangeRequestSummary>;

// ── Policy (admin) — MC-BR-8 ─────────────────────────────────────────────────────
export const MakerCheckerPolicy = z.object({
  targetType: Code,
  action: Code,
  enabled: z.boolean(),
  checkerRoles: z.array(MakerCheckerRole).min(1),
  expiresInHours: z.number().int().min(1).max(24 * 30),
});
export type MakerCheckerPolicy = z.infer<typeof MakerCheckerPolicy>;
export const MakerCheckerPolicyDto = MakerCheckerPolicy.extend({
  /** true бол өгөгдлийн сангийн мөрөөс, false бол handler-ийн анхдагч утга */
  configured: z.boolean(),
  /** true бол идэвхгүй болгох боломжгүй (жишээ нь policy-г өөрөө өөрчлөх) */
  locked: z.boolean(),
  makerRoles: z.array(MakerCheckerRole),
  updatedAt: z.string().datetime().nullable(),
  updatedBy: z.string().nullable(),
});
export type MakerCheckerPolicyDto = z.infer<typeof MakerCheckerPolicyDto>;
/** Policy өөрчлөх нь өөрөө change request: targetType = MAKER_CHECKER_POLICY, action = UPDATE */
export const POLICY_TARGET_TYPE = 'MAKER_CHECKER_POLICY';
export const POLICY_ACTION_UPDATE = 'UPDATE';

// ── Event (CLAUDE.md §3.3; outbox → los:events) ─────────────────────────────────
const base = z.object({
  eventId: z.string().uuid(), occurredAt: z.string().datetime(), version: z.literal(1),
  orgId: z.string(), actorId: z.string().nullable(), correlationId: z.string(),
});
const requestRef = {
  changeRequestId: z.string().uuid(), targetType: z.string(), targetId: z.string(), action: z.string(),
  applicationId: z.string().nullable(), makerId: z.string(),
};
export const ChangeRequestSubmitted = base.extend({
  type: z.literal('ChangeRequestSubmitted'), ...requestRef,
  requiredCheckerRoles: z.array(z.string()), branchId: z.string().nullable(), expiresAt: z.string().datetime(),
});
export const ChangeRequestDecided = base.extend({
  type: z.literal('ChangeRequestDecided'), ...requestRef,
  outcome: z.enum(['APPLIED', 'APPLIED_DIRECT', 'REJECTED', 'CANCELLED', 'EXPIRED', 'FAILED']),
  checkerId: z.string().nullable(),
});
export const MakerCheckerEvents = [ChangeRequestSubmitted, ChangeRequestDecided] as const;
