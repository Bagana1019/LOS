// FR-3 · ЗМС (CIB), FICO, ӨОХ, малын тоо, ХУР-ын 6 лавлагаа (CLAUDE.md §3.2.7: interface + MockXxx + RealXxx, INTEGRATION_MODE).
// BLACKLIST-ийг энд татахгүй: origination (хар жагсаалтын эзэмшигч) тулгаад дамжуулна.
import type { InquirySource, InquiryWarningLevel } from '@los/contracts';

/** Гадаад системээс татаж болох 10 эх сурвалж (BLACKLIST-ээс бусад). */
export type ExternalInquirySource = Exclude<InquirySource, 'BLACKLIST'>;

export interface ProviderResult {
  /** summary_json — snake_case (docs/03): active_loan_count, total_disbursed, outstanding, monthly_payment, fico_score, dti … */
  summary: Record<string, unknown>;
  /** Гадаад системийн дэлгэрэнгүй хариу (хувийн мэдээлэлтэй — шифрлэгдэж хадгалагдана) */
  detail: Record<string, unknown>;
  warningLevel: InquiryWarningLevel;
}

/** Дуудлагын нэмэлт контекст. ЗМС (SainScore) харилцагчийн утас, имэйлийг заавал шаарддаг (origination дамжуулна). */
export interface InquiryContext {
  contact?: { phone?: string | null; email?: string | null };
}

export interface InquiryProvider {
  /** @param registerNo нормчилсон регистр. Эх сурвалж түр ажиллахгүй бол `InquiryUnavailableError`, vendor татгалзвал `InquiryRejectedError`. */
  fetch(source: ExternalInquirySource, registerNo: string, ctx?: InquiryContext): Promise<ProviderResult>;
}
export const INQUIRY_PROVIDER = Symbol('INQUIRY_PROVIDER');

/** Vendor лавлагааг бизнесийн шалтгаанаар татгалзсан (терминал; дахин оролдохгүй). vendorCode: vendor-ийн код (SR0260…) эсвэл дотоод (CONTACT_REQUIRED, LOGIN_REJECTED). */
export class InquiryRejectedError extends Error {
  constructor(readonly source: string, readonly vendorCode: string, message: string) {
    super(message);
    this.name = 'InquiryRejectedError';
  }
}

export class InquiryUnavailableError extends Error {
  constructor(readonly source: string, message = `${source} лавлагааны сервис түр ажиллахгүй байна`) {
    super(message);
    this.name = 'InquiryUnavailableError';
  }
}
