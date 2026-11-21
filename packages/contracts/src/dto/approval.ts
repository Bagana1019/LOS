import { z } from 'zod';
import { ApplicationStatus, ApprovalDecision, StepKey } from '../enums';
import { CalcMethodCode, RatioKind, SoscoGrade } from '../scoring';

// ── Шийдвэр, батлах урсгал (Модуль 10 · FR-10, BR-7, BR-8, BR-13) ─────────────────────────────────────────────
const text = (max: number) => z.string().trim().min(1).max(max);

/**
 * FR-1.1: "Миний батлах" таб харагдах дүрүүд. origination `ApprovalController`-ийн `VOTERS` (`GET /approvals/mine`, `POST …/approval/vote`)-той
 * ижил байх ёстой — түвшний гишүүнчлэлийг сервер шалгана, энэ нь зөвхөн табыг харуулах эсэхийг шийднэ.
 */
export const APPROVAL_VOTER_ROLES = ['BRANCH_MANAGER', 'APPROVER', 'ADMIN'] as const;

/**
 * FR-10.3: батлагч зөвхөн Батлах / Буцаах. RETURN бол тайлбар заавал (docs/01 §4).
 * FR-1.5: `levelNo`, `version` — санал өгөгчийн ХАРСАН түвшин, хүсэлтийн хувилбар. Одоогийн төлөвтэй зөрвөл сервер 409 `VOTE_TARGET_CHANGED`
 * (хоцрогдсон жагсаалтаас өөр шийдвэрт санал өгөхгүй). Заавал биш: өгөөгүй бол шалгахгүй (хуучин дуудлага).
 */
export const VoteRequest = z.object({
  decision: z.enum(ApprovalDecision), comment: text(1000).optional(),
  levelNo: z.number().int().positive().optional(), version: z.number().int().positive().optional(),
}).strict()
  .refine((v) => v.decision !== 'RETURN' || !!v.comment, { message: 'Буцаахад тайлбар заавал', path: ['comment'] });
export type VoteRequest = z.infer<typeof VoteRequest>;

export const ApprovalLevelState = ['WAITING', 'PENDING', 'APPROVED', 'RETURNED'] as const;
export type ApprovalLevelState = typeof ApprovalLevelState[number];

export const ApprovalVoteView = z.object({ approverId: z.string(), decision: z.enum(ApprovalDecision), comment: z.string().nullable(), decidedAt: z.string() });
export type ApprovalVoteView = z.infer<typeof ApprovalVoteView>;

/**
 * F3-11: түвшинд томилогдсон батлагч — `approval_level_member` мөр. Хэрэглэгчээр (`userId`) эсвэл дүрээр (`role`, нөгөө нь null) томилно.
 * Нэр origination-д байхгүй (iam schema) тул зөвхөн id / дүр; web `/directory`-оор нэр болгоно.
 */
export const ApprovalLevelApprover = z.object({ userId: z.string().nullable(), role: z.string().nullable() })
  .refine((a) => a.userId != null || a.role != null, { message: 'userId эсвэл role заавал' });
export type ApprovalLevelApprover = z.infer<typeof ApprovalLevelApprover>;

/**
 * F3-11: хэрэглэгч яагаад санал өгч чадахгүй байгаа шалтгаан (`canVote=false`). Сервер `canVote`-тай НЭГ функцээр тооцдог тул хэзээ ч зөрөхгүй.
 * NOT_IN_APPROVAL — хүсэлт батлах шатанд биш (эсвэл идэвхтэй түвшин алга); OWN_APPLICATION — өөрийн хүсэлт; NOT_LEVEL_APPROVER — идэвхтэй түвшний батлагч биш;
 * ALREADY_VOTED — идэвхтэй түвшинд санал өгсөн.
 */
export const CannotVoteReason = ['NOT_IN_APPROVAL', 'OWN_APPLICATION', 'NOT_LEVEL_APPROVER', 'ALREADY_VOTED'] as const;
export type CannotVoteReason = typeof CannotVoteReason[number];

export const ApprovalTimelineLevel = z.object({
  levelNo: z.number().int(), name: z.string(), state: z.enum(ApprovalLevelState),
  startedAt: z.string().nullable(), dueAt: z.string().nullable(), overdue: z.boolean(),
  /** Олонхийн босго: хамгийн цөөндөө `required` санал / нийт `total` батлагч. */
  quorum: z.object({ required: z.number().int(), total: z.number().int() }),
  votes: z.array(ApprovalVoteView),
  /** F3-11: энэ түвшинд санал өгөх эрхтэй томилогдсон батлагчид (санал өгсөн эсэхээс үл хамаарна). */
  approvers: z.array(ApprovalLevelApprover),
});
export type ApprovalTimelineLevel = z.infer<typeof ApprovalTimelineLevel>;

export const DecisionRecordView = z.object({ decisionNo: z.string(), decidedAt: z.string(), minutesText: z.string().nullable(), contractNo: z.string().nullable() });
export type DecisionRecordView = z.infer<typeof DecisionRecordView>;

/** Эрсдэлийн хураангуйн анхааруулга (F3-1). `code` нь тооцоолол/барьцааны модулийн код; `message` монгол. */
export const DecisionRiskFlag = z.object({ code: z.string(), level: z.enum(['warning', 'error']), message: z.string() });
export type DecisionRiskFlag = z.infer<typeof DecisionRiskFlag>;

/**
 * F3-1: батлагчид шаардлагатай эрсдэлийн үзүүлэлтүүд — зөвхөн ХАДГАЛАГДСАН үр дүн (тооцоолол `calc_snapshot_json`, барьцаа, орлого); энд юу ч тооцохгүй.
 * Нэгж: ӨОХ/LTV бутархай (0.55 = 55%), ӨТЧХ харьцаа (1.25), мөнгө ₮ (docs: scoring.ts).
 */
export const DecisionRisk = z.object({
  /** Сонгосон арга (A/B/C) ба сонголтын төрөл. */
  method: CalcMethodCode.nullable(), selection: z.enum(['AUTO', 'MANUAL']).nullable(),
  computedAt: z.string(),
  /** Оролт өөрчлөгдсөн (`score` алхам STALE) — доорх үзүүлэлтүүд одоогийн нөхцөлтэй таарахгүй байж болно. */
  stale: z.boolean(),
  /** Сонгосон аргын харьцаа: A → ӨОХ (DTI), B/C → ӨТЧХ (DSCR). Арга сонгоогүй бол null. */
  ratio: z.object({ kind: RatioKind, value: z.number().nullable(), limit: z.number().nullable(), pass: z.boolean().nullable() }).nullable(),
  /** Барьцааны модулийн LTV (зээл ÷ Σ барьцааны үнэлгээ), дээд хязгаар, хангасан эсэх. Тооцох боломжгүй бол value/pass = null. */
  ltv: z.object({ value: z.number().nullable(), limit: z.number(), pass: z.boolean().nullable() }),
  sosco: z.object({ score: z.number().int().nullable(), grade: SoscoGrade.nullable() }),
  /** Барьцаа: идэвхтэй барьцааны тоо, haircut-тай үнэлгээний нийлбэр, бүтээгдэхүүн барьцаа шаарддаг эсэх. */
  collateral: z.object({ count: z.number().int(), totalValue: z.number(), required: z.boolean() }),
  /** Орлого (сарын): ЗЭЗ + орлогод оруулсан хамтран зээлдэгчийн цалин ба ЦМУ, үндсэн зээлдэгчийн өрхийн зардал. */
  income: z.object({ salaryMonthly: z.number(), businessNcfMonthly: z.number(), householdExpenseMonthly: z.number() }),
  flags: z.array(DecisionRiskFlag),
});
export type DecisionRisk = z.infer<typeof DecisionRisk>;

export const DecisionView = z.object({
  applicationId: z.string(), appNo: z.string(), status: z.enum(ApplicationStatus), version: z.number().int(),
  /** FR-10.1 хураангуй карт. */
  summary: z.object({
    borrowerName: z.string().nullable(), registerNoMasked: z.string().nullable(), productName: z.string().nullable(), currency: z.string(),
    amount: z.number().nullable(), termMonths: z.number().int().nullable(), interestRate: z.number().nullable(), monthlyPayment: z.number().nullable(),
    collateralCount: z.number().int(), selectedMethod: z.string().nullable(),
    /** F3-1: эрсдэлийн хураангуй. Тооцоолол хадгалагдаагүй бол null; хуучин хариуд байхгүй байж болно (нэмэлт талбар). */
    risk: DecisionRisk.nullable().optional(),
  }),
  progress: z.object({ completed: z.number().int(), total: z.number().int(), missing: z.array(z.enum(StepKey)),
    /** Дутуу алхам бүрийн яг шалтгаан (одоогоор зөвхөн `collateral`: G0 issue-ийн мессеж). */
    reasons: z.record(z.string(), z.array(z.string())).default({}) }),
  canSubmit: z.boolean(),
  approval: z.object({ currentLevel: z.number().int().nullable(), totalLevels: z.number().int(), levels: z.array(ApprovalTimelineLevel) }),
  /** FR-10.4: хувилбарын түүх. */
  versions: z.array(z.object({ version: z.number().int(), outcome: z.enum(['PENDING', 'APPROVED', 'RETURNED']), returnedComment: z.string().nullable() })),
  decisionRecord: DecisionRecordView.nullable(),
  /** Одоогийн хэрэглэгч идэвхтэй түвшинд санал өгөх эрхтэй эсэх. */
  canVote: z.boolean(),
  /** F3-11: `canVote=false` үед яагаад; `canVote=true` үед null. */
  cannotVoteReason: z.enum(CannotVoteReason).nullable(),
}).refine((v) => v.canVote === (v.cannotVoteReason === null), { message: 'canVote ба cannotVoteReason зөрсөн', path: ['cannotVoteReason'] });
export type DecisionView = z.infer<typeof DecisionView>;

export const MyApprovalItem = z.object({
  applicationId: z.string(), appNo: z.string(), borrowerName: z.string().nullable(), amount: z.number().nullable(), currency: z.string(),
  levelNo: z.number().int(), levelName: z.string(), totalLevels: z.number().int(), startedAt: z.string(), dueAt: z.string().nullable(), overdue: z.boolean(),
  /** Хүсэлтийн хувилбар — санал өгөхдөө `VoteRequest.version`-оор буцааж дамжуулна (FR-1.5). */
  version: z.number().int(),
});
export type MyApprovalItem = z.infer<typeof MyApprovalItem>;
export const MyApprovalListResponse = z.object({ items: z.array(MyApprovalItem), total: z.number().int() });
export type MyApprovalListResponse = z.infer<typeof MyApprovalListResponse>;
