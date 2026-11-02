import { z } from 'zod';
import { ApplicationSource, ApplicationStatus, StepKey, StepStatus } from '../enums';

// ── Зээлийн хүсэлт ба төлвийн машин (Модуль 2 · FR-1, docs/01 §4) ──────────────────────────────────────────────
// Үүсгэх, жагсаалт (9 таб), дэлгэрэнгүй (12 алхам), төлвийн шилжилт. Нөхцөл (дүн, хүү, хугацаа) нь Модуль 5-ын эзэмшил тул энд оруулахгүй.

const id = z.string().trim().min(1).max(64);
const text = (max: number) => z.string().trim().min(1).max(max);

/** 1-р үе шат (ЗЭЗ бүрдүүлнэ) 9 алхам, 2-р үе шат (батлагдсаны дараа) 3 алхам. */
export const STAGE1_STEPS = ['client', 'inquiry', 'income', 'loan', 'collateral', 'installment', 'score', 'document', 'decision'] as const satisfies readonly StepKey[];
export const STAGE2_STEPS = ['contract', 'official_documents', 'disburse'] as const satisfies readonly StepKey[];

export const CreateApplicationRequest = z.object({
  /** Бүтээгдэхүүн заавал биш — 4-р алхамд (Зээлийн мэдээлэл) сонгож болно. */
  productId: id.optional(),
  purpose: text(200).optional(),
  /** Зөвхөн ADMIN өөр салбарт үүсгэнэ; ЗЭЗ-д өөрийн салбар. */
  branchId: id.optional(),
}).strict();
export type CreateApplicationRequest = z.infer<typeof CreateApplicationRequest>;

export const ApplicationSort = ['appNo', 'createdAt', 'amount', 'status', 'decidedAt'] as const;
export const APPLICATION_PAGE_SIZES = [10, 20, 50, 100] as const;


export const ApplicationListQuery = z.object({
  status: z.enum(ApplicationStatus).optional(),
  /** Нэгдсэн хайлт: хүсэлтийн / гэрээний дугаар (FR-1.4). */
  q: z.string().trim().max(64).optional(),
  branchId: id.optional(),
  officerId: id.optional(),
  productId: id.optional(),
  currency: z.string().trim().length(3).optional(),
  createdFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  createdTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sort: z.enum(ApplicationSort).default('createdAt'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().refine((n) => (APPLICATION_PAGE_SIZES as readonly number[]).includes(n), '10, 20, 50, 100').default(20),
}).strict();
export type ApplicationListQuery = z.infer<typeof ApplicationListQuery>;
export const ApplicationExportQuery = ApplicationListQuery.omit({ page: true, pageSize: true });
export type ApplicationExportQuery = z.infer<typeof ApplicationExportQuery>;

export const ApplicationPrimaryBorrower = z.object({ customerId: z.string(), displayName: z.string(), registerNoMasked: z.string() });

/** FR-1.2 жагсаалтын нэг мөр. */
export const ApplicationRow = z.object({
  id: z.string(),
  appNo: z.string(),
  branchId: z.string(),
  officerId: z.string().nullable(),
  contractNo: z.string().nullable(),
  primaryBorrower: ApplicationPrimaryBorrower.nullable(),
  productId: z.string().nullable(),
  productName: z.string().nullable(),
  currency: z.string(),
  amount: z.number().nullable(),
  interestRate: z.number().nullable(),
  termMonths: z.number().int().nullable(),
  decidedAt: z.string().datetime().nullable(),
  status: z.enum(ApplicationStatus),
  /** Бүрдсэн 1-р үе шатны заавал алхам / нийт заавал (BR-7). */
  stepsDone: z.number().int(),
  stepsRequired: z.number().int(),
  createdAt: z.string().datetime(),
});
export type ApplicationRow = z.infer<typeof ApplicationRow>;

export const ApplicationListResponse = z.object({
  items: z.array(ApplicationRow),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  /** Таб бүрийн тоо (хүрээнд тохирсон; бусад шүүлт үл хамаарна). */
  counts: z.record(z.enum(ApplicationStatus), z.number().int()),
  /** "Миний батлах" тоолуур — батлах урсгал (Модуль 10) ирэх хүртэл 0. */
  myApprovalCount: z.number().int(),
});
export type ApplicationListResponse = z.infer<typeof ApplicationListResponse>;

export const ApplicationStepView = z.object({
  stepKey: z.enum(StepKey),
  stage: z.union([z.literal(1), z.literal(2)]),
  order: z.number().int(),
  status: z.enum(StepStatus),
  required: z.boolean(),
  completedAt: z.string().datetime().nullable(),
  staleReason: z.string().nullable(),
});
export type ApplicationStepView = z.infer<typeof ApplicationStepView>;

export const ApplicationTransitionView = z.object({
  to: z.enum(ApplicationStatus),
  /** Хэрэглэгч (энэ хүсэлтэд, одоогийн эрхээр) өөрөө хийж чадах эсэх; false = систем / өөр модуль шилжүүлнэ. */
  allowed: z.boolean(),
  /** Илгээх үед G1 хаалт: дутуу алхмууд. */
  blockedBy: z.array(z.enum(StepKey)),
});

export const ApplicationDetail = ApplicationRow.extend({
  officerNote: z.string().nullable(),
  purpose: z.string().nullable(),
  version: z.number().int(),
  source: z.enum(ApplicationSource),
  submittedAt: z.string().datetime().nullable(),
  approvedAt: z.string().datetime().nullable(),
  returnedAt: z.string().datetime().nullable(),
  steps: z.array(ApplicationStepView),
  /** Wizard-ийн 1-р үе шатны тоолуур, ж: 6/9 (бүрдсэн алхам / 1-р үе шатны алхам). */
  stage1Completed: z.number().int(),
  stage1Total: z.number().int(),
  editable: z.boolean(),
  transitions: z.array(ApplicationTransitionView),
});
export type ApplicationDetail = z.infer<typeof ApplicationDetail>;

export const TransitionRequest = z.object({ to: z.enum(ApplicationStatus), reason: text(500).optional() }).strict();
export type TransitionRequest = z.infer<typeof TransitionRequest>;

export const ApplicationHistoryItem = z.object({
  at: z.string().datetime(),
  actorId: z.string().nullable(),
  from: z.string().nullable(),
  to: z.string(),
  reason: z.string().nullable(),
});
export const ApplicationHistoryResponse = z.object({ items: z.array(ApplicationHistoryItem) });
export type ApplicationHistoryResponse = z.infer<typeof ApplicationHistoryResponse>;
