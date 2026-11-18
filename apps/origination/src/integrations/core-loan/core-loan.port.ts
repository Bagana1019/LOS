import type { IntegrationMode } from '@los/contracts';

/** FR-12.5: Core-д зээлийн данс нээх (CoreService.openLoan). Core нь хамрах хүрээнээс гадуур (docs/01 §1). */
export interface OpenLoanRequest {
  /** Давтагдашгүй түлхүүр `<disbursement_request.id>:<илгээсэн дугаар>` — дахин дуудахад ижил данс буцаана, давхар нээхгүй; дахин илгээх бүрт шинэ (H1). */
  idempotencyKey: string;
  applicationId: string;
  contractNo: string;
  customerId: string;
  amount: number;
  currency: string;
  termMonths: number;
  interestRate: number;
  repaymentType: string;
  disburseDate: string;
  firstPaymentDate: string | null;
  /** Олгох данс. Бүтэн дугаар — Core руу л дамжина, лог/хариунд гаргахгүй. */
  account: { bankCode: string; accountNo: string; holderName: string };
}
export interface OpenLoanResult { coreLoanId: string }

export class CoreLoanError extends Error {
  constructor(readonly code: 'CORE_REJECTED' | 'CORE_UNAVAILABLE' | 'NOT_IMPLEMENTED', message: string) { super(message); this.name = 'CoreLoanError'; }
}

/**
 * H1 гэрээ (Core adapter бүр мөрдөнө):
 * - `openLoan` нь `idempotencyKey`-ээр idempotent: ижил түлхүүрээр дахин дуудвал шинэ данс нээхгүй, анхны дансыг буцаана.
 * - `findLoan(idempotencyKey)` нь тухайн лавлагаагаар нээгдсэн дансыг буцаана, байхгүй бол `null`. Үр дүн тодорхойгүй (сүлжээ/5xx) бол
 *   `null` БИШ, `CoreLoanError('CORE_UNAVAILABLE')` шиднэ — `null` нь "Core-д байхгүй нь баталгаатай" гэсэн утгатай.
 * Origination нь `openLoan`-оос өмнө үргэлж `findLoan` дуудна (DB lease дор), тиймээс Core idempotency алдагдсан ч давхар нээхгүй.
 */
export interface CoreLoanPort {
  readonly mode: IntegrationMode;
  openLoan(req: OpenLoanRequest): Promise<OpenLoanResult>;
  findLoan(idempotencyKey: string): Promise<OpenLoanResult | null>;
}
