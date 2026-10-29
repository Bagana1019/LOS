import { describe, it, expect } from 'vitest';
import { PLATE_NO_PATTERN, VehicleInfo } from '@los/contracts';
import type { IntegrationContext } from '../integration.types';
import { MockVehicleRegistry } from './mock-vehicle-registry';
import { MOCK_VEHICLES } from './mock-vehicles';

const ctx = (): IntegrationContext => ({
  correlationId: 'test',
  now: new Date('2026-10-28T09:00:00.000Z'),
  signal: new AbortController().signal,
});
const registry = new MockVehicleRegistry();

describe('MockVehicleRegistry fixtures', () => {
  it('УЕН5246 is a white hybrid Toyota Prius owned by a fictional individual', async () => {
    expect(await registry.lookup('УЕН5246', ctx())).toEqual({
      plateNo: 'УЕН5246',
      vin: 'MOCKVIN0000000001',
      make: 'Toyota',
      model: 'Prius',
      manufactureYear: 2012,
      importYear: 2016,
      engineCc: 1798,
      fuelType: 'HYBRID',
      color: 'Цагаан',
      owner: { registerNo: 'УЕ00000001', name: 'Жишээ Бат-Эрдэнэ' },
      registeredAt: '2016-05-20',
    });
  });

  it('1234УБА is a diesel Land Cruiser Prado owned by a fictional company', async () => {
    const v = await registry.lookup('1234УБА', ctx());
    expect(v).toMatchObject({
      make: 'Toyota',
      model: 'Land Cruiser Prado',
      manufactureYear: 2015,
      importYear: 2018,
      engineCc: 2755,
      fuelType: 'DIESEL',
    });
    expect(v?.owner).toEqual({ registerNo: '0000001', name: 'Хөгжил Трейд ХХК' });
  });

  it('5678УНА is an LPG Hyundai Sonata', async () => {
    expect(await registry.lookup('5678УНА', ctx())).toMatchObject({
      make: 'Hyundai',
      model: 'Sonata',
      manufactureYear: 2017,
      importYear: 2019,
      engineCc: 1999,
      fuelType: 'LPG',
    });
  });

  it('7001УБЭ is a Lexus LX 570 and 3030БАА a Daewoo Damas', async () => {
    expect(await registry.lookup('7001УБЭ', ctx())).toMatchObject({
      make: 'Lexus',
      model: 'LX 570',
      manufactureYear: 2018,
      engineCc: 5663,
      fuelType: 'PETROL',
    });
    expect(await registry.lookup('3030БАА', ctx())).toMatchObject({
      make: 'Daewoo',
      model: 'Damas',
      manufactureYear: 2005,
      engineCc: 796,
      fuelType: 'PETROL',
    });
  });

  it('returns null for an unregistered plate', async () => {
    expect(await registry.lookup('9999ААА', ctx())).toBeNull();
    expect(await registry.lookup('УЕН5247', ctx())).toBeNull();
    expect(await registry.lookup('', ctx())).toBeNull();
  });

  it('resolves digits-first and letters-first spellings to the same vehicle, echoing the plate that was asked for', async () => {
    const letterFirst = await registry.lookup('УЕН5246', ctx());
    const digitFirst = await registry.lookup('5246УЕН', ctx());
    expect(digitFirst).toEqual({ ...letterFirst, plateNo: '5246УЕН' });
    expect((await registry.lookup('УБА1234', ctx()))?.plateNo).toBe('УБА1234');
  });

  it('ignores case, spaces and dashes in the asked plate', async () => {
    expect((await registry.lookup('1234 уба', ctx()))?.plateNo).toBe('1234УБА');
    expect((await registry.lookup('УЕН-5246', ctx()))?.model).toBe('Prius');
  });

  it('is deterministic and hands out copies, so a caller cannot corrupt the fixtures', async () => {
    const first = await registry.lookup('УЕН5246', ctx());
    const second = await registry.lookup('УЕН5246', ctx());
    expect(second).toEqual(first);
    first!.make = 'Tampered';
    first!.owner.name = 'Tampered';
    expect(await registry.lookup('УЕН5246', ctx())).toMatchObject({ make: 'Toyota', owner: { name: 'Жишээ Бат-Эрдэнэ' } });
  });
});

describe('MOCK_VEHICLES data quality', () => {
  it.each(MOCK_VEHICLES.map((v) => v.plateNo))('%s validates against the VehicleInfo schema', async (plateNo) => {
    const result = await registry.lookup(plateNo, ctx());
    expect(VehicleInfo.safeParse(result).success).toBe(true);
  });

  it('uses valid, unique plates and 17-character unique VINs', () => {
    for (const v of MOCK_VEHICLES) expect(v.plateNo).toMatch(PLATE_NO_PATTERN);
    expect(new Set(MOCK_VEHICLES.map((v) => v.vin)).size).toBe(MOCK_VEHICLES.length);
    for (const v of MOCK_VEHICLES) expect(v.vin).toHaveLength(17);
    for (const v of MOCK_VEHICLES) expect(v.registeredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('uses Mongolian register-number shapes (2 letters + 8 digits, or 7 digits for companies)', () => {
    for (const v of MOCK_VEHICLES) expect(v.owner.registerNo).toMatch(/^(?:[А-ЯЁӨҮ]{2}\d{8}|\d{7})$/);
  });
});
