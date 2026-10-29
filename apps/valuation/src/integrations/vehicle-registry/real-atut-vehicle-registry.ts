import type { VehicleInfo } from '@los/contracts';
import { IntegrationError } from '../integration.types';
import type { VehicleRegistry } from './vehicle-registry.port';

// STUB — the real АТҮТ (Автотээврийн үндэсний төв) connection does not exist yet (FR-14.1).
// Before implementing, the business owner / integration team must provide:
//   1. an access agreement with АТҮТ and credentials for the environment (test and production),
//   2. the request/response specification (authentication, lookup key, field list, error semantics, rate limits),
//   3. a decision whether access goes directly to АТҮТ or through the ХУР gateway that apps/kyc/src/modules/xyp owns.
//      Settle this first: CLAUDE.md §3.2 forbids service-to-service calls other than origination → {kyc, scoring, valuation, dms}.
// Until then no endpoint, field name or payload shape is assumed here.
export class RealAtutVehicleRegistry implements VehicleRegistry {
  lookup(): Promise<VehicleInfo | null> {
    return Promise.reject(
      new IntegrationError(
        'ATUT',
        'NOT_IMPLEMENTED',
        'The real АТҮТ vehicle registry connection is not implemented yet; set INTEGRATION_MODE=mock',
      ),
    );
  }
}
