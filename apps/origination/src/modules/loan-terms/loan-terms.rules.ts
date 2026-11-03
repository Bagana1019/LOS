import type { LimitViolation, ProductLimits } from '@los/contracts';

// Модуль 5 / 7 — цэвэр дүрмүүд (I/O байхгүй).

export const LOAN_STEP = 'loan';
export const INSTALLMENT_STEP = 'installment';
export const LOAN_TERMS_CHANGED = 'LOAN_TERMS_CHANGED';

export interface TermsCore { productId: string | null; currency: string; amount: number | null; termMonths: number | null; interestRate: number | null; feeRate: number | null }

/** FR-5.1: дүн, хугацаа, хүү бүтээгдэхүүний [min, max]-д багтах ёстой. Нэг талбар бүрийн зөрчлийг буцаана (хоосон = зөв). */
export function checkLimits(t: { amount: number; termMonths: number; interestRate: number }, l: ProductLimits): LimitViolation[] {
  const out: LimitViolation[] = [];
  const check = (field: LimitViolation['field'], value: number, min: number, max: number) => { if (value < min || value > max) out.push({ field, value, min, max }); };
  check('amount', t.amount, l.minAmount, l.maxAmount);
  check('termMonths', t.termMonths, l.minTermMonths, l.maxTermMonths);
  check('interestRate', t.interestRate, l.minRate, l.maxRate);
  return out;
}

/** FR-7.3: ЭТХ-д нөлөөлөх талбар (бүтээгдэхүүн, дүн, хугацаа, хүү, шимтгэл, валют) өөрчлөгдсөн эсэх. Урьдчилгаа/даатгал/тайлбар нөлөөлөхгүй. */
export function termsChanged(prev: TermsCore, next: TermsCore): boolean {
  return prev.productId !== next.productId || prev.currency !== next.currency || prev.amount !== next.amount
    || prev.termMonths !== next.termMonths || prev.interestRate !== next.interestRate || prev.feeRate !== next.feeRate;
}

export interface StepRow { id: string; stepKey: string; status: string }
export interface StepPlan { id: string; stepKey: string; status: 'COMPLETED' | 'STALE'; staleReason: string | null; completedAt?: Date }

/**
 * Нөхцөл хадгалсны дараах алхмууд: `loan` → COMPLETED (хязгаарт багтсан бүрэн нөхцөл тул); нөхцөл өөрчлөгдөөд `installment` COMPLETED бол STALE.
 * LOCKED алхамд хүрэхгүй; өөрчлөлтгүй бол хоосон (идемпотент).
 */
export function planTermsSteps(steps: readonly StepRow[], changed: boolean, now: Date): StepPlan[] {
  const out: StepPlan[] = [];
  const loan = steps.find((s) => s.stepKey === LOAN_STEP);
  if (loan && loan.status !== 'LOCKED' && loan.status !== 'COMPLETED') out.push({ id: loan.id, stepKey: LOAN_STEP, status: 'COMPLETED', staleReason: null, completedAt: now });
  const inst = steps.find((s) => s.stepKey === INSTALLMENT_STEP);
  if (changed && inst?.status === 'COMPLETED') out.push({ id: inst.id, stepKey: INSTALLMENT_STEP, status: 'STALE', staleReason: LOAN_TERMS_CHANGED });
  return out;
}

export interface ScheduleTermsSnapshot { principal: number; annualRate: number; termMonths: number }
/** Хадгалсан ЭТХ-ийн параметр одоогийн нөхцөлөөс зөрж байвал (өөр замаар өөрчлөгдсөн ч) хуучирсан гэж үзнэ. */
export function scheduleOutdated(saved: ScheduleTermsSnapshot, current: { amount: number | null; interestRate: number | null; termMonths: number | null }): boolean {
  return saved.principal !== current.amount || saved.annualRate !== current.interestRate || saved.termMonths !== current.termMonths;
}
