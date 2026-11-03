import type { ApprovalDecision, RequestContext } from '@los/contracts';

// Модуль 10 — батлах урсгалын цэвэр дүрмүүд (I/O байхгүй). BR-13: түвшин дүнгээр шатлагдана; олонхийн санал.

export interface LevelLike { id: string; productId: string | null; levelNo: number; amountFrom: number; amountTo: number | null; slaHours: number }
export interface MemberLike { userId: string | null; role: string | null; branchId: string | null }

/**
 * BR-13: хүсэлтийн дүнд хамаарах түвшнүүд (шатлал): 1-р түвшин үргэлж, дараагийн түвшин нь `amountFrom` < дүн бол нэмэгдэнэ.
 * Жишээ (DEMO): 1.2M → [1]; 7M → [1,2]; 50M → [1,2,3]. Бүтээгдэхүүнд тусгайлсан түвшин байвал зөвхөн тэдгээр, үгүй бол productId=null (бүх бүтээгдэхүүн).
 */
export function selectLevels<T extends LevelLike>(all: readonly T[], amount: number, productId: string | null): T[] {
  const specific = productId ? all.filter((l) => l.productId === productId) : [];
  const pool = (specific.length ? specific : all.filter((l) => l.productId == null)).slice().sort((a, b) => a.levelNo - b.levelNo);
  return pool.filter((l, i) => i === 0 || l.amountFrom < amount);
}

/** Олонхийн босго: нийт батлагчийн талаас илүү (3 → 2, 2 → 2, 1 → 1). */
export const requiredVotes = (total: number): number => Math.floor(total / 2) + 1;

export type LevelOutcome = 'PENDING' | 'APPROVED' | 'RETURNED';

/**
 * Түвшний үр дүн. Олонхи APPROVE → APPROVED; олонхи RETURN → RETURNED. Бүх батлагч санал өгсөн ч олонхи гараагүй (тэнцсэн) бол
 * болгоомжтой тал — RETURNED (docs/DECISIONS.md). Нийт 0 бол батлах хүн байхгүй тул PENDING хэвээр.
 */
export function evaluateLevel(decisions: readonly ApprovalDecision[], total: number): LevelOutcome {
  if (total <= 0) return 'PENDING';
  const need = requiredVotes(total);
  const approve = decisions.filter((d) => d === 'APPROVE').length;
  const ret = decisions.filter((d) => d === 'RETURN').length;
  if (approve >= need) return 'APPROVED';
  if (ret >= need) return 'RETURNED';
  return approve + ret >= total ? 'RETURNED' : 'PENDING';
}

/** Батлагч тухайн түвшний гишүүн эсэх: userId таарах, эсвэл (дүр + салбар). branchId=null → хүсэлтийн салбарын хэрэглэгч. */
export function isLevelMember(members: readonly MemberLike[], user: Pick<RequestContext, 'userId' | 'roles' | 'branchId'>, applicationBranchId: string): boolean {
  return members.some((m) => {
    if (m.userId) return m.userId === user.userId;
    if (!m.role || !user.roles.includes(m.role)) return false;
    return m.branchId ? user.branchId === m.branchId && applicationBranchId === m.branchId : user.branchId === applicationBranchId;
  });
}

/** SLA дуусах хугацаа (FR-10.2). */
export const dueAt = (from: Date, slaHours: number): Date => new Date(from.getTime() + slaHours * 3_600_000);
export const isOverdue = (due: Date | null, now: Date): boolean => !!due && due.getTime() < now.getTime();

/** Улаанбаатарын (UTC+8) огнооны YYMMDD ба YYYYMMDD. */
export function ubDate(now: Date): { yymmdd: string; yyyymmdd: string } {
  const d = new Date(now.getTime() + 8 * 3_600_000);
  const y = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return { yymmdd: `${y.slice(2)}${mm}${dd}`, yyyymmdd: `${y}${mm}${dd}` };
}

/** BR-11: загвар `{PREFIX}{BRANCH}{YYMMDD}{SEQ:2}` → хэсэг бүрийг орлуулна. `{SEQ:n}` = n оронтой тэгээр дүүргэсэн. */
export function formatContractNo(pattern: string, parts: { prefix: string; branch: string; yymmdd: string; seq: number }): string {
  return pattern
    .replace(/\{PREFIX\}/g, parts.prefix)
    .replace(/\{BRANCH\}/g, parts.branch)
    .replace(/\{YYMMDD\}/g, parts.yymmdd)
    .replace(/\{SEQ(?::(\d+))?\}/g, (_m, width: string | undefined) => String(parts.seq).padStart(width ? Number(width) : 0, '0'));
}

/** Тоолуурын хүрээний түлхүүр (seq_scope). */
export function counterScopeKey(scope: string, branchId: string, yyyymmdd: string): string {
  return scope === 'DAY' ? yyyymmdd : scope === 'BRANCH' ? branchId : 'ALL';
}

/** Салбарын кодыг загварт оруулах: DEMO — branchId-ийн үсэг/тооноос бусдыг хасна (iam.branch код origination-д байхгүй). */
export const branchCodeOf = (branchId: string): string => branchId.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
