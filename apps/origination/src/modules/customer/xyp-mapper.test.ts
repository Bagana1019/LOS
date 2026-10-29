import { CustomerInput, type XypCitizen } from '@los/contracts';
import { describe, expect, it } from 'vitest';
import { citizenPrefill, leafPaths, mergeXyp } from './xyp-mapper';

const citizen: XypCitizen = {
  registerNo: 'УБ90010112', customerType: 'INDIVIDUAL', lastName: 'Болд', firstName: 'Сарнай', gender: 'FEMALE', birthDate: '1990-01-01',
  maritalStatus: 'MARRIED', familySize: 3, activitySector: null,
  address: { province: 'Улаанбаатар', district: 'Баянзүрх', khoroo: '5-р хороо', detail: 'Хан-Уул хотхон' }, fetchedAt: '2026-01-01T00:00:00.000Z',
};

describe('citizenPrefill (FR-2.2)', () => {
  it('maps XYP fields to form fields and skips nulls', () => {
    const p = citizenPrefill(citizen);
    expect(p).toMatchObject({ customerType: 'INDIVIDUAL', registerNo: 'УБ90010112', lastName: 'Болд', firstName: 'Сарнай', gender: 'FEMALE', birthDate: '1990-01-01', maritalStatus: 'MARRIED', familySize: 3 });
    expect(p).not.toHaveProperty('activitySector');
    expect(leafPaths(p)).toHaveLength(12); // 8 энгийн + 4 хаягийн түвшин → "10+ талбар автоматаар"
  });
  it('a ХУР-only prefill still fails validation on exactly the fields XYP cannot know', () => {
    const r = CustomerInput.safeParse(citizenPrefill(citizen));
    const missing = r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
    expect([...missing].sort()).toEqual(['activitySector', 'education', 'email', 'employment', 'phone', 'photoFileId', 'residenceAddress', 'segment']);
  });
});

describe('mergeXyp', () => {
  it('XYP wins identity fields but keeps what the officer already filled for fill-only fields', () => {
    const merged = mergeXyp({ registerNo: 'УБ90010112', lastName: 'Хуурамч', firstName: 'Хуурамч', gender: 'MALE', birthDate: '1980-05-05', maritalStatus: 'SINGLE', phone: '99112233' }, citizen);
    expect(merged).toMatchObject({ lastName: 'Болд', firstName: 'Сарнай', gender: 'FEMALE', birthDate: '1990-01-01', maritalStatus: 'SINGLE', familySize: 3, phone: '99112233' });
  });
  it('does not blank a client value when XYP has nothing for it', () => {
    expect(mergeXyp({ registerNo: 'УБ90010112', activitySector: 'Худалдаа' }, citizen)).toMatchObject({ activitySector: 'Худалдаа' });
  });
});

describe('leafPaths', () => {
  it('flattens nested objects, skips null/undefined, treats arrays and scalars as leaves', () => {
    expect(leafPaths({ a: 1, b: { c: 'x', d: null }, e: undefined, f: [1, 2] })).toEqual(['a', 'b.c', 'f']);
  });
});
