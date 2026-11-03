import { z } from 'zod';

// ── Модуль 7 · ЭТХ (FR-7) ───────────────────────────────────────────────────────────────────────────
// Принципал, хүү, хугацаа нь хүсэлтийн зээлийн нөхцөлөөс (Модуль 5) авна; энд зөвхөн ЭТХ-ийн параметр.

export const ScheduleTypeEnum = z.enum(['ANNUITY', 'EQUAL_PRINCIPAL', 'QUARTERLY', 'BULLET']);
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

export const ScheduleParamsRequest = z.object({
  /** Олгох (эхлэх) огноо */
  startDate: ymd,
  firstPaymentDate: ymd,
  type: ScheduleTypeEnum,
  /** Үндсэн зээлээс чөлөөлөх сар (зөвхөн хүү төлнө) */
  graceMonths: z.number().int().min(0).max(599).default(0),
}).strict();
export type ScheduleParamsRequest = z.infer<typeof ScheduleParamsRequest>;

export const ScheduleRowView = z.object({
  seq: z.number().int(), dueDate: ymd, days: z.number().int(), disbursement: z.number(), principal: z.number(), interest: z.number(), total: z.number(), balance: z.number(),
});
export type ScheduleRowView = z.infer<typeof ScheduleRowView>;

export const ScheduleView = z.object({
  id: z.string().nullable(),
  generatedAt: z.string().nullable(),
  /** FR-7.3: нөхцөл өөрчлөгдсөн → дахин үүсгэх шаардлагатай */
  isStale: z.boolean(),
  params: z.object({
    startDate: ymd, firstPaymentDate: ymd, endDate: ymd, type: ScheduleTypeEnum, graceMonths: z.number().int(), dayCount: z.enum(['30/360', 'ACT/365']),
    principal: z.number(), annualRate: z.number(), termMonths: z.number().int(), currency: z.string(),
  }),
  summary: z.object({ installments: z.number().int(), totalPrincipal: z.number(), totalInterest: z.number(), totalPayment: z.number(), firstDueDate: z.string(), endDate: z.string() }),
  rows: z.array(ScheduleRowView),
});
export type ScheduleView = z.infer<typeof ScheduleView>;

/** GET: ЭТХ үүсгээгүй бол `schedule=null`. */
export const ScheduleResponse = z.object({ editable: z.boolean(), schedule: ScheduleView.nullable() });
export type ScheduleResponse = z.infer<typeof ScheduleResponse>;
