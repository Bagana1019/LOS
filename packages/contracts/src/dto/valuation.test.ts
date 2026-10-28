import { describe, it, expect } from 'vitest';
import { AutoValuationRequest, PlateNo, VehicleInfo, VehicleLookupRequest, VehicleSummary, normalizePlateNo } from './valuation';

describe('normalizePlateNo', () => {
  it('upper-cases and strips spaces, dashes and dots', () => {
    expect(normalizePlateNo(' 1234-уба ')).toBe('1234УБА');
    expect(normalizePlateNo('уен 5246')).toBe('УЕН5246');
    expect(normalizePlateNo('өүө.1234')).toBe('ӨҮӨ1234');
  });
});

describe('PlateNo', () => {
  it.each(['УЕН5246', '1234УБА', '1234 уба', '5246-ун', 'ӨҮА0001'])('accepts %s', (raw) => {
    expect(PlateNo.safeParse(raw).success).toBe(true);
  });

  it('returns the normalised plate', () => {
    expect(PlateNo.parse('уен 5246')).toBe('УЕН5246');
  });

  it.each(['', 'УЕН524', 'УЕН52460', 'UEN5246', 'YEH5246', '12345УБА', 'У5246', 'УБАД12345', 'УЕН-УЕН'])('rejects %s', (raw) => {
    expect(PlateNo.safeParse(raw).success).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(PlateNo.safeParse(5246).success).toBe(false);
  });
});

describe('request schemas', () => {
  it('VehicleLookupRequest normalises the plate', () => {
    expect(VehicleLookupRequest.parse({ plateNo: 'уен 5246' })).toEqual({ plateNo: 'УЕН5246' });
  });

  it('AutoValuationRequest accepts an optional mileage', () => {
    expect(AutoValuationRequest.parse({ assetType: 'VEHICLE', plateNo: '1234УБА', mileageKm: 85_000 })).toEqual({
      assetType: 'VEHICLE',
      plateNo: '1234УБА',
      mileageKm: 85_000,
    });
    expect(AutoValuationRequest.safeParse({ assetType: 'VEHICLE', plateNo: '1234УБА' }).success).toBe(true);
    expect(AutoValuationRequest.safeParse({ assetType: 'VEHICLE', plateNo: '1234УБА', mileageKm: null }).success).toBe(true);
  });

  it.each([{ mileageKm: 0 }, { mileageKm: -1 }, { mileageKm: 1.5 }, { mileageKm: 3_000_000 }, { assetType: 'APARTMENT' }])('AutoValuationRequest rejects %o', (patch) => {
    expect(AutoValuationRequest.safeParse({ assetType: 'VEHICLE', plateNo: '1234УБА', ...patch }).success).toBe(false);
  });
});

describe('VehicleSummary', () => {
  const vehicle = {
    plateNo: 'УЕН5246', vin: null, make: 'Toyota', model: 'Prius', manufactureYear: 2012, importYear: null, engineCc: null, fuelType: null,
    color: null, registeredAt: null, owner: { registerNo: 'УЕ90010112', name: 'Жишээ' },
  };

  it('drops the owner so a valuation result can be stored without personal data', () => {
    expect(VehicleInfo.parse(vehicle).owner).toEqual(vehicle.owner);
    expect(VehicleSummary.parse(vehicle)).not.toHaveProperty('owner');
  });
});
