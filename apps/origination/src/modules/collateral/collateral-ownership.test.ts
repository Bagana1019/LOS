import { describe, expect, it } from 'vitest';
import { AssetType } from '@los/contracts';
import {
  bestRole, buildOwnershipCheck, encumbranceDeclaredAllowed, encumbranceIdentifier, encumbranceRegistryAvailable, isOwnerRole, judgeOwnership, maskRegister,
  ownershipDeclaredAllowed, ownershipRegistrySource, type MatchedOwner,
} from './collateral-ownership';

const owner = (over: Partial<MatchedOwner> = {}): MatchedOwner => ({ registerMasked: 'УБ****0001', name: 'Бат', matchedCustomerId: 'cust-1', role: 'PRIMARY', ...over });

describe('бүртгэлийн эх сурвалж (FR-6.5, FR-6.6)', () => {
  it('өмчлөл: автомашин -> АТҮТ, үл хөдлөх -> ХУР, бусад бүртгэлгүй (DECLARED)', () => {
    expect(ownershipRegistrySource('VEHICLE')).toBe('ATUT');
    for (const t of ['APARTMENT', 'HOUSE', 'LAND'] as const) expect(ownershipRegistrySource(t)).toBe('XYP');
    for (const t of ['LIVESTOCK', 'INVENTORY', 'EQUIPMENT', 'OTHER'] as const) {
      expect(ownershipRegistrySource(t)).toBeNull();
      expect(ownershipDeclaredAllowed(t)).toBe(true);
    }
    for (const t of ['VEHICLE', 'APARTMENT', 'HOUSE', 'LAND'] as const) expect(ownershipDeclaredAllowed(t)).toBe(false);
  });

  it('ачаалал: бүртгэлээр шалгах боломжтой төрлүүд ба DECLARED зөвшөөрөгдөх төрлүүд', () => {
    expect(AssetType.filter(encumbranceRegistryAvailable)).toEqual(['VEHICLE', 'APARTMENT', 'HOUSE', 'LAND', 'EQUIPMENT']);
    expect(AssetType.filter(encumbranceDeclaredAllowed).sort()).toEqual(['EQUIPMENT', 'INVENTORY', 'LIVESTOCK', 'OTHER']);
  });

  it('encumbranceIdentifier: төрөл бүрийн тодорхойлогч; байхгүй бол null', () => {
    expect(encumbranceIdentifier('VEHICLE', { plateNo: ' 1234УБА ' })).toBe('1234УБА');
    expect(encumbranceIdentifier('APARTMENT', { propertyId: 'P-1', certificateNo: 'C-1' })).toBe('P-1');
    expect(encumbranceIdentifier('HOUSE', { certificateNo: 'C-1' })).toBe('C-1');
    expect(encumbranceIdentifier('LAND', { propertyId: '  ' })).toBeNull();
    expect(encumbranceIdentifier('EQUIPMENT', { serialNo: 'SN1' })).toBe('SN1');
    expect(encumbranceIdentifier('LIVESTOCK', { x: 1 })).toBeNull();
    expect(encumbranceIdentifier('VEHICLE', {})).toBeNull();
  });
});

describe('maskRegister', () => {
  it('иргэний регистр: эхний 2 + сүүлийн 4 харагдана', () => {
    expect(maskRegister('УЕ00000001')).toBe('УЕ****0001');
    expect(maskRegister(' уе00000001 ')).toBe('УЕ****0001');
  });
  it('байгууллагын 7 оронт регистр: сүүлийн 2 л харагдана', () => {
    expect(maskRegister('5012345')).toBe('*****45');
    expect(maskRegister('5012345')).not.toContain('50123');
  });
});

describe('дүр', () => {
  it('bestRole: PRIMARY > CO_BORROWER > PLEDGOR > GUARANTOR', () => {
    expect(bestRole(['GUARANTOR', 'PLEDGOR'])).toBe('PLEDGOR');
    expect(bestRole(['PLEDGOR', 'CO_BORROWER', 'GUARANTOR'])).toBe('CO_BORROWER');
    expect(bestRole(['GUARANTOR', 'PRIMARY'])).toBe('PRIMARY');
    expect(bestRole([])).toBeNull();
  });
  it('isOwnerRole: батлан даагч өмчлөгч байж болохгүй', () => {
    expect(['PRIMARY', 'CO_BORROWER', 'PLEDGOR', 'GUARANTOR'].map((r) => isOwnerRole(r as never))).toEqual([true, true, true, false]);
    expect(isOwnerRole(null)).toBe(false);
  });
});

describe('judgeOwnership (FR-6.5)', () => {
  it('өмчлөгч нь сонгосон барьцаалагч -> VERIFIED', () => {
    expect(judgeOwnership([owner()], 'cust-1')).toEqual({ status: 'VERIFIED', message: null });
  });

  it('хамтран өмчлөгч нар: нэг нь сонгосон барьцаалагч, бүгд оролцогч -> VERIFIED', () => {
    expect(judgeOwnership([owner(), owner({ matchedCustomerId: 'cust-2', role: 'PLEDGOR' })], 'cust-2').status).toBe('VERIFIED');
  });

  it('бүртгэлийн өмчлөгч хүсэлтэд байхгүй -> OWNER_NOT_ON_APPLICATION, "Барьцаалагч бүртгэнэ үү"', () => {
    const r = judgeOwnership([owner({ matchedCustomerId: null, role: null })], 'cust-1');
    expect(r.status).toBe('OWNER_NOT_ON_APPLICATION');
    expect(r.message).toContain('Барьцаалагч бүртгэнэ үү');
  });

  it('хамтран өмчлөгчийн нэг нь оролцогч биш бол үлдсэн нь таарсан ч OWNER_NOT_ON_APPLICATION', () => {
    expect(judgeOwnership([owner(), owner({ matchedCustomerId: null, role: null })], 'cust-1').status).toBe('OWNER_NOT_ON_APPLICATION');
  });

  it('зөвхөн батлан даагчаар бүртгэгдсэн өмчлөгч -> OWNER_NOT_ON_APPLICATION', () => {
    expect(judgeOwnership([owner({ role: 'GUARANTOR' })], 'cust-1').status).toBe('OWNER_NOT_ON_APPLICATION');
  });

  it('оролцогч боловч сонгосон барьцаалагч биш -> OWNER_MISMATCH', () => {
    const r = judgeOwnership([owner()], 'cust-9');
    expect(r.status).toBe('OWNER_MISMATCH');
    expect(r.message).toBeTruthy();
    expect(judgeOwnership([owner()], null).status).toBe('OWNER_MISMATCH');
  });

  it('өмчлөгч хоосон (бүртгэл олдсонгүй) -> OWNER_NOT_ON_APPLICATION', () => {
    expect(judgeOwnership([], 'cust-1').status).toBe('OWNER_NOT_ON_APPLICATION');
  });
});

describe('buildOwnershipCheck', () => {
  it('зөвхөн далдлагдсан регистр, нэр, тулгагдсан харилцагч, дүр хадгална', () => {
    const at = new Date('2026-10-29T03:00:00.000Z');
    const c = buildOwnershipCheck({ method: 'REGISTRY', source: 'ATUT', checkedAt: at, owners: [owner()], collateralOwnerCustomerId: 'cust-1' });
    expect(c).toEqual({
      status: 'VERIFIED', method: 'REGISTRY', source: 'ATUT', checkedAt: at.toISOString(), owners: [{ registerMasked: 'УБ****0001', name: 'Бат', matchedCustomerId: 'cust-1', role: 'PRIMARY' }], message: null, note: null,
    });
    expect(buildOwnershipCheck({ method: 'DECLARED', source: 'DECLARED', checkedAt: at, owners: [], collateralOwnerCustomerId: 'cust-1', note: 'ЗЭЗ баталгаажуулав' }).note).toBe('ЗЭЗ баталгаажуулав');
  });
});
