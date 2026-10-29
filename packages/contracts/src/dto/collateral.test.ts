import { describe, expect, it } from 'vitest';
import {
  AttachCollateralDocumentRequest,
  COLLATERAL_CHECKLIST_LABELS,
  COLLATERAL_DESCRIPTION_SCHEMAS,
  CreateCollateralRequest,
  ExternalValuationRequest,
  MANUAL_VALUE_ASSET_TYPES,
  ProductCollateralChecklist,
  SaveValuationRequest,
  UpdateCollateralRequest,
  collateralAssetKey,
  collateralChecklistLabel,
  collateralKindOf,
  isManualValueAsset,
  parseCollateralDescription,
} from './collateral';
import { AssetType } from '../enums';

const OWNER = '11111111-1111-4111-8111-111111111111';
const vehicle = { plateNo: '1234 уба', make: 'Toyota', model: 'Prius', manufactureYear: 2012 };
const apartment = { propertyId: 'Ү-2201001234', address: { province: 'Улаанбаатар', district: 'Баянзүрх', khoroo: '5-р хороо' }, areaM2: 54.5, floor: 3, totalFloors: 9 };

describe('collateral description schemas (FR-6.1)', () => {
  it('has a schema for every asset type', () => {
    for (const t of AssetType) expect(COLLATERAL_DESCRIPTION_SCHEMAS[t], t).toBeDefined();
  });
  it('normalises the plate and rejects a Latin plate', () => {
    expect(parseCollateralDescription('VEHICLE', vehicle).plateNo).toBe('1234УБА');
    expect(() => parseCollateralDescription('VEHICLE', { ...vehicle, plateNo: '1234UBA' })).toThrow();
  });
  it('real estate needs a property id or a certificate number', () => {
    expect(() => parseCollateralDescription('APARTMENT', { ...apartment, propertyId: undefined })).toThrow(/дугаар/);
    expect(parseCollateralDescription('APARTMENT', { ...apartment, propertyId: undefined, certificateNo: 'ГЭР-1' }).purpose).toBe('RESIDENTIAL');
    expect(() => parseCollateralDescription('LAND', { address: apartment.address, areaM2: 700 })).toThrow();
  });
  it('livestock defaults to adult animals and needs a positive head count', () => {
    expect(parseCollateralDescription('LIVESTOCK', { livestockType: 'SHEEP', headCount: 100 }).ageGroup).toBe('ADULT');
    expect(() => parseCollateralDescription('LIVESTOCK', { livestockType: 'SHEEP', headCount: 0 })).toThrow();
    expect(() => parseCollateralDescription('LIVESTOCK', { livestockType: 'DOG', headCount: 3 })).toThrow();
  });
  it('inventory carries the stocktake value (FR-14.1)', () => {
    expect(parseCollateralDescription('INVENTORY', { name: 'Хүнсний бараа', stocktakeValue: 25_000_000, stocktakeDate: '2026-10-01' }).stocktakeValue).toBe(25_000_000);
    expect(() => parseCollateralDescription('INVENTORY', { name: 'x', stocktakeValue: -1, stocktakeDate: '2026-10-01' })).toThrow();
  });
});

describe('CreateCollateralRequest', () => {
  it('selects the description schema by asset type', () => {
    expect(CreateCollateralRequest.parse({ assetType: 'VEHICLE', ownerCustomerId: OWNER, description: vehicle }).source).toBe('MANUAL');
    expect(() => CreateCollateralRequest.parse({ assetType: 'VEHICLE', ownerCustomerId: OWNER, description: apartment })).toThrow();
    expect(() => CreateCollateralRequest.parse({ assetType: 'SPACESHIP', ownerCustomerId: OWNER, description: {} })).toThrow();
  });
  it('requires an owner customer id', () => {
    expect(() => CreateCollateralRequest.parse({ assetType: 'VEHICLE', description: vehicle })).toThrow();
  });
});

describe('UpdateCollateralRequest / valuation requests', () => {
  it('rejects an empty patch', () => {
    expect(() => UpdateCollateralRequest.parse({})).toThrow(/Өөрчлөх/);
    expect(UpdateCollateralRequest.parse({ note: null }).note).toBeNull();
  });
  it('SaveValuationRequest: an override needs only positive numbers; the reason is enforced by the service', () => {
    expect(SaveValuationRequest.parse({ marketValue: 30_000_000, overrideReason: 'Засвар хийсэн' }).marketValue).toBe(30_000_000);
    expect(() => SaveValuationRequest.parse({ marketValue: 0 })).toThrow();
  });
  it('ExternalValuationRequest needs the appraiser report file', () => {
    const ok = { appraiser: 'Үнэлгээ ХХК', valuedAt: '2026-10-01', marketValue: 120_000_000, reportFileId: '22222222-2222-4222-8222-222222222222' };
    expect(ExternalValuationRequest.parse(ok).appraiser).toBe('Үнэлгээ ХХК');
    expect(() => ExternalValuationRequest.parse({ ...ok, reportFileId: undefined })).toThrow();
  });
  it('AttachCollateralDocumentRequest', () => {
    expect(AttachCollateralDocumentRequest.parse({ checklistKey: 'insurance', fileId: '22222222-2222-4222-8222-222222222222' }).checklistKey).toBe('insurance');
    expect(() => AttachCollateralDocumentRequest.parse({ checklistKey: 'insurance', fileId: 'nope' })).toThrow();
  });
});

describe('asset key (FR-6.6 double-pledge guard)', () => {
  it('vehicles: the plate in any spelling', () => {
    expect(collateralAssetKey('VEHICLE', { plateNo: '1234УБА' })).toBe('VEHICLE:1234УБА');
    expect(collateralAssetKey('VEHICLE', { plateNo: '1234-уба' })).toBe('VEHICLE:1234УБА');
    expect(collateralAssetKey('VEHICLE', { vin: 'abc 123 45' })).toBe('VEHICLE_VIN:ABC12345');
  });
  it('real estate: apartment, house and land share one namespace, property id wins over the certificate', () => {
    expect(collateralAssetKey('APARTMENT', { propertyId: 'ү-22 01', certificateNo: 'X' })).toBe('REALTY:Ү2201');
    expect(collateralAssetKey('HOUSE', { certificateNo: 'г-1' })).toBe('REALTY:Г1');
    expect(collateralAssetKey('LAND', {})).toBeNull();
  });
  it('equipment by serial number; fungible assets have no key', () => {
    expect(collateralAssetKey('EQUIPMENT', { serialNo: 'sn-9' })).toBe('EQUIPMENT:SN9');
    expect(collateralAssetKey('EQUIPMENT', { name: 'Машин' })).toBeNull();
    expect(collateralAssetKey('LIVESTOCK', { headCount: 10 })).toBeNull();
    expect(collateralAssetKey('INVENTORY', { name: 'x' })).toBeNull();
    expect(collateralAssetKey('OTHER', { name: 'x' })).toBeNull();
  });
});

describe('helpers', () => {
  it('kind: real estate is immovable, everything else movable', () => {
    expect(collateralKindOf('APARTMENT')).toBe('IMMOVABLE');
    expect(collateralKindOf('LAND')).toBe('IMMOVABLE');
    expect(collateralKindOf('VEHICLE')).toBe('MOVABLE');
    expect(collateralKindOf('OTHER')).toBe('MOVABLE');
  });
  it('manual-value assets', () => {
    expect([...MANUAL_VALUE_ASSET_TYPES]).toEqual(['INVENTORY', 'EQUIPMENT', 'OTHER']);
    expect(isManualValueAsset('INVENTORY')).toBe(true);
    expect(isManualValueAsset('VEHICLE')).toBe(false);
  });
  it('seeded checklist keys all have a Mongolian label; unknown keys fall back to the key', () => {
    for (const k of ['ownership_certificate', 'cadastral_plan', 'registry_extract', 'vehicle_certificate', 'traffic_registry_extract', 'insurance', 'head_count_extract', 'stocktake_act', 'purchase_invoice', 'ownership_proof', 'other']) expect(COLLATERAL_CHECKLIST_LABELS[k], k).toBeTruthy();
    expect(collateralChecklistLabel('insurance')).toBe('Даатгалын гэрээ');
    expect(collateralChecklistLabel('custom_key')).toBe('custom_key');
  });
  it('product collateral checklist accepts plain keys and objects', () => {
    const parsed = ProductCollateralChecklist.parse({ VEHICLE: ['vehicle_certificate', { key: 'insurance', required: false }, { key: 'x' }] });
    expect(parsed.VEHICLE).toHaveLength(3);
  });
});
