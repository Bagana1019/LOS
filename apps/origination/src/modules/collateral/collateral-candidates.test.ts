import { describe, expect, it } from 'vitest';
import type { XypAssetsResponse, XypPropertyAsset } from '@los/contracts';
import { toCandidates } from './collateral-candidates';

const property = (over: Partial<XypPropertyAsset> = {}): XypPropertyAsset => ({
  propertyId: 'P-001', certificateNo: 'GER-1', assetType: 'APARTMENT', address: { province: 'Улаанбаатар', district: 'СБД', khoroo: '1-р хороо', detail: null as never }, areaM2: 54.5,
  floor: 4, totalFloors: 9, rooms: 2, buildYear: 2012, purpose: 'RESIDENTIAL', landUse: null, owners: [{ registerNo: 'УЕ00000001', name: 'Бат', sharePercent: 100 }], ...over,
});
const response = (over: Partial<XypAssetsResponse> = {}): XypAssetsResponse => ({ properties: [], vehicles: [], fetchedAt: '2026-10-29T03:00:00.000Z', ...over });

describe('toCandidates (FR-6.3)', () => {
  it('орон сууц: null талбаргүй description, asset key, label', () => {
    const { items, skipped } = toCandidates(response({ properties: [property()] }));
    expect(skipped).toBe(0);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ xypRef: 'P-001', assetType: 'APARTMENT', assetKey: 'REALTY:P001' });
    expect(items[0]!.description).toMatchObject({ propertyId: 'P-001', certificateNo: 'GER-1', areaM2: 54.5, floor: 4, totalFloors: 9, rooms: 2, buildYear: 2012, purpose: 'RESIDENTIAL' });
    expect(items[0]!.description).not.toHaveProperty('landUse');
    expect(items[0]!.label).toBe('Орон сууц · СБД, 1-р хороо · 54.5 м²');
  });

  it('байшин (floors = totalFloors), газар (landUse)', () => {
    const house = toCandidates(response({ properties: [property({ propertyId: 'P-2', assetType: 'HOUSE', totalFloors: 2 })] })).items[0]!;
    expect(house.description).toMatchObject({ floors: 2 });
    expect(house.label.startsWith('Байшин')).toBe(true);
    const land = toCandidates(response({ properties: [property({ propertyId: 'P-3', assetType: 'LAND', landUse: 'COMMERCIAL', floor: null, totalFloors: null })] })).items[0]!;
    expect(land.description).toMatchObject({ landUse: 'COMMERCIAL' });
    expect(land.label.startsWith('Газар')).toBe(true);
  });

  it('автомашин: улсын дугаар, key нормчлогдсон', () => {
    const { items } = toCandidates(response({ vehicles: [{ plateNo: '1234УБА', vin: null, make: 'Toyota', model: 'Prius', manufactureYear: 2015, importYear: 2018, engineCc: 1800, fuelType: 'HYBRID', color: null }] }));
    expect(items[0]).toMatchObject({ xypRef: '1234УБА', assetType: 'VEHICLE', assetKey: 'VEHICLE:1234УБА', label: 'Toyota Prius 2015 · 1234УБА' });
    expect(items[0]!.description).toMatchObject({ plateNo: '1234УБА', make: 'Toyota', model: 'Prius', manufactureYear: 2015, importYear: 2018, engineCc: 1800, fuelType: 'HYBRID' });
    expect(items[0]!.description).not.toHaveProperty('vin');
    expect(items[0]!.description).not.toHaveProperty('color');
  });

  it('барьцаа болгон шууд үүсгэх боломжгүй (схемд нийцэхгүй) хөрөнгийг алгасаж тоолно', () => {
    const bad = property({ propertyId: 'P-BAD', areaM2: 200_000_000, assetType: 'APARTMENT' }); // apartment area max 100,000
    const { items, skipped } = toCandidates(response({ properties: [bad, property()] }));
    expect(skipped).toBe(1);
    expect(items.map((i) => i.xypRef)).toEqual(['P-001']);
  });

  it('хоосон хариу', () => {
    expect(toCandidates(response())).toEqual({ items: [], skipped: 0 });
  });
});
