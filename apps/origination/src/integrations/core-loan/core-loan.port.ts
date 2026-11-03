import type { IntegrationMode } from '@los/contracts';

/** FR-12.5: Core-д зээлийн данс нээх (CoreService.openLoan). Core нь хамрах хүрээнээс гадуур (docs/01 §1). */
export interface OpenLoanRequest {
  /** Давтагдашгүй түлхүүр (disbursement_request.id) — дахин дуудахад ижил данс буцаана, давхар нээхгүй. */
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

export interface CoreLoanPort {
  readonly mode: IntegrationMode;
  openLoan(req: OpenLoanRequest): Promise<OpenLoanResult>;
}
