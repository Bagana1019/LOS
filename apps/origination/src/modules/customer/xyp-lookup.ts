import { XypCitizen, XypOtpResponse } from '@los/contracts';
import type { RequestContext } from '@los/contracts';
import { DomainError, InternalHttpClient, UpstreamError } from '@los/nest-common';

/** origination → kyc (sync REST, CLAUDE.md §3.2.2). Тестэд солигдоно. */
export interface XypLookup {
  /**
   * Иргэний зөвшөөрөл, 1-р алхам: ХУР иргэний ХУР-д БҮРТГЭЛТЭЙ утсанд нэг удаагийн код илгээнэ. Утсыг дуудагч СОНГОХГҮЙ.
   * НЭГ л дуудлага: дахин оролдвол иргэнд SMS давхар очно.
   */
  requestOtp(ctx: RequestContext, registerNo: string): Promise<XypOtpResponse>;
  /** 2-р алхам: иргэний утсанд ирсэн кодоор иргэний мэдээлэл. Код буруу / хугацаа дууссан → `XYP_OTP_INVALID` (422). Код нууц: лог, алдаанд орохгүй. */
  fetchCitizen(ctx: RequestContext, registerNo: string, otp: string): Promise<XypCitizen>;
}
export const XYP_LOOKUP = Symbol('XYP_LOOKUP');

/** ХУР унасан/бодит холболт байхгүй үед ЗЭЗ "гараар бөглөнө үү" гэсэн ойлгомжтой мессеж харна (NFR-2); бусад 5xx нь 502 хэвээр. 4xx (олдсонгүй, код буруу) кодтойгоо дамжина. */
function mapKycError(e: unknown): unknown {
  if (e instanceof Error && e.name === 'ZodError') return new UpstreamError('kyc', 200, 'kyc-ийн хариу гэрээнд нийцсэнгүй', 502); // дотоод гэрээний зөрүү — ЗЭЗ-ийн маягтын алдаа биш
  const body = e instanceof UpstreamError ? (e.upstreamBody as { code?: string; message?: string } | undefined) : undefined;
  if (body?.code === 'XYP_UNAVAILABLE' || body?.code === 'INTEGRATION_NOT_IMPLEMENTED') return new DomainError(body.code, body.message ?? 'ХУР ашиглах боломжгүй', body.code === 'XYP_UNAVAILABLE' ? 503 : 501);
  return e;
}

/** ХУР нь гадаад систем тул kyc-ийн хариуг хүлээх хугацаа 15с (CLAUDE.md §3.1); POST тул автоматаар дахин оролдохгүй. */
export class KycXypLookup implements XypLookup {
  constructor(private readonly http: InternalHttpClient = new InternalHttpClient()) {}

  async requestOtp(ctx: RequestContext, registerNo: string): Promise<XypOtpResponse> {
    try {
      return await this.http.post('kyc', '/api/xyp/citizen/otp', { registerNo }, { ctx, timeoutMs: 15_000, schema: XypOtpResponse });
    } catch (e) {
      throw mapKycError(e);
    }
  }

  async fetchCitizen(ctx: RequestContext, registerNo: string, otp: string): Promise<XypCitizen> {
    try {
      return await this.http.post('kyc', '/api/xyp/citizen', { registerNo, otp }, { ctx, timeoutMs: 15_000, schema: XypCitizen });
    } catch (e) {
      throw mapKycError(e);
    }
  }
}
