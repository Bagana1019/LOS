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

/**
 * Core дуудлага бүрийн (findLoan, openLoan) дээд хугацаа (CLAUDE.md §3.1: гадаад 15с). Adapter бүр үүнийг хэрэгжүүлэх ЁСТОЙ —
 * origination-ий lease (CORE_LEASE_MS) ба send deadline үүн дээр тулгуурладаг (H1; `assertCoreTiming` модуль ачаалахад шалгана).
 */
export const CORE_CALL_TIMEOUT_MS = 15_000;

export class CoreLoanError extends Error {
  constructor(readonly code: 'CORE_REJECTED' | 'CORE_UNAVAILABLE' | 'NOT_IMPLEMENTED', message: string) { super(message); this.name = 'CoreLoanError'; }
}

/**
 * H1 гэрээ (Core adapter бүр мөрдөнө):
 * - `openLoan` нь `idempotencyKey`-ээр idempotent: ижил түлхүүрээр дахин дуудвал шинэ данс нээхгүй, анхны дансыг буцаана.
 * - `findLoan(idempotencyKey)` нь тухайн лавлагаагаар нээгдсэн дансыг буцаана, байхгүй бол `null`. Үр дүн тодорхойгүй (сүлжээ/5xx) бол
 *   `null` БИШ, `CoreLoanError('CORE_UNAVAILABLE')` шиднэ — `null` нь "Core-д байхгүй нь баталгаатай" гэсэн утгатай.
 * Origination нь `openLoan`-оос өмнө үргэлж `findLoan` дуудна (DB lease дор), тиймээс Core idempotency алдагдсан ч давхар нээхгүй.
 * `openLoan` timeout болсны дараа Core хүсэлтийг хожуу боловсруулж болно — тиймээс origination `null`-г шууд баталгаа гэж үзэхгүй,
 *   settle цонх (DISBURSEMENT_CORE_SETTLE_SECONDS) + 2 лавлагааны дараа л (H1). Real adapter: Core-ийн хамгийн урт боловсруулалт < settle цонх байх ёстой.
 * - `CORE_REJECTED` = тухайн түлхүүрээр данс нээгдээгүй бөгөөд нээгдэхгүй нь баталгаатай. Ижил түлхүүрийн өмнөх хүсэлт боловсруулагдаж байвал
 *   татгалзахгүй — `CORE_UNAVAILABLE` (тодорхойгүй) буцаана; эс бөгөөс origination буцаахыг шууд зөвшөөрнө.
 */
export interface CoreLoanPort {
  readonly mode: IntegrationMode;
  openLoan(req: OpenLoanRequest): Promise<OpenLoanResult>;
  findLoan(idempotencyKey: string): Promise<OpenLoanResult | null>;
}
