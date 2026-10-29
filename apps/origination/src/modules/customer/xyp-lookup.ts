import { XypCitizen } from '@los/contracts';
import type { RequestContext } from '@los/contracts';
import { DomainError, InternalHttpClient, UpstreamError } from '@los/nest-common';

/** origination → kyc (sync REST, CLAUDE.md §3.2.2). Тестэд солигдоно. */
export interface XypLookup {
  fetchCitizen(ctx: RequestContext, registerNo: string): Promise<XypCitizen>;
}
export const XYP_LOOKUP = Symbol('XYP_LOOKUP');

/** ХУР нь гадаад систем тул kyc-ийн хариуг хүлээх хугацаа 15с (CLAUDE.md §3.1); POST тул автоматаар дахин оролдохгүй. */
export class KycXypLookup implements XypLookup {
  constructor(private readonly http: InternalHttpClient = new InternalHttpClient()) {}

  async fetchCitizen(ctx: RequestContext, registerNo: string): Promise<XypCitizen> {
    try {
      return await this.http.post('kyc', '/api/xyp/citizen', { registerNo }, { ctx, timeoutMs: 15_000, schema: XypCitizen });
    } catch (e) {
      // ХУР унасан/бодит холболт байхгүй үед ЗЭЗ "гараар бөглөнө үү" гэсэн ойлгомжтой мессеж харна (NFR-2); бусад 5xx нь 502 хэвээр.
      if (e instanceof Error && e.name === 'ZodError') throw new UpstreamError('kyc', 200, 'kyc-ийн хариу гэрээнд нийцсэнгүй', 502); // дотоод гэрээний зөрүү — ЗЭЗ-ийн маягтын алдаа биш
      const body = e instanceof UpstreamError ? (e.upstreamBody as { code?: string; message?: string } | undefined) : undefined;
      if (body?.code === 'XYP_UNAVAILABLE' || body?.code === 'INTEGRATION_NOT_IMPLEMENTED') throw new DomainError(body.code, body.message ?? 'ХУР ашиглах боломжгүй', body.code === 'XYP_UNAVAILABLE' ? 503 : 501);
      throw e;
    }
  }
}
