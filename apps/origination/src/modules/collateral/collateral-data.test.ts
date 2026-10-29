import { describe, expect, it } from 'vitest';
import type { CollateralValuationRecord } from '@los/contracts';
import { auditSnapshot, collateralFingerprint, dateOnly, descriptionOf, isoDate, nextRevaluationDate, num, stableStringify, valuationColumnsFromRecord } from './collateral-data';

describe('collateral-data', () => {
  it('num / isoDate / dateOnly', () => {
    expect(num(null)).toBeNull();
    expect(num(undefined)).toBeNull();
    expect(num(12.5)).toBe(12.5);
    expect(isoDate(new Date('2026-10-29T00:00:00.000Z'))).toBe('2026-10-29');
    expect(isoDate(null)).toBeNull();
    expect(dateOnly('2026-10-29').toISOString()).toBe('2026-10-29T00:00:00.000Z');
  });

  it('stableStringify: түлхүүрийн дарааллаас үл хамаарна, undefined-ийг орхино', () => {
    expect(stableStringify({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: undefined } })).toBe(stableStringify({ a: { c: undefined, d: [3, { x: 2, y: 1 }] }, b: 1 }));
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
    expect(stableStringify(undefined)).toBe('null');
  });

  it('descriptionOf: объект биш бол {}', () => {
    expect(descriptionOf({ descriptionJson: null })).toEqual({});
    expect(descriptionOf({ descriptionJson: [1] as never })).toEqual({});
    expect(descriptionOf({ descriptionJson: { a: 1 } })).toEqual({ a: 1 });
  });

  it('collateralFingerprint: төрөл / өмчлөгч / тодорхойлолт өөрчлөгдөхөд өөр; үнэлгээ зэрэг бусад талбарт мэдрэмтгий биш', () => {
    const base = { assetType: 'VEHICLE', ownerCustomerId: 'c1', descriptionJson: { plateNo: '1234УБА', make: 'Toyota' } };
    expect(collateralFingerprint(base)).toBe(collateralFingerprint({ ...base, descriptionJson: { make: 'Toyota', plateNo: '1234УБА' } }));
    expect(collateralFingerprint(base)).not.toBe(collateralFingerprint({ ...base, ownerCustomerId: 'c2' }));
    expect(collateralFingerprint(base)).not.toBe(collateralFingerprint({ ...base, assetType: 'EQUIPMENT' }));
    expect(collateralFingerprint(base)).not.toBe(collateralFingerprint({ ...base, descriptionJson: { plateNo: '1234УБА', make: 'Lexus' } }));
  });

  it('nextRevaluationDate: УБ-ын өдөр дээр + хоног (UTC 17:00 = УБ маргааш 01:00)', () => {
    expect(nextRevaluationDate(new Date('2026-10-29T03:00:00.000Z'), 180).toISOString()).toBe('2027-04-27T00:00:00.000Z');
    expect(nextRevaluationDate(new Date('2026-10-29T17:30:00.000Z'), 1).toISOString()).toBe('2026-10-31T00:00:00.000Z');
  });

  it('valuationColumnsFromRecord: record -> багана, валидность хугацаа null байж болно', () => {
    const rec: CollateralValuationRecord = {
      id: 'v1', collateralId: 'c1', source: 'INTERNAL', method: 'VEHICLE_BASE_PRICE', appraiser: null, licenseNo: null, valuedAt: '2026-10-29T03:00:00.000Z', validUntil: null,
      marketValue: 30_000_000, suggestedValue: 30_000_000, haircutRate: 0.7, haircutSource: 'PRODUCT_JSON', collateralValue: 21_000_000, overrideReason: null, reportFileId: null, externalRequired: false, createdBy: null,
    };
    const cols = valuationColumnsFromRecord(rec, 180);
    expect(cols).toMatchObject({ marketValue: 30_000_000, haircutRate: 0.7, collateralValue: 21_000_000, valuationId: 'v1', valuationSource: 'INTERNAL', valuationValidUntil: null, externalValuationRequired: false });
    expect(cols.valuedAt.toISOString()).toBe('2026-10-29T03:00:00.000Z');
    expect(cols.nextRevaluationAt.toISOString()).toBe('2027-04-27T00:00:00.000Z');
    const withValid = valuationColumnsFromRecord({ ...rec, validUntil: '2027-01-01T00:00:00.000Z', overrideReason: 'x' }, 180);
    expect(withValid.valuationValidUntil?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(withValid.valuationOverrideReason).toBe('x');
  });

  it('auditSnapshot: улсын дугаар, регистр, нэр, тодорхойлолт ОРОХГҮЙ', () => {
    const row = {
      assetType: 'VEHICLE', kind: 'MOVABLE', source: 'MANUAL', ownerCustomerId: 'c1', ownershipVerified: true, encumbranceStatus: 'CLEAR', marketValue: 30_000_000, haircutRate: 0.7, collateralValue: 21_000_000,
      valuationId: 'v1', valuationSource: 'INTERNAL', valuedAt: new Date('2026-10-29T03:00:00.000Z'), registryNo: 'EB-1', releasedAt: null,
      descriptionJson: { plateNo: '1234УБА', vin: 'VIN123' }, ownershipCheckJson: { owners: [{ name: 'Бат' }] }, assetKey: 'VEHICLE:1234УБА',
    } as never;
    const snap = auditSnapshot(row);
    const text = JSON.stringify(snap);
    for (const secret of ['1234УБА', 'VIN123', 'Бат', 'EB-1']) expect(text).not.toContain(secret);
    expect(snap).toMatchObject({ assetType: 'VEHICLE', ownerCustomerId: 'c1', registered: true, collateralValue: 21_000_000, valuedAt: '2026-10-29T03:00:00.000Z' });
  });
});
