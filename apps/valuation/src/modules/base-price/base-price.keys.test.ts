import { describe, expect, it } from 'vitest';
import { canonicalKey, keyMatchesAssetType, livestockKeys, realtyKeys, stableKey, vehicleKeys } from './base-price.keys';

// FR-14.5 — one key, one canonical form: stored keys and lookup keys must agree.

describe('canonicalKey', () => {
  it('trims and collapses blanks in vehicle keys', () => {
    expect(canonicalKey({ make: '  Toyota ', model: 'Land   Cruiser  Prado', year: 2015 })).toEqual({ make: 'Toyota', model: 'Land Cruiser Prado', year: 2015 });
  });

  it('keeps the case: "toyota" is another key than "Toyota"', () => {
    expect(canonicalKey({ make: 'toyota', model: 'Prius', year: 2012 })).not.toEqual(canonicalKey({ make: 'Toyota', model: 'Prius', year: 2012 }));
  });

  it('district keys: drops the registry\'s "дүүрэг" suffix (any case), keeps the khoroo only when there is one', () => {
    expect(canonicalKey({ district: 'Баянзүрх дүүрэг' })).toEqual({ district: 'Баянзүрх' });
    expect(canonicalKey({ district: ' БАЯНЗҮРХ  ДҮҮРЭГ ' })).toEqual({ district: 'БАЯНЗҮРХ' });
    expect(canonicalKey({ district: 'Баянзүрх', khoroo: ' 5-р   хороо ' })).toEqual({ district: 'Баянзүрх', khoroo: '5-р хороо' });
    expect(canonicalKey({ district: 'Баянзүрх', khoroo: '   ' })).toEqual({ district: 'Баянзүрх' });
  });

  it('a name that merely contains the word keeps it', () => {
    expect(canonicalKey({ district: 'дүүрэг' })).toEqual({ district: 'дүүрэг' });
  });

  it('livestock keys are the type and the age group', () => {
    expect(canonicalKey({ livestockType: 'HORSE', ageGroup: 'YOUNG' })).toEqual({ livestockType: 'HORSE', ageGroup: 'YOUNG' });
  });
});

describe('keyMatchesAssetType', () => {
  const vehicle = { make: 'Toyota', model: 'Prius', year: 2012 };
  const district = { district: 'Баянзүрх' };
  const livestock = { livestockType: 'HORSE', ageGroup: 'ADULT' } as const;
  it.each([
    ['VEHICLE', vehicle, true],
    ['VEHICLE', district, false],
    ['VEHICLE', livestock, false],
    ['APARTMENT', district, true],
    ['HOUSE', district, true],
    ['LAND', district, true],
    ['APARTMENT', vehicle, false],
    ['LAND', livestock, false],
    ['LIVESTOCK', livestock, true],
    ['LIVESTOCK', district, false],
  ] as const)('%s with %j → %s', (assetType, key, expected) => {
    expect(keyMatchesAssetType(assetType, key)).toBe(expected);
  });
});

describe('stableKey', () => {
  it('does not depend on property order, nested or not', () => {
    expect(stableKey({ b: 1, a: { d: 2, c: 3 } })).toBe(stableKey({ a: { c: 3, d: 2 }, b: 1 }));
    expect(stableKey({ a: 1 })).not.toBe(stableKey({ a: 2 }));
  });
  it('handles scalars and arrays', () => {
    expect(stableKey(5)).toBe('5');
    expect(stableKey(null)).toBe('null');
    expect(stableKey([1, 2])).toBe('[1,2]');
  });
});

describe('lookup keys', () => {
  it('real estate: the khoroo price is tried before the district price', () => {
    expect(realtyKeys('Баянзүрх', '5-р хороо')).toEqual([{ district: 'Баянзүрх', khoroo: '5-р хороо' }, { district: 'Баянзүрх' }]);
    expect(realtyKeys('Баянзүрх')).toEqual([{ district: 'Баянзүрх' }]);
    expect(realtyKeys('Баянзүрх дүүрэг', ' ')).toEqual([{ district: 'Баянзүрх' }]);
  });
  it('vehicles and livestock have a single key', () => {
    expect(vehicleKeys({ make: ' Toyota', model: 'Prius ', year: 2012 })).toEqual([{ make: 'Toyota', model: 'Prius', year: 2012 }]);
    expect(livestockKeys({ livestockType: 'SHEEP', ageGroup: 'ADULT' })).toEqual([{ livestockType: 'SHEEP', ageGroup: 'ADULT' }]);
  });
});
