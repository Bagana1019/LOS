import { NdshSalaryResponse, type RequestContext } from '@los/contracts';
import type { InternalHttpClient } from '@los/nest-common';
import { EXTERNAL_TIMEOUT_MS, callUpstream, createInternalHttp } from '../../collateral/ports/upstream';

/** origination → kyc (sync REST, CLAUDE.md §3.2.2): НДШ-ийн цалин (FR-4.1). Тестэд солигдоно. Регистр зөвхөн body-д. */
export interface KycNdshPort {
  /** `POST /api/ndsh/salaries` — 503 `NDSH_UNAVAILABLE`, 501 `INTEGRATION_NOT_IMPLEMENTED`. */
  fetchSalaries(ctx: RequestContext, registerNo: string): Promise<NdshSalaryResponse>;
}
export const KYC_NDSH_PORT = Symbol('KYC_NDSH_PORT');

export class HttpKycNdshPort implements KycNdshPort {
  constructor(private readonly http: InternalHttpClient = createInternalHttp()) {}

  fetchSalaries(ctx: RequestContext, registerNo: string): Promise<NdshSalaryResponse> {
    return callUpstream('kyc', () => this.http.post('kyc', '/api/ndsh/salaries', { registerNo }, { ctx, timeoutMs: EXTERNAL_TIMEOUT_MS, schema: NdshSalaryResponse }));
  }
}

export const createKycNdshPort = (): KycNdshPort => new HttpKycNdshPort();
