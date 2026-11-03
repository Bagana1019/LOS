import { describe, expect, it } from 'vitest';
import { buildPayload, issuePath, pruneEmpty, validateCustomer } from './customers.utils';

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
