import { describe, expect, it } from 'vitest';
import { buildPayload, canEditCustomer, issuePath, pruneEmpty, validateCustomer } from './customers.utils';

const fixed = { customerType: 'INDIVIDUAL', registerNo: 'УБ90010112' };
const addr = { province: 'УБ', district: 'БЗД', khoroo: '1', detail: 'Байр 1' };
const full = {
  lastName: 'Болд', firstName: 'Бат', gender: 'MALE', birthDate: '1990-01-01', phone: '99112233', email: 'bat@example.mn', photoFileId: 'f1', familySize: 3,
  activitySector: 'Худалдаа', maritalStatus: 'MARRIED', segment: 'Жижиг', education: 'Бакалавр', officialAddress: addr, residenceSameAsOfficial: true,
  employment: { organization: 'ХХК', position: 'Менежер' },
};

describe('pruneEmpty', () => {
  it('хоосон мөр, хоосон объект, массивыг хасна; false/0-г хэвээр үлдээнэ', () => {
    expect(pruneEmpty({ a: '', b: ' ', c: { d: '' }, e: [], f: false, g: 0, h: 'x' })).toEqual({ f: false, g: 0, h: 'x' });
  });
});

describe('buildPayload / validateCustomer', () => {
  it('бүрэн иргэн: алдаагүй, ижил хаягтай үед residenceAddress явуулахгүй', () => {
    const p = buildPayload({ ...full, residenceAddress: { province: '', district: '', khoroo: '', detail: '' }, contacts: [] }, fixed);
    expect(p.residenceAddress).toBeUndefined();
    expect(validateCustomer(p)).toEqual([]);
  });

  it('хоосон маягт: заавал талбар бүр талбарын замтай алдаа; хаяг/хөдөлмөр нь эхний дэд талбар руу заана', () => {
    const issues = validateCustomer(buildPayload({}, fixed));
    const names = issues.map((i) => i.name.join('.'));
    expect(names).toContain('lastName');
    expect(names).toContain('officialAddress.province');
    expect(names).toContain('employment.organization');
    expect(names).toContain('residenceAddress.province');
  });

  it('байгууллага: иргэний талбар шаардахгүй', () => {
    const legal = { firstName: 'Монгол ХХК', phone: '99112233', email: 'a@b.mn', activitySector: 'Худалдаа', segment: 'SME', officialAddress: addr, residenceSameAsOfficial: true };
    expect(validateCustomer(buildPayload(legal, { customerType: 'LEGAL_ENTITY', registerNo: '1234567' }))).toEqual([]);
  });
});

describe('issuePath', () => {
  it('сервер талын "contacts.0.phone" зам → массивын индекс тоо', () => {
    expect(issuePath('contacts.0.phone')).toEqual(['contacts', 0, 'phone']);
  });
});

// NFR-3 (эзэмшигчийн шийдвэр 2026-11-18, A): сервер эх сурвалж; UI зөвхөн засах боломжгүйг урьдчилан тайлбарлана.
describe('canEditCustomer', () => {
  const me = (branchId: string | null, permissions: string[] = ['customer:read', 'customer:write']) => ({ user: { branchId }, permissions });
  it('the owning branch with customer:write may edit', () => expect(canEditCustomer(me('B1'), { branchId: 'B1' })).toEqual({ editable: true, reason: null }));
  it('another branch may not, with reason OTHER_BRANCH', () => expect(canEditCustomer(me('B2'), { branchId: 'B1' })).toEqual({ editable: false, reason: 'OTHER_BRANCH' }));
  it('a user without a branch may not edit a branch-owned customer', () => expect(canEditCustomer(me(null), { branchId: 'B1' }).reason).toBe('OTHER_BRANCH'));
  it('a legacy customer without an owner is editable by any writer', () => expect(canEditCustomer(me('B2'), { branchId: null }).editable).toBe(true));
  it('no customer:write gives NO_PERMISSION regardless of branch', () => expect(canEditCustomer(me('B1', ['customer:read']), { branchId: 'B1' })).toEqual({ editable: false, reason: 'NO_PERMISSION' }));
  it('not signed in yet is not editable', () => expect(canEditCustomer(null, { branchId: 'B1' }).editable).toBe(false));
});
