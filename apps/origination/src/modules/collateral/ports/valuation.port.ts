import { z } from 'zod';
import {
  CollateralValuationRecord, SaveCollateralValuationResponse, SuggestValuationResponse, ValuationHistoryResponse, VehicleLookupResponse,
  type RecordExternalValuationRequest, type RequestContext, type SaveCollateralValuationRequest, type SuggestValuationRequest,
} from '@los/contracts';
import type { InternalHttpClient } from '@los/nest-common';
import { EXTERNAL_TIMEOUT_MS, INTERNAL_TIMEOUT_MS, callUpstream, createInternalHttp, remapNotFound } from './upstream';

/** origination → valuation (sync REST): АТҮТ-ийн өмчлөгч (FR-6.5), үнэлгээний санал/хадгалалт/гадны/түүх (FR-14). Тестэд солигдоно. */
export interface ValuationPort {
  /** `POST /api/valuate/vehicle-lookup` — улсын дугаараар өмчлөгч (АТҮТ). Олдохгүй бол 422 `REGISTRY_RECORD_NOT_FOUND`. */
  lookupVehicle(ctx: RequestContext, plateNo: string): Promise<VehicleLookupResponse>;
  suggest(ctx: RequestContext, req: SuggestValuationRequest): Promise<SuggestValuationResponse>;
  save(ctx: RequestContext, req: SaveCollateralValuationRequest): Promise<SaveCollateralValuationResponse>;
  /** Гадны үнэлгээ → хадгалагдсан `collateral_valuation` мөр. */
  recordExternal(ctx: RequestContext, req: RecordExternalValuationRequest): Promise<CollateralValuationRecord>;
  history(ctx: RequestContext, collateralId: string): Promise<ValuationHistoryResponse>;
}
export const VALUATION_PORT = Symbol('VALUATION_PORT');

/**
 * `POST /valuate/collateral/external`-ийн хариуны DTO гэрээнд тусдаа тодорхойлогдоогүй (docs/05 §4) тул хоёр боломжит хэлбэрийг хүлээж авна:
 * `{ valuation, suggestion? }` эсвэл шууд `CollateralValuationRecord`.
 */
const ExternalValuationResponse = z.union([z.object({ valuation: CollateralValuationRecord }).passthrough(), CollateralValuationRecord]);

const VEHICLE_NOT_FOUND = 'Энэ улсын дугаартай тээврийн хэрэгсэл бүртгэлд олдсонгүй. Дугаараа шалгаад дахин оролдоно уу';

export class HttpValuationPort implements ValuationPort {
  constructor(private readonly http: InternalHttpClient = createInternalHttp(), private readonly externalTimeoutMs: number = EXTERNAL_TIMEOUT_MS, private readonly internalTimeoutMs: number = INTERNAL_TIMEOUT_MS) {}

  async lookupVehicle(ctx: RequestContext, plateNo: string): Promise<VehicleLookupResponse> {
    try {
      return await callUpstream('valuation', () => this.http.post('valuation', '/api/valuate/vehicle-lookup', { plateNo }, { ctx, timeoutMs: this.externalTimeoutMs, schema: VehicleLookupResponse }));
    } catch (e) {
      throw remapNotFound(e, ['VEHICLE_NOT_FOUND'], 'REGISTRY_RECORD_NOT_FOUND', VEHICLE_NOT_FOUND);
    }
  }

  suggest(ctx: RequestContext, req: SuggestValuationRequest): Promise<SuggestValuationResponse> {
    return callUpstream('valuation', () => this.http.post('valuation', '/api/valuate/collateral/suggest', req, { ctx, timeoutMs: this.externalTimeoutMs, schema: SuggestValuationResponse }));
  }

  save(ctx: RequestContext, req: SaveCollateralValuationRequest): Promise<SaveCollateralValuationResponse> {
    return callUpstream('valuation', () => this.http.post('valuation', '/api/valuate/collateral', req, { ctx, timeoutMs: this.externalTimeoutMs, schema: SaveCollateralValuationResponse }));
  }

  async recordExternal(ctx: RequestContext, req: RecordExternalValuationRequest): Promise<CollateralValuationRecord> {
    const res = await callUpstream('valuation', () => this.http.post('valuation', '/api/valuate/collateral/external', req, { ctx, timeoutMs: this.externalTimeoutMs, schema: ExternalValuationResponse }));
    return 'valuation' in res ? res.valuation : res;
  }

  history(ctx: RequestContext, collateralId: string): Promise<ValuationHistoryResponse> {
    return callUpstream('valuation', () => this.http.get('valuation', `/api/valuate/collateral/${encodeURIComponent(collateralId)}/history`, { ctx, timeoutMs: this.internalTimeoutMs, schema: ValuationHistoryResponse }));
  }
}

export const createValuationPort = (): ValuationPort => new HttpValuationPort();
