import { IntegrationError } from '../integration.types';
import type { VehicleListing, VehicleListingSource } from './vehicle-listing-source.port';

// STUB — no real unegui.mn connection exists yet (FR-14.2).
// Needed before implementing: a data agreement / partner feed or a documented API from the site.
// Scraping its pages is a legal and terms-of-use decision for the business owner, not an engineering default.
// When implemented: keep the request rate low, cache results, and honour ctx.signal.
export class RealUneguiVehicleListingSource implements VehicleListingSource {
  readonly id = 'UNEGUI';

  search(): Promise<VehicleListing[]> {
    return Promise.reject(
      new IntegrationError('UNEGUI', 'NOT_IMPLEMENTED', 'The real unegui.mn listing source is not implemented yet; set INTEGRATION_MODE=mock'),
    );
  }
}
