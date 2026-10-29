import type { EncumbranceCheckView, OwnershipCheck } from '@los/contracts';
import type { GateCollateralInput, GateInput, GateProduct } from '../collateral-gate';

/** Тогтмол "одоо" — тестэд цаг хөдөлдөггүй. */
export const NOW = new Date('2026-10-29T03:00:00.000Z');
export const DAY = 86_400_000;
export const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

export const ownership = (over: Partial<OwnershipCheck> = {}): OwnershipCheck => ({
  status: 'VERIFIED', method: 'REGISTRY', source: 'ATUT', checkedAt: NOW.toISOString(), owners: [{ registerMasked: 'УБ****0001', name: 'Бат', matchedCustomerId: 'cust-1', role: 'PRIMARY' }], message: null, note: null, ...over,
});

export const encumbrance = (over: Partial<EncumbranceCheckView> = {}): EncumbranceCheckView => ({ status: 'CLEAR', method: 'REGISTRY', checkedAt: NOW.toISOString(), sources: [], note: null, ...over });

/** Бүх шалгуурыг хангасан автомашин (market 30,000,000 × 0.7 = 21,000,000). */
export function collateral(over: Partial<GateCollateralInput> = {}): GateCollateralInput {
  return {
    id: 'col-1', assetType: 'VEHICLE', ownerCustomerId: 'cust-1', ownerRole: 'PRIMARY', ownership: ownership(), encumbrance: encumbrance(),
    marketValue: 30_000_000, collateralValue: 21_000_000, valuationId: 'val-1', valuationSource: 'INTERNAL', valuedAt: new Date(NOW.getTime() - DAY), valuationValidUntil: new Date(NOW.getTime() + 60 * DAY),
    externalValuationRequired: false, documentKeys: ['vehicle_certificate', 'traffic_registry_extract', 'insurance'], releasedAt: null, ...over,
  };
}

export const product = (over: Partial<GateProduct> = {}): GateProduct => ({
  requiresCollateral: true, maxLtv: 0.7, externalValuationThreshold: 100_000_000,
  collateralChecklist: { VEHICLE: ['vehicle_certificate', 'traffic_registry_extract', 'insurance'], APARTMENT: ['ownership_certificate', 'cadastral_plan', 'registry_extract'] }, ...over,
});

export function gateInput(over: Partial<GateInput> = {}): GateInput {
  return { now: NOW, product: product(), loanAmount: 10_000_000, collaterals: [collateral()], settings: { staleDays: 30, ltvMax: 0.7 }, ...over };
}
