import { normalizePlateNo, type VehicleInfo } from '@los/contracts';
import type { IntegrationContext } from '../integration.types';
import { MOCK_VEHICLES } from './mock-vehicles';
import type { VehicleRegistry } from './vehicle-registry.port';

/** Letters first, then digits, so УЕН5246 and 5246УЕН are the same vehicle (officers type the plate in either order). */
const plateKey = (plateNo: string): string => {
  const plate = normalizePlateNo(plateNo);
  return plate.replace(/\d/g, '') + plate.replace(/\D/g, '');
};

/** Deterministic stand-in for АТҮТ (FR-14.1, FR-14.2). Fixtures are listed in README.md. */
export class MockVehicleRegistry implements VehicleRegistry {
  private readonly byKey = new Map(MOCK_VEHICLES.map((v) => [plateKey(v.plateNo), v]));

  async lookup(plateNo: string, _ctx: IntegrationContext): Promise<VehicleInfo | null> {
    const fixture = this.byKey.get(plateKey(plateNo));
    if (!fixture) return null;
    // Copy so a caller mutating the result cannot corrupt the shared fixture.
    return { ...fixture, owner: { ...fixture.owner }, plateNo: normalizePlateNo(plateNo) };
  }
}
