import { z } from 'zod';
import { ApplicationStatus, ApprovalDecision, StepKey } from '../enums';

// ── Шийдвэр, батлах урсгал (Модуль 10 · FR-10, BR-7, BR-8, BR-13) ─────────────────────────────────────────────
const text = (max: number) => z.string().trim().min(1).max(max);

/** FR-10.3: батлагч зөвхөн Батлах / Буцаах. RETURN бол тайлбар заавал (docs/01 §4). */
export const VoteRequest = z.object({ decision: z.enum(ApprovalDecision), comment: text(1000).optional() }).strict()
  .refine((v) => v.decision !== 'RETURN' || !!v.comment, { message: 'Буцаахад тайлбар заавал', path: ['comment'] });
export type VoteRequest = z.infer<typeof VoteRequest>;

export const ApprovalLevelState = ['WAITING', 'PENDING', 'APPROVED', 'RETURNED'] as const;
export type ApprovalLevelState = typeof ApprovalLevelState[number];

export const ApprovalVoteView = z.object({ approverId: z.string(), decision: z.enum(ApprovalDecision), comment: z.string().nullable(), decidedAt: z.string() });
export type ApprovalVoteView = z.infer<typeof ApprovalVoteView>;

export const ApprovalTimelineLevel = z.object({
  levelNo: z.number().int(), name: z.string(), state: z.enum(ApprovalLevelState),
  startedAt: z.string().nullable(), dueAt: z.string().nullable(), overdue: z.boolean(),
  /** Олонхийн босго: хамгийн цөөндөө `required` санал / нийт `total` батлагч. */
  quorum: z.object({ required: z.number().int(), total: z.number().int() }),
  votes: z.array(ApprovalVoteView),
});
export type ApprovalTimelineLevel = z.infer<typeof ApprovalTimelineLevel>;

export const DecisionRecordView = z.object({ decisionNo: z.string(), decidedAt: z.string(), minutesText: z.string().nullable(), contractNo: z.string().nullable() });
export type DecisionRecordView = z.infer<typeof DecisionRecordView>;

export const DecisionView = z.object({
  applicationId: z.string(), appNo: z.string(), status: z.enum(ApplicationStatus), version: z.number().int(),
  /** FR-10.1 хураангуй карт. */
  summary: z.object({
    borrowerName: z.string().nullable(), registerNoMasked: z.string().nullable(), productName: z.string().nullable(), currency: z.string(),
    amount: z.number().nullable(), termMonths: z.number().int().nullable(), interestRate: z.number().nullable(), monthlyPayment: z.number().nullable(),
    collateralCount: z.number().int(), selectedMethod: z.string().nullable(),
  }),
  progress: z.object({ completed: z.number().int(), total: z.number().int(), missing: z.array(z.enum(StepKey)) }),
  canSubmit: z.boolean(),
  approval: z.object({ currentLevel: z.number().int().nullable(), totalLevels: z.number().int(), levels: z.array(ApprovalTimelineLevel) }),
  /** FR-10.4: хувилбарын түүх. */
  versions: z.array(z.object({ version: z.number().int(), outcome: z.enum(['PENDING', 'APPROVED', 'RETURNED']), returnedComment: z.string().nullable() })),
  decisionRecord: DecisionRecordView.nullable(),
  /** Одоогийн хэрэглэгч идэвхтэй түвшинд санал өгөх эрхтэй эсэх. */
  canVote: z.boolean(),
});
export type DecisionView = z.infer<typeof DecisionView>;

export const MyApprovalItem = z.object({
  applicationId: z.string(), appNo: z.string(), borrowerName: z.string().nullable(), amount: z.number().nullable(), currency: z.string(),
  levelNo: z.number().int(), levelName: z.string(), totalLevels: z.number().int(), startedAt: z.string(), dueAt: z.string().nullable(), overdue: z.boolean(),
});
export type MyApprovalItem = z.infer<typeof MyApprovalItem>;
export const MyApprovalListResponse = z.object({ items: z.array(MyApprovalItem), total: z.number().int() });
export type MyApprovalListResponse = z.infer<typeof MyApprovalListResponse>;
