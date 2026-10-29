import {
  EncumbranceCheckResult, XypAssetsResponse, XypPropertyAsset,
  type EncumbranceCheckRequest, type RequestContext,
} from '@los/contracts';
import type { InternalHttpClient } from '@los/nest-common';
import { EXTERNAL_TIMEOUT_MS, callUpstream, createInternalHttp, remapNotFound } from './upstream';

/** origination → kyc (sync REST, CLAUDE.md §3.2.2): ХУР-ын хөрөнгө (FR-6.3), өмчлөх эрх (FR-6.5), ачаалал ЗМС + ЭБ (FR-6.6). Тестэд солигдоно. */
export interface KycAssetsPort {
  /** `POST /api/xyp/assets` — регистрийн эзэмшлийн хөрөнгө. 404 `XYP_NOT_FOUND`, 503 `XYP_UNAVAILABLE`, 501 `INTEGRATION_NOT_IMPLEMENTED`. */
  fetchAssets(ctx: RequestContext, registerNo: string): Promise<XypAssetsResponse>;
  /** `POST /api/xyp/property` — өмчлөх эрхийн дугаараар өмчлөгчид. Олдохгүй бол 422 `REGISTRY_RECORD_NOT_FOUND`. */
  fetchProperty(ctx: RequestContext, propertyId: string): Promise<XypPropertyAsset>;
  /** `POST /api/collateral-checks/encumbrance` — fail closed: эх сурвалж унавал 503 `ENCUMBRANCE_UNAVAILABLE`. */
  checkEncumbrance(ctx: RequestContext, req: EncumbranceCheckRequest): Promise<EncumbranceCheckResult>;
}
export const KYC_ASSETS_PORT = Symbol('KYC_ASSETS_PORT');

const NOT_FOUND = 'ХУР-д ийм өмчлөх эрхийн дугаар олдсонгүй. Дугаараа шалгана уу';

/** `docs/05-collateral-documents.md` §5. Регистр, өмчлөгчийн нэр зөвхөн хариу руу; лог-д бичихгүй. */
export class HttpKycAssetsPort implements KycAssetsPort {
  constructor(private readonly http: InternalHttpClient = createInternalHttp(), private readonly timeoutMs: number = EXTERNAL_TIMEOUT_MS) {}

  fetchAssets(ctx: RequestContext, registerNo: string): Promise<XypAssetsResponse> {
    return callUpstream('kyc', () => this.http.post('kyc', '/api/xyp/assets', { registerNo }, { ctx, timeoutMs: this.timeoutMs, schema: XypAssetsResponse }));
  }

  async fetchProperty(ctx: RequestContext, propertyId: string): Promise<XypPropertyAsset> {
    try {
      return await callUpstream('kyc', () => this.http.post('kyc', '/api/xyp/property', { propertyId }, { ctx, timeoutMs: this.timeoutMs, schema: XypPropertyAsset }));
    } catch (e) {
      throw remapNotFound(e, ['XYP_NOT_FOUND'], 'REGISTRY_RECORD_NOT_FOUND', NOT_FOUND);
    }
  }

  checkEncumbrance(ctx: RequestContext, req: EncumbranceCheckRequest): Promise<EncumbranceCheckResult> {
    return callUpstream('kyc', () => this.http.post('kyc', '/api/collateral-checks/encumbrance', req, { ctx, timeoutMs: this.timeoutMs, schema: EncumbranceCheckResult }));
  }
}

export const createKycAssetsPort = (): KycAssetsPort => new HttpKycAssetsPort();
