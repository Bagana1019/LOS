import type { VehicleInfo } from '@los/contracts';
import type { IntegrationContext } from '../integration.types';

/** Vehicle registry (АТҮТ — Автотээврийн үндэсний төв). Lookup by normalised plate number. */
export interface VehicleRegistry {
  /** Resolves `null` when the plate is not registered; throws `IntegrationError` when the registry cannot answer. */
  lookup(plateNo: string, ctx: IntegrationContext): Promise<VehicleInfo | null>;
}

export const VEHICLE_REGISTRY = Symbol('VEHICLE_REGISTRY');
