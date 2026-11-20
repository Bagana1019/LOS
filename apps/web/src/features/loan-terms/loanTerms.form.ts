import type { LoanTermsView, SaveLoanTermsRequest } from '@los/contracts';
import { percentToRate, rateToPercent } from '../../lib/format';

/**
 * Алхмын формын утга. Шимтгэл ХУВИАР (`feeRatePercent`: 1.5), API-д бутархай (`feeRate`: 0.015) — F2-17: өмнө нь талбар бутархай авч, "1.5" гэж бичвэл
 * чимээгүй 1 (=100%) болдог байв. Хөрвүүлэлт зөвхөн энд (хоёр чиглэлд); `interestRate` аль хэдийн хувиар (23.99) тул хөрвүүлэхгүй.
 */
export interface TermsFormValues {
  productId: string;
  amount: number;
  termMonths: number;
  interestRate?: number;
  feeRatePercent?: number;
  downPayment?: number;
  charges?: number;
  insurance?: number;
  purpose: string;
  purposeDetail?: string;
  cibPurposeCode?: string;
  cibSubCode?: string;
  officerNote?: string;
}

/** Форм → PUT body. Хоосон талбарыг илгээхгүй (сервер анхдагчийг бөглөнө); шимтгэлийн 0% нь тодорхой утга тул хадгалагдана. */
export function toSaveRequest({ feeRatePercent, ...rest }: TermsFormValues): SaveLoanTermsRequest {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) if (v !== undefined && v !== null && v !== '') out[k] = v;
  if (feeRatePercent !== undefined && feeRatePercent !== null) out.feeRate = percentToRate(feeRatePercent);
  return out as SaveLoanTermsRequest;
}

const opt = <T>(v: T | null | undefined): T | undefined => v ?? undefined;

/** Серверийн харагдац → формын эхний утга. */
export function toFormValues(d: LoanTermsView): Partial<TermsFormValues> {
  return {
    productId: opt(d.productId), amount: opt(d.amount), termMonths: opt(d.termMonths), interestRate: opt(d.interestRate),
    feeRatePercent: typeof d.feeRate === 'number' ? rateToPercent(d.feeRate) : undefined,
    downPayment: opt(d.downPayment), charges: opt(d.charges), insurance: opt(d.insurance),
    purpose: opt(d.purpose), purposeDetail: opt(d.purposeDetail), cibPurposeCode: opt(d.cibPurposeCode), cibSubCode: opt(d.cibSubCode), officerNote: opt(d.officerNote),
  };
}
