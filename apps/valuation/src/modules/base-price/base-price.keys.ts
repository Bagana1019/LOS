import type { BasePriceAssetType, BasePriceKey } from '@los/contracts';

// FR-14.1, FR-14.5 — base_price.key_json canonical form. Stored keys and lookup keys go through the same function, so
// "  Toyota " and "Toyota" are one key. jsonb equality does not depend on property order, so no ordering is needed for queries;
// `stableKey` gives a deterministic string for grouping rows in memory and for advisory-lock names.
// Matching is case-sensitive on purpose (the registry and the address pickers return stable spellings); a wrong spelling ends in
// NO_BASE_PRICE (the officer enters the value by hand), never in a wrong price.

export type CanonicalKey = Record<string, string | number>;

const collapse = (s: string): string => s.trim().replace(/\s+/g, ' ');
// The registry may answer "Баянзүрх дүүрэг" where the price list says "Баянзүрх".
const DISTRICT_SUFFIX = /\s+дүүрэг$/iu;
const canonicalDistrict = (s: string): string => collapse(s).replace(DISTRICT_SUFFIX, '');

export function canonicalKey(key: BasePriceKey): CanonicalKey {
  if ('make' in key) return { make: collapse(key.make), model: collapse(key.model), year: key.year };
  if ('livestockType' in key) return { livestockType: key.livestockType, ageGroup: key.ageGroup };
  const district = canonicalDistrict(key.district);
  const khoroo = key.khoroo === undefined ? '' : collapse(key.khoroo);
  return khoroo ? { district, khoroo } : { district };
}

/** The key shape must belong to the asset type: VEHICLE → make/model/year, LIVESTOCK → type/age, APARTMENT/HOUSE/LAND → district[/khoroo]. */
export function keyMatchesAssetType(assetType: BasePriceAssetType, key: BasePriceKey): boolean {
  if (assetType === 'VEHICLE') return 'make' in key;
  if (assetType === 'LIVESTOCK') return 'livestockType' in key;
  return 'district' in key;
}

/** Deterministic JSON (sorted property names) of a stored or canonical key. */
export function stableKey(key: unknown): string {
  if (key === null || typeof key !== 'object' || Array.isArray(key)) return JSON.stringify(key);
  const o = key as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableKey(o[k])}`)
    .join(',')}}`;
}

// ── Lookup keys used by the suggestion (most specific first) ──
export const vehicleKeys = (v: { make: string; model: string; year: number }): CanonicalKey[] => [canonicalKey({ make: v.make, model: v.model, year: v.year })];
/** Khoroo-level price first, then the district price. */
export const realtyKeys = (district: string, khoroo?: string): CanonicalKey[] => {
  const withKhoroo = canonicalKey({ district, khoroo });
  const districtOnly = canonicalKey({ district });
  return 'khoroo' in withKhoroo ? [withKhoroo, districtOnly] : [districtOnly];
};
export const livestockKeys = (v: { livestockType: 'HORSE' | 'CATTLE' | 'SHEEP' | 'GOAT' | 'CAMEL'; ageGroup: 'ADULT' | 'YOUNG' }): CanonicalKey[] => [canonicalKey(v)];
