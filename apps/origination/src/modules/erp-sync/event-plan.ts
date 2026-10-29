// Бизнес оролт -> ERP-д дамжуулах үйл явдал (цэвэр функц). LOS журнал бичдэггүй: дансны код, дебит/кредит, тэнцэл ERP-н эрхшээлд (FIN-SYNC).
// Энд зөвхөн оролтыг шалгаж, дүнг каноник хэлбэрт оруулж, хуваарилалтын нийлбэрийг баталгаажуулна.
import type { z } from 'zod';
import {
  ErpDisbursementInput, ErpFeeDeductionInput, ErpRepaymentInput, erpMoneyToMinor, minorToErpMoney,
  type ErpEventData, type ErpEventType,
} from '@los/contracts';
import { InvalidErpEventInputError } from './erp-sync.errors';

export interface ErpEventHeader {
  orgId: string; branchId: string | null; applicationId: string; contractNo: string | null; coreLoanId: string | null;
  customerId: string | null; currency: string; businessDate: string; correlationId?: string; actorId: string | null;
}
export interface ErpEventPlan { eventType: ErpEventType; sourceId: string; header: ErpEventHeader; amount: string; data: ErpEventData; }

// minor -> мөр; 16 орноос хэтэрвэл InvalidErpEventInputError (strict=true) эсвэл тайлбарлах текст
function safeMoney(minor: bigint, strict = false): string {
  try { return minorToErpMoney(minor); } catch (e) {
    if (strict) throw new InvalidErpEventInputError(`invalid ERP event input — ${(e as Error).message}`);
    return minor.toString();
  }
}
function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  let r: z.SafeParseReturnType<unknown, z.output<S>>;
  try { r = schema.safeParse(input); } catch (e) {
    throw new InvalidErpEventInputError(`invalid ERP event input — ${(e as Error).message}`);
  }
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new InvalidErpEventInputError(`invalid ERP event input — ${issues.join('; ')}`, issues);
  }
  return r.data;
}
const headerOf = (p: ErpEventHeader): ErpEventHeader => ({
  orgId: p.orgId, branchId: p.branchId, applicationId: p.applicationId, contractNo: p.contractNo, coreLoanId: p.coreLoanId,
  customerId: p.customerId, currency: p.currency, businessDate: p.businessDate, correlationId: p.correlationId, actorId: p.actorId,
});

// Зээл олгох: нийт олгосон дүн
export function planDisbursement(input: unknown): ErpEventPlan {
  const p = parse(ErpDisbursementInput, input);
  return { eventType: 'DISBURSEMENT', sourceId: p.sourceId, header: headerOf(p), amount: p.amount, data: { amount: p.amount } };
}

// Шимтгэл суутгах/хураах: шимтгэл тус бүр + нийлбэр
export function planFeeDeduction(input: unknown): ErpEventPlan {
  const p = parse(ErpFeeDeductionInput, input);
  const total = safeMoney(p.fees.reduce((a, f) => a + erpMoneyToMinor(f.amount), 0n), true);
  return {
    eventType: 'FEE_DEDUCTION', sourceId: p.sourceId, header: headerOf(p), amount: total,
    data: { fees: p.fees.map((f) => ({ kind: f.kind, amount: f.amount, ...(f.memo ? { memo: f.memo } : {}) })), totalAmount: total },
  };
}

// Эргэн төлөлт: хүлээн авсан дүн + хуваарилалт. Хуваарилалт receivedAmount-тай тэнцэх ёстой — мартсан бүрэлдэхүүн чимээгүйгээр "илүү төлөлт" болохоос сэргийлнэ.
export function planRepayment(input: unknown): ErpEventPlan {
  const p = parse(ErpRepaymentInput, input);
  const received = erpMoneyToMinor(p.receivedAmount);
  const allocated = [p.principal, p.interest, p.penalty, p.fee, p.overpayment].reduce((a, v) => a + erpMoneyToMinor(v), 0n);
  if (allocated !== received) {
    throw new InvalidErpEventInputError(`invalid ERP event input — allocation ${safeMoney(allocated)} does not equal receivedAmount ${p.receivedAmount}`);
  }
  return {
    eventType: 'REPAYMENT', sourceId: p.sourceId, header: headerOf(p), amount: p.receivedAmount,
    data: { receivedAmount: p.receivedAmount, principal: p.principal, interest: p.interest, penalty: p.penalty, fee: p.fee, overpayment: p.overpayment },
  };
}

export const idempotencyKeyOf = (eventType: ErpEventType, sourceId: string) => `${eventType}:${sourceId}`;
