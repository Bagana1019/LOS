import { AmlScreeningResult, type AmlScreenRequest, type RequestContext } from '@los/contracts';
import { DomainError, UpstreamError, type InternalHttpClient } from '@los/nest-common';
import type { z } from 'zod';
import { EXTERNAL_TIMEOUT_MS, INTERNAL_TIMEOUT_MS, createInternalHttp } from '../../collateral/ports/upstream';

/**
 * origination → kyc AML (sync REST, CLAUDE.md §3.2.2; docs/05-compliance-aml.md §7). G1-д ашиглана; тестэд `KYC_AML_PORT`-ийг fake-ээр солино.
 * INTEGRATION_MODE (mock/real) нь kyc-ийн UN_SC/FATF adapter-т — origination энд зөвхөн kyc-ийг дуудна.
 * FAIL-CLOSED: kyc-ийн аливаа алдаа (сүлжээ, timeout, 5xx, гэрээний зөрүү, auth) → 503 `AML_SCREENING_UNAVAILABLE` (retryable); хэзээ ч «цэвэр» буцаахгүй.
 */
export interface KycAmlPort {
  /** `POST /api/aml/screen` — жагсаалт татаж болох тул гадаад timeout (15с); POST давтахгүй. */
  screen(ctx: RequestContext, req: z.input<typeof AmlScreenRequest>): Promise<AmlScreeningResult>;
  /** `GET /api/aml/customers/:id/latest` — шалгалт байхгүй (404) бол null. */
  latest(ctx: RequestContext, customerId: string): Promise<AmlScreeningResult | null>;
}
export const KYC_AML_PORT = Symbol('KYC_AML_PORT');

export const amlUnavailable = (): DomainError =>
  new DomainError('AML_SCREENING_UNAVAILABLE', 'AML шалгалтын үйлчилгээ (kyc) түр ажиллахгүй байна — хэсэг хугацааны дараа дахин илгээнэ үү', 503, { retryable: true });

/** kyc-ийн 4xx (`DomainError`, upstream биш). 5xx/сүлжээ нь `UpstreamError`. */
const upstreamStatus4xx = (e: unknown): number | null => (e instanceof DomainError && !(e instanceof UpstreamError) ? e.getStatus() : null);

/** kyc-ийн алдааг G1-ийн тогтвортой код руу. Үл мэдэгдэх бүхэн → unavailable (fail-closed). */
export function mapKycAmlError(e: unknown): DomainError {
  const status = upstreamStatus4xx(e);
  if (status === 400) return new DomainError('AML_SUBJECT_INVALID', 'Оролцогчийн мэдээлэл (нэр, регистр, төрсөн огноо) AML шалгалтад хүчингүй байна — засаад дахин илгээнэ үү', 422, { retryable: false });
  if (status === 409) return new DomainError('AML_SCREENING_STALE', 'Энэ харилцагчийн AML шалгалт зэрэг явагдаж байна эсвэл шийдвэрлэгдээгүй өөр шалгалттай — дахин илгээнэ үү', 409, { retryable: true });
  return amlUnavailable();
}

export class HttpKycAmlPort implements KycAmlPort {
  constructor(private readonly http: InternalHttpClient = createInternalHttp()) {}

  async screen(ctx: RequestContext, req: z.input<typeof AmlScreenRequest>): Promise<AmlScreeningResult> {
    try {
      return await this.http.post('kyc', '/api/aml/screen', req, { ctx, timeoutMs: EXTERNAL_TIMEOUT_MS, schema: AmlScreeningResult });
    } catch (e) {
      throw mapKycAmlError(e);
    }
  }

  async latest(ctx: RequestContext, customerId: string): Promise<AmlScreeningResult | null> {
    try {
      return await this.http.get('kyc', `/api/aml/customers/${encodeURIComponent(customerId)}/latest`, { ctx, timeoutMs: INTERNAL_TIMEOUT_MS, schema: AmlScreeningResult });
    } catch (e) {
      if (upstreamStatus4xx(e) === 404) return null;
      throw mapKycAmlError(e);
    }
  }
}

export const createKycAmlPort = (): KycAmlPort => new HttpKycAmlPort();
