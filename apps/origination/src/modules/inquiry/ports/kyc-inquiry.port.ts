import {
  CreditHistorySummary, InquiryFetchRequest, InquiryFetchResponse, InquiryListResponse, UnregisteredLoan,
  type KycUnregisteredLoanRequest, type RequestContext,
} from '@los/contracts';
import type { z } from 'zod';
import type { InternalHttpClient } from '@los/nest-common';
import { EXTERNAL_TIMEOUT_MS, INTERNAL_TIMEOUT_MS, callUpstream, createInternalHttp } from '../../collateral/ports/upstream';

/** origination → kyc (sync REST, CLAUDE.md §3.2.2): FR-3 лавлагаа. Тестэд солигдоно. Регистр зөвхөн `fetch`-ийн body-д. */
/** zod default/transform-ийн өмнөх оролт (staleDays, registerNo нормчлол kyc-д). */
export type InquiryFetchInput = z.input<typeof InquiryFetchRequest>;

export interface KycInquiryPort {
  /** `POST /api/inquiry/fetch` — 11 лавлагаа (гадаад дуудлага → 15с). Эх сурвалж тус бүрийн алдаа `failures`-д. */
  fetch(ctx: RequestContext, req: InquiryFetchInput): Promise<InquiryFetchResponse>;
  /** `GET /api/inquiry` — харилцагч × эх сурвалжийн хамгийн сүүлийн мөр + бүртгэлгүй зээл. */
  list(ctx: RequestContext, applicationId: string): Promise<InquiryListResponse>;
  addUnregisteredLoan(ctx: RequestContext, req: KycUnregisteredLoanRequest): Promise<UnregisteredLoan>;
  removeUnregisteredLoan(ctx: RequestContext, applicationId: string, id: string): Promise<void>;
  /** `GET /api/inquiry/credit-history` — тооцоололд (Sosco, өрийн төлбөр). */
  creditHistory(ctx: RequestContext, applicationId: string, customerId: string): Promise<CreditHistorySummary>;
}
export const KYC_INQUIRY_PORT = Symbol('KYC_INQUIRY_PORT');

export class HttpKycInquiryPort implements KycInquiryPort {
  constructor(private readonly http: InternalHttpClient = createInternalHttp()) {}

  fetch(ctx: RequestContext, req: InquiryFetchInput): Promise<InquiryFetchResponse> {
    return callUpstream('kyc', () => this.http.post('kyc', '/api/inquiry/fetch', req, { ctx, timeoutMs: EXTERNAL_TIMEOUT_MS, schema: InquiryFetchResponse }));
  }

  list(ctx: RequestContext, applicationId: string): Promise<InquiryListResponse> {
    return callUpstream('kyc', () => this.http.get('kyc', '/api/inquiry', { ctx, timeoutMs: INTERNAL_TIMEOUT_MS, query: { applicationId }, schema: InquiryListResponse }));
  }

  addUnregisteredLoan(ctx: RequestContext, req: KycUnregisteredLoanRequest): Promise<UnregisteredLoan> {
    return callUpstream('kyc', () => this.http.post('kyc', '/api/inquiry/unregistered-loans', req, { ctx, timeoutMs: INTERNAL_TIMEOUT_MS, schema: UnregisteredLoan }));
  }

  async removeUnregisteredLoan(ctx: RequestContext, applicationId: string, id: string): Promise<void> {
    await callUpstream('kyc', () => this.http.delete('kyc', `/api/inquiry/unregistered-loans/${encodeURIComponent(id)}`, { ctx, timeoutMs: INTERNAL_TIMEOUT_MS, query: { applicationId } }));
  }

  creditHistory(ctx: RequestContext, applicationId: string, customerId: string): Promise<CreditHistorySummary> {
    return callUpstream('kyc', () => this.http.get('kyc', '/api/inquiry/credit-history', { ctx, timeoutMs: INTERNAL_TIMEOUT_MS, query: { applicationId, customerId }, schema: CreditHistorySummary }));
  }
}

export const createKycInquiryPort = (): KycInquiryPort => new HttpKycInquiryPort();
