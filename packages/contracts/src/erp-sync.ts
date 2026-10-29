import { z } from 'zod';
// ERP синк (FIN-SYNC, NFR-2). ERP нь журналын эзэн: LOS нь дансны код, дебит/кредит, тэнцлийг БИЧДЭГГҮЙ — зөвхөн бизнес үйл явдал
// (олголт, шимтгэл суутгал, эргэн төлөлт)-ыг найдвартай дамжуулна (docs/DECISIONS.md: ERP-sync-owner). ERP үйл явдлаас журналаа өөрөө үүсгэнэ.
// Мөнгө дамжуулахад зөвхөн аравтын мөр ("1250000.00") — floating point-оос зайлсхийнэ.

export const ErpEventType = ['DISBURSEMENT', 'FEE_DEDUCTION', 'REPAYMENT'] as const;
export type ErpEventType = (typeof ErpEventType)[number];
// PENDING = илгээгдэх/дахин оролдох; SENT = хүлээн авсан; DEAD = оролдлого дууссан/засвар шаардлагатай; CANCELLED = гараар хаасан
export const ErpEventStatus = ['PENDING', 'SENT', 'DEAD', 'CANCELLED'] as const;
export type ErpEventStatus = (typeof ErpEventStatus)[number];
export const ErpFeeKind = ['ORIGINATION', 'SERVICE', 'INSURANCE', 'OTHER'] as const;
export type ErpFeeKind = (typeof ErpFeeKind)[number];

// ---- Мөнгө: numeric(18,2) ↔ minor unit (bigint) ----
const MONEY_RE = /^\d{1,16}\.\d{2}$/;
const MAX_MINOR = 999_999_999_999_999_999n; // 16 орон + 2 бутархай
// number-ээр цент бүр үнэн зөв илэрхийлэгдэх дээд хэмжээ: 2^44 хүртэл double-ийн алхам ≤ 2^-8 < 0.005 тул 2 оронтой дүн бүр өөрийн цент рүү буцаж ойр бөөрнөглөгдөнө. Үүнээс том дүнг мөр (string)-ээр дамжуулна.
const MAX_NUMBER_AMOUNT = 2 ** 44;
export const ErpMoneyString = z.string().regex(MONEY_RE, 'money must be a decimal string with 2 fraction digits');
export function erpMoneyToMinor(money: string): bigint {
  if (!MONEY_RE.test(money)) throw new Error(`invalid money string: ${money}`);
  return BigInt(money.replace('.', ''));
}
export function minorToErpMoney(minor: bigint): string {
  if (minor < 0n) throw new Error('negative money is not representable');
  if (minor > MAX_MINOR) throw new Error('money amount exceeds 16 integer digits');
  const s = minor.toString().padStart(3, '0');
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}
// Prisma.Decimal / decimal.js мэт toFixed()-тэй объект
export type ErpDecimalLike = { toFixed(dp?: number): string; toString(): string };
const isDecimalLike = (v: unknown): v is ErpDecimalLike =>
  typeof v === 'object' && v !== null && typeof (v as ErpDecimalLike).toFixed === 'function';
// number | string | Decimal -> "1250000.00". 2-оос олон орон, сөрөг, NaN, 16-аас олон оронг зөвшөөрөхгүй.
export function normalizeErpMoney(input: number | string | ErpDecimalLike): string {
  let text: string;
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) throw new Error(`invalid money amount: ${input}`);
    if (input > MAX_NUMBER_AMOUNT) throw new Error('money amount too large for a number — pass a decimal string');
    text = input.toFixed(2);
    if (Number(text) !== input) throw new Error(`money amount has more than 2 fraction digits: ${input}`);
  } else {
    text = typeof input === 'string' ? input.trim() : String(input.toString());
  }
  const m = /^(\d{1,16})(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) throw new Error(`invalid money amount: ${text.slice(0, 40)}`);
  return `${m[1]}.${(m[2] ?? '').padEnd(2, '0')}`;
}
function moneyInput(positive: boolean) {
  return z.union([z.number(), z.string(), z.custom<ErpDecimalLike>(isDecimalLike)]).transform((v, ctx) => {
    try {
      const m = normalizeErpMoney(v);
      if (positive && erpMoneyToMinor(m) === 0n) throw new Error('amount must be greater than zero');
      return m;
    } catch (e) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message });
      return z.NEVER;
    }
  });
}
export const ErpMoneyInput = moneyInput(false);
const PositiveMoneyInput = moneyInput(true);

// ---- ERP-д дамжуулах үйл явдлын оролт (бизнес модулиуд ErpSyncService-д дамжуулна) ----
const isRealDate = (s: string) => { const d = new Date(`${s}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; };
// Бизнесийн огноо (Asia/Ulaanbaatar). Бодит хуанлийн өдөр байх ёстой — эс бол Postgres `::date` cast дуудагчийн транзакцийг унагаана.
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealDate, 'must be a real calendar date').refine((s) => s >= '2000-01-01' && s <= '2100-12-31', 'date out of range');
// HTTP толгой (Idempotency-Key, X-Correlation-Id)-д орох тул зөвхөн ASCII; урт нь түлхүүр ≤ 200 багтахаар хязгаарлагдсан
const orgIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,39}$/, 'orgId must be 1-40 chars of A-Z a-z 0-9 . _ : -');
const sourceIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/, 'sourceId must be 1-100 chars of A-Z a-z 0-9 . _ : -');
const correlationIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/, 'correlationId must be 1-100 chars of A-Z a-z 0-9 . _ : -');
const refSchema = z.string().min(1).max(64);
const recordBase = z.object({
  orgId: orgIdSchema, branchId: refSchema.nullable().default(null),
  applicationId: refSchema, contractNo: refSchema.nullable().default(null),
  coreLoanId: refSchema.nullable().default(null), customerId: refSchema.nullable().default(null),
  // sourceId = бизнес баримтын ID (disbursement_request.id, төлбөрийн гүйлгээний ID) — idempotency түлхүүрийн үндэс.
  // Давтан дуудалт no-op; ижил sourceId + өөр дүн бол IdempotencyConflictError.
  sourceId: sourceIdSchema,
  // Үйл явдал зээлийн валютаар явна (хөрвүүлэлтийг ERP хийнэ). Анхдагч утгагүй — алдаатай валют дамжуулахаас сэргийлнэ.
  currency: z.string().regex(/^[A-Z]{3}$/), businessDate: IsoDate,
  correlationId: correlationIdSchema.optional(), actorId: z.string().max(64).nullable().default(null),
});
// amount = зээлийн ҮНДСЭН өрийг үүсгэх НИЙТ дүн (disbursement_request.disburse_amount). Олголтоос суутгасан шимтгэл багтсан хэвээр,
// шимтгэлийг emitFeeDeduction-аар тусад нь, нэг транзакцид дамжуулна.
export const ErpDisbursementInput = recordBase.extend({ amount: PositiveMoneyInput });
export type ErpDisbursementInput = z.input<typeof ErpDisbursementInput>;
// Олголтоор суутгасан бүх шимтгэл нэг дуудлагад (fees[]), sourceId = disbursement_request.id. Тусад нь хураасан шимтгэл өөрийн баримтын ID-тай.
export const ErpFeeDeductionInput = recordBase.extend({
  fees: z.array(z.object({ kind: z.enum(ErpFeeKind), amount: PositiveMoneyInput, memo: z.string().max(200).optional() })).min(1).max(20),
});
export type ErpFeeDeductionInput = z.input<typeof ErpFeeDeductionInput>;
// Хуваарилалтыг бүрэн заана: receivedAmount = principal + interest + penalty + fee + overpayment (0-ийг ч тодорхой). Зөрвэл татгалзана.
// sourceId = сувгийн гүйлгээний лавлах (QPAY:<txn>, банкны гүйлгээний ID).
export const ErpRepaymentInput = recordBase.extend({
  receivedAmount: PositiveMoneyInput,
  principal: ErpMoneyInput, interest: ErpMoneyInput, penalty: ErpMoneyInput, fee: ErpMoneyInput, overpayment: ErpMoneyInput,
});
export type ErpRepaymentInput = z.input<typeof ErpRepaymentInput>;

// ---- Үйл явдлын өгөгдөл (дүн, хуваарилалт) — ERP журналын мөрийг үүнээс өөрөө гаргана ----
export const ErpDisbursementData = z.object({ amount: ErpMoneyString });
export const ErpFeeDeductionData = z.object({
  fees: z.array(z.object({ kind: z.enum(ErpFeeKind), amount: ErpMoneyString, memo: z.string().max(200).optional() })).min(1).max(20),
  totalAmount: ErpMoneyString,
});
const RepaymentParts = z.object({
  receivedAmount: ErpMoneyString, principal: ErpMoneyString, interest: ErpMoneyString,
  penalty: ErpMoneyString, fee: ErpMoneyString, overpayment: ErpMoneyString,
});
// Хуваарилалт receivedAmount-тай тэнцэх ёстой — мартсан бүрэлдэхүүн чимээгүйгээр "илүү төлөлт" болохоос сэргийлнэ.
// Буруу форматтай дүнг талбарын түвшинд аль хэдийн мэдэгдсэн тул энд алгасна (raw Error шидэхгүй).
const safeMinor = (s: string): bigint | null => (MONEY_RE.test(s) ? BigInt(s.replace('.', '')) : null);
const allocationMatches = (d: z.infer<typeof RepaymentParts>): boolean => {
  const parts = [d.principal, d.interest, d.penalty, d.fee, d.overpayment].map(safeMinor);
  const received = safeMinor(d.receivedAmount);
  if (received === null || parts.some((p) => p === null)) return true;
  return parts.reduce<bigint>((a, p) => a + (p as bigint), 0n) === received;
};
export const ErpRepaymentData = RepaymentParts.refine(allocationMatches, { message: 'allocation does not equal receivedAmount' });
export type ErpEventData = z.infer<typeof ErpDisbursementData> | z.infer<typeof ErpFeeDeductionData> | z.infer<typeof ErpRepaymentData>;

// ---- Гадаад системд явах payload (wire format, version 1) ----
const payloadBase = z.object({
  schemaVersion: z.literal(1),
  // Org-оор нэрлэгдсэн дэлхийд давтагдахгүй түлхүүр: `<orgId>:<EVENT>:<sourceId>`. Хүлээн авагч энэ түлхүүрээр давхардлыг хаана.
  eventId: z.string().uuid(), idempotencyKey: z.string().min(1).max(200),
  orgId: z.string(), branchId: z.string().nullable(), applicationId: z.string(),
  contractNo: z.string().nullable(), coreLoanId: z.string().nullable(), customerId: z.string().nullable(),
  // Бизнес үйл явдал болсон огноо (Asia/Ulaanbaatar). Журналын огноо/мөчлөгийг ERP өөрөө шийднэ.
  businessDate: IsoDate, currency: z.string().regex(/^[A-Z]{3}$/),
  correlationId: z.string(), createdAt: z.string().datetime(),
});
export const ErpEventPayload = z.discriminatedUnion('eventType', [
  payloadBase.extend({ eventType: z.literal('DISBURSEMENT'), data: ErpDisbursementData }),
  payloadBase.extend({ eventType: z.literal('FEE_DEDUCTION'), data: ErpFeeDeductionData }),
  payloadBase.extend({ eventType: z.literal('REPAYMENT'), data: ErpRepaymentData }),
]);
export type ErpEventPayload = z.infer<typeof ErpEventPayload>;

// ---- Ops (админ) харагдац ----
export const ErpEventListQuery = z.object({
  status: z.enum(ErpEventStatus).optional(), eventType: z.enum(ErpEventType).optional(),
  applicationId: z.string().max(64).optional(), errorCode: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().regex(/^\d{1,18}$/).optional(),
});
export type ErpEventListQuery = z.infer<typeof ErpEventListQuery>;
export const ErpEventCancelBody = z.object({ note: z.string().trim().min(3).max(500) });
export const ErpEventRequeueBody = z.object({ note: z.string().trim().max(500).optional() });
// Бөөнөөр: DEAD үйл явдлуудыг (алдааны кодоор шүүж) дахин оролдуулна — буруу URL/эрх зассаны дараа
export const ErpEventRequeueDeadBody = z.object({
  errorCode: z.string().max(64).optional(), limit: z.number().int().min(1).max(500).default(200), note: z.string().trim().max(500).optional(),
});
