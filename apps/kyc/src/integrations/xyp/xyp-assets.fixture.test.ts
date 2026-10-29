import { COLLATERAL_DESCRIPTION_SCHEMAS, XypAssetsResponse, XypPropertyAsset, customerTypeOfRegister, type XypVehicleAsset } from '@los/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntegrationNotImplementedError } from '../errors';
import { MockXypClient } from './mock-xyp.client';
import { RealXypClient } from './real-xyp.client';
import { XypUnavailableError } from './xyp.client';
import { createXypClient } from './xyp.module';
import { XYP_CO_OWNED_PROPERTY_NO, XYP_MOCK_VEHICLES, xypAssetsFixture, xypCoOwnerRegister, xypPropertyNos } from './xyp-assets.fixture';

type Property = XypPropertyAsset;
const xyp = new MockXypClient();

/** Зохиомол регистрүүд (тест): иргэн (`УБ…`) ба байгууллага (7 орон); "олдохгүй"/"унасан" тусгай цифрүүд орохгүй. */
const individuals = (n: number) => Array.from({ length: n }, (_, i) => `${['УБ', 'ЧЛ', 'ДА', 'ЭР', 'ХА'][i % 5]}${String(10_000_000 + i * 7_919).padStart(8, '0')}`);
const legalEntities = (n: number) => Array.from({ length: n }, (_, i) => String(1_000_000 + i * 997));

/** Origination-ий барьцааны тодорхойлолт руу хөрвүүлэхэд (FR-6.3) схемээр зөвшөөрөгдөх эсэх. */
const toDescription = (p: Property) => ({
  propertyId: p.propertyId,
  certificateNo: p.certificateNo ?? undefined,
  address: p.address,
  areaM2: p.areaM2,
  floor: p.floor ?? undefined,
  totalFloors: p.totalFloors ?? undefined,
  rooms: p.rooms ?? undefined,
  buildYear: p.buildYear ?? undefined,
  purpose: p.purpose ?? undefined,
  landUse: p.landUse ?? undefined,
});

describe('xyp assets fixture · determinism', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('answers the same for the same register every time, whatever the clock says, without Math.random', async () => {
    const random = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('Math.random must not be used'); });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-03T00:00:00Z'));
    const a = await xyp.getAssets('ЖИ00000002');
    vi.setSystemTime(new Date('2031-09-09T09:09:09Z'));
    const b = await xyp.getAssets('ЖИ00000002');
    expect(a).toEqual(b);
    expect(await xyp.getProperty('MOCK-ЖИ00000002-9')).toEqual(await xyp.getProperty('MOCK-ЖИ00000002-9'));
    expect(random).not.toHaveBeenCalled();
  });

  it('uses the constant fetchedAt of the other XYP fixtures (no wall-clock stamp)', async () => {
    expect((await xyp.getAssets('УБ90010112'))!.fetchedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('does not let a caller corrupt the fixture', async () => {
    const a = (await xyp.getAssets('ЖИ00000002'))!;
    a.properties[0]!.address.detail = 'Hacked';
    a.properties[0]!.owners[0]!.name = 'Hacked';
    a.properties.pop();
    a.vehicles[0]!.plateNo = 'ХАК0000';
    const again = (await xyp.getAssets('ЖИ00000002'))!;
    expect(again.properties).toHaveLength(2);
    expect(JSON.stringify(again)).not.toContain('Hacked');
    expect(again.vehicles[0]!.plateNo).toBe('5678УНА');
  });
});

describe('xyp assets fixture · properties', () => {
  const sample = individuals(400);

  it('every individual gets 1-2 properties; each response and property is a valid contract object and a valid collateral description', () => {
    for (const reg of sample) {
      const res = xypAssetsFixture(reg)!;
      expect(() => XypAssetsResponse.parse(res), reg).not.toThrow();
      expect(res.properties.length).toBeGreaterThanOrEqual(1);
      expect(res.properties.length).toBeLessThanOrEqual(2);
      for (const p of res.properties) {
        expect(() => COLLATERAL_DESCRIPTION_SCHEMAS[p.assetType].parse(toDescription(p)), p.propertyId).not.toThrow();
        expect(p.certificateNo).toMatch(/^DEMO-CERT-\d{6}$/); // зохиомол: бодит гэрчилгээний дугаарын хэлбэр биш
      }
    }
  });

  it('property ids use the DEMO format MOCK-<REGISTER>-<n>, are unique, and the first owner is always the queried register', () => {
    for (const reg of sample.slice(0, 120)) {
      const res = xypAssetsFixture(reg)!;
      const ids = res.properties.map((p) => p.propertyId);
      expect(new Set(ids).size).toBe(ids.length);
      for (const p of res.properties) {
        expect(p.propertyId).toMatch(new RegExp(`^MOCK-${reg}-[1-9]$`));
        expect(p.owners[0]!.registerNo).toBe(reg);
      }
    }
  });

  it('getProperty inverts the id to the same property (with its owners) that getAssets listed', async () => {
    for (const reg of [...sample.slice(0, 150), ...legalEntities(40), 'ЖИ00000002', '0000001']) {
      for (const p of xypAssetsFixture(reg)!.properties) {
        expect(await xyp.getProperty(p.propertyId), p.propertyId).toEqual(p);
        expect(XypPropertyAsset.parse(await xyp.getProperty(p.propertyId))).toBeTruthy();
      }
    }
  });

  it('is varied: all three realty kinds appear across individuals, and a second property is sometimes the co-owned one', () => {
    const kinds = new Set<string>();
    const sets = new Set<string>();
    for (const reg of sample) {
      sets.add(xypPropertyNos(reg, 'INDIVIDUAL').join(','));
      for (const p of xypAssetsFixture(reg)!.properties) kinds.add(p.assetType);
    }
    expect([...kinds].sort()).toEqual(['APARTMENT', 'HOUSE', 'LAND']);
    expect([...sets].sort()).toEqual(['1', '1,2', '1,9']);
  });

  it(`n=${XYP_CO_OWNED_PROPERTY_NO} has exactly two 50% owners: the register and a derived, valid individual register with a name (OWNER_NOT_ON_APPLICATION demo)`, () => {
    const withNine = sample.filter((r) => xypPropertyNos(r, 'INDIVIDUAL').includes(XYP_CO_OWNED_PROPERTY_NO));
    expect(withNine.length).toBeGreaterThan(30);
    for (const reg of withNine) {
      const p = xypAssetsFixture(reg)!.properties.find((x) => x.propertyId === `MOCK-${reg}-9`)!;
      expect(p.owners).toHaveLength(2);
      const [first, co] = p.owners as [Property['owners'][number], Property['owners'][number]];
      expect(first).toMatchObject({ registerNo: reg, sharePercent: 50 });
      expect(co.registerNo).toBe(xypCoOwnerRegister(reg));
      expect(co.registerNo).not.toBe(reg);
      expect(customerTypeOfRegister(co.registerNo)).toBe('INDIVIDUAL');
      expect(co.registerNo.slice(2)).not.toMatch(/^(0{8}|9{8})$/); // ХУР-ын "олдохгүй/унасан" тусгай регистртэй давхцахгүй
      expect(co.name.trim().length).toBeGreaterThan(3);
      expect(co.name).not.toBe(first.name);
      expect(co.sharePercent).toBe(50);
    }
  });

  it('every other property has exactly one owner with 100%', () => {
    for (const reg of sample) {
      for (const p of xypAssetsFixture(reg)!.properties) {
        if (p.propertyId.endsWith(`-${XYP_CO_OWNED_PROPERTY_NO}`)) continue;
        expect(p.owners).toHaveLength(1);
        expect(p.owners[0]!.sharePercent).toBe(100);
      }
    }
  });

  it('a legal entity gets exactly one commercial property and no co-owner', () => {
    for (const reg of legalEntities(60)) {
      const res = xypAssetsFixture(reg)!;
      expect(res.properties).toHaveLength(1);
      const p = res.properties[0]!;
      expect(p.propertyId).toBe(`MOCK-${reg}-1`);
      expect(p.owners).toHaveLength(1);
      expect(p.owners[0]).toMatchObject({ registerNo: reg, sharePercent: 100 });
      expect(p.owners[0]!.name).toMatch(/ХХК$/);
      expect([p.purpose, p.landUse]).toContain('COMMERCIAL');
      expect(() => XypAssetsResponse.parse(res)).not.toThrow();
    }
  });

  it('owner names equal the ХУР citizen fixture of the same register (consistent within the mock ХУР)', async () => {
    const citizen = (await xyp.getCitizen('УБ90010112'))!;
    expect((await xyp.getAssets('УБ90010112'))!.properties[0]!.owners[0]!.name).toBe(`${citizen.lastName} ${citizen.firstName}`);
  });

  it('pins the documented demo registers (README table)', async () => {
    const ids = async (reg: string) => (await xyp.getAssets(reg))!.properties.map((p) => p.propertyId);
    expect(await ids('УБ90010112')).toEqual(['MOCK-УБ90010112-1']);
    expect(await ids('УБ00000001')).toEqual(['MOCK-УБ00000001-1', 'MOCK-УБ00000001-2']);
    expect(await ids('ЖИ00000002')).toEqual(['MOCK-ЖИ00000002-1', 'MOCK-ЖИ00000002-9']);
    expect((await xyp.getAssets('УБ00000001'))!.properties[1]).toMatchObject({ assetType: 'LAND', landUse: expect.any(String), owners: [{ registerNo: 'УБ00000001', sharePercent: 100 }] });
    expect((await xyp.getProperty('MOCK-ЖИ00000002-9'))!.owners.map((o) => o.registerNo)).toEqual(['ЖИ00000002', xypCoOwnerRegister('ЖИ00000002')]);
    expect(await ids('5012345')).toEqual(['MOCK-5012345-1']);
  });
});

describe('xyp assets fixture · getProperty lookups', () => {
  it('tolerates case and surrounding spaces of the id and returns the canonical id', async () => {
    const p = (await xyp.getProperty('  mock-жи00000002-9 '))!;
    expect(p.propertyId).toBe('MOCK-ЖИ00000002-9');
  });

  it('is null for ids that are not in the DEMO format or not listed for the register', async () => {
    for (const id of ['', 'XYZ-1', 'MOCK', 'MOCK-УБ90010112', 'MOCK-УБ90010112-', 'MOCK-УБ90010112-0', 'MOCK-УБ90010112-01', 'MOCK-УБ90010112-2', 'MOCK-УБ90010112-7', 'MOCK-УБ90010112-100', 'MOCK-ABC-1', 'MOCK--1', 'MOCK-УБ90010112-1-1', 'Ү-2201001234']) {
      expect(await xyp.getProperty(id), id).toBeNull();
    }
    expect(await xyp.getProperty('MOCK-0000001-2')).toBeNull(); // legal entity: only n=1
  });

  it('is null when the owner register does not exist in ХУР (all zeros) and throws when ХУР is down (nines)', async () => {
    expect(await xyp.getProperty('MOCK-УБ00000000-1')).toBeNull();
    expect(await xyp.getProperty('MOCK-0000000-1')).toBeNull();
    await expect(xyp.getProperty('MOCK-УБ99999999-1')).rejects.toBeInstanceOf(XypUnavailableError);
    await expect(xyp.getProperty('MOCK-9999999-1')).rejects.toBeInstanceOf(XypUnavailableError);
  });
});

describe('xyp assets fixture · register conventions (same as getCitizen)', () => {
  it('not found for all-zero and malformed registers, unavailable for all-nine registers', async () => {
    expect(await xyp.getAssets('УБ00000000')).toBeNull();
    expect(await xyp.getAssets('0000000')).toBeNull();
    expect(await xyp.getAssets('garbage')).toBeNull();
    expect(await xyp.getAssets('')).toBeNull();
    await expect(xyp.getAssets('УБ99999999')).rejects.toBeInstanceOf(XypUnavailableError);
    await expect(xyp.getAssets('9999999')).rejects.toBeInstanceOf(XypUnavailableError);
  });

  it('a register that exists but owns no vehicle has an empty vehicles list', async () => {
    expect((await xyp.getAssets('УБ90010112'))!.vehicles).toEqual([]);
  });
});

// DEMO: valuation-ий mock АТҮТ (apps/valuation/src/integrations/vehicle-registry/mock-vehicles.ts)-тэй ТАЛБАР БҮРЭЭРЭЭ ижил байх ёстой.
// Энэ нь хуулбар тул valuation талд өөрчлөлт орвол энд, fixture-д хоёуланд нь шинэчилнэ (`test/xyp-vehicles-sync.test.ts` нь valuation-ий файлтай шууд тулгана).
const MIRRORED: ReadonlyArray<{ ownerRegisterNo: string; vehicle: XypVehicleAsset }> = [
  { ownerRegisterNo: 'УЕ00000001', vehicle: { plateNo: 'УЕН5246', vin: 'MOCKVIN0000000001', make: 'Toyota', model: 'Prius', manufactureYear: 2012, importYear: 2016, engineCc: 1798, fuelType: 'HYBRID', color: 'Цагаан' } },
  { ownerRegisterNo: '0000001', vehicle: { plateNo: '1234УБА', vin: 'MOCKVIN0000000002', make: 'Toyota', model: 'Land Cruiser Prado', manufactureYear: 2015, importYear: 2018, engineCc: 2755, fuelType: 'DIESEL', color: 'Хар' } },
  { ownerRegisterNo: 'ЖИ00000002', vehicle: { plateNo: '5678УНА', vin: 'MOCKVIN0000000003', make: 'Hyundai', model: 'Sonata', manufactureYear: 2017, importYear: 2019, engineCc: 1999, fuelType: 'LPG', color: 'Мөнгөлөг' } },
  { ownerRegisterNo: 'ТЭ00000003', vehicle: { plateNo: '7001УБЭ', vin: 'MOCKVIN0000000004', make: 'Lexus', model: 'LX 570', manufactureYear: 2018, importYear: 2020, engineCc: 5663, fuelType: 'PETROL', color: 'Хар' } },
  { ownerRegisterNo: '0000002', vehicle: { plateNo: '3030БАА', vin: 'MOCKVIN0000000005', make: 'Daewoo', model: 'Damas', manufactureYear: 2005, importYear: null, engineCc: 796, fuelType: 'PETROL', color: null } },
];

describe('xyp assets fixture · vehicles mirror the valuation mock АТҮТ registry', () => {
  it('pins the mirrored plates, owner registers and vehicle fields', () => {
    expect(XYP_MOCK_VEHICLES).toEqual(MIRRORED);
  });

  it('getAssets returns exactly the mirrored vehicle for each owner register', async () => {
    for (const { ownerRegisterNo, vehicle } of MIRRORED) {
      expect((await xyp.getAssets(ownerRegisterNo))!.vehicles, ownerRegisterNo).toEqual([vehicle]);
    }
  });

  it('the vehicle owners are also customers with their own properties (every register gets properties)', async () => {
    for (const { ownerRegisterNo } of MIRRORED) {
      const res = (await xyp.getAssets(ownerRegisterNo))!;
      expect(res.properties.length, ownerRegisterNo).toBeGreaterThanOrEqual(1);
      expect(() => XypAssetsResponse.parse(res)).not.toThrow();
    }
  });

  it('no other register owns a vehicle', async () => {
    for (const reg of [...individuals(200), ...legalEntities(50)]) {
      expect((await xyp.getAssets(reg))!.vehicles, reg).toEqual([]);
    }
  });
});

describe('real mode and mode selection', () => {
  it('RealXypClient fails closed for assets and property (no guessed endpoint)', async () => {
    const real = new RealXypClient();
    await expect(real.getAssets('УБ90010112')).rejects.toBeInstanceOf(IntegrationNotImplementedError);
    await expect(real.getProperty('MOCK-УБ90010112-1')).rejects.toBeInstanceOf(IntegrationNotImplementedError);
  });

  it('INTEGRATION_MODE picks mock by default and real when asked', async () => {
    expect(createXypClient({})).toBeInstanceOf(MockXypClient);
    const real = createXypClient({ INTEGRATION_MODE: 'real' });
    await expect(real.getAssets('УБ90010112')).rejects.toBeInstanceOf(IntegrationNotImplementedError);
    await expect(real.getProperty('MOCK-УБ90010112-1')).rejects.toBeInstanceOf(IntegrationNotImplementedError);
  });
});
