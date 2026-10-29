import { describe, expect, it } from 'vitest';
import { CreateCustomerRequest, CustomerInput, UpdateCustomerRequest, XypCitizen, customerTypeOfRegister, isValidRegisterNo, normalizePhone, normalizeRegisterNo } from './customer';

const address = { province: 'Улаанбаатар', district: 'Баянзүрх', khoroo: '5-р хороо', detail: 'Хан-Уул хотхон 12-45' };
export const validIndividual = {
  customerType: 'INDIVIDUAL', registerNo: 'УБ90010112', lastName: 'Болд', firstName: 'Бат-Эрдэнэ', gender: 'MALE', birthDate: '1990-01-01',
  phone: '99112233', email: 'bat@example.mn', photoFileId: 'file-1', familySize: 4, activitySector: 'Худалдаа', maritalStatus: 'MARRIED', segment: 'Жижиг бизнес', education: 'Бакалавр',
  officialAddress: address, residenceSameAsOfficial: true, employment: { organization: 'Тэнгэр ХХК', position: 'Менежер' },
} as const;
const paths = (input: unknown) => {
  const r = CustomerInput.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
};

describe('register number', () => {
  it('normalizes case and whitespace so duplicates cannot hide behind formatting', () => {
    expect(normalizeRegisterNo(' уб 9001\u00a00112\u200b ')).toBe('УБ90010112');
    expect(normalizeRegisterNo('өү12345678')).toBe('ӨҮ12345678');
  });
  it('detects customer type by format', () => {
    expect(customerTypeOfRegister('уб90010112')).toBe('INDIVIDUAL');
    expect(customerTypeOfRegister('5012345')).toBe('LEGAL_ENTITY');
    expect(customerTypeOfRegister('AB90010112')).toBeNull(); // латин үсэг
    expect(customerTypeOfRegister('УБ9001011')).toBeNull();
    expect(isValidRegisterNo('LEGAL_ENTITY', 'УБ90010112')).toBe(false);
  });
});

describe('phone', () => {
  it('keeps 8 digits and drops the country code', () => {
    expect(normalizePhone('+976 9911-2233')).toBe('99112233');
    expect(normalizePhone('99112233')).toBe('99112233');
    expect(normalizePhone('97612345')).toBe('97612345'); // 976-аар эхэлсэн 8 оронтой дугаар
  });
});

describe('CustomerInput (FR-2.3)', () => {
  it('accepts a complete individual and normalizes register/phone', () => {
    const r = CustomerInput.parse({ ...validIndividual, registerNo: 'уб 90010112', phone: '+976 9911 2233' });
    expect(r).toMatchObject({ registerNo: 'УБ90010112', phone: '99112233', isPep: false, isRelatedParty: false, contacts: [] });
  });
  it('names every missing required field of an individual', () => {
    const { lastName, gender, birthDate, phone, email, photoFileId, familySize, activitySector, maritalStatus, segment, education, officialAddress, employment, ...rest } = validIndividual;
    void [lastName, gender, birthDate, phone, email, photoFileId, familySize, activitySector, maritalStatus, segment, education, officialAddress, employment];
    expect(paths({ ...rest, residenceSameAsOfficial: false }).sort()).toEqual(
      ['activitySector', 'birthDate', 'education', 'email', 'employment', 'familySize', 'gender', 'lastName', 'maritalStatus', 'officialAddress', 'phone', 'photoFileId', 'residenceAddress', 'segment'].sort(),
    );
  });
  it('requires the residence address unless the "same as official" box is ticked', () => {
    expect(paths({ ...validIndividual, residenceSameAsOfficial: false })).toEqual(['residenceAddress']);
    expect(paths({ ...validIndividual, residenceSameAsOfficial: false, residenceAddress: address })).toEqual([]);
  });
  it('validates register format against the customer type', () => {
    expect(paths({ ...validIndividual, registerNo: '5012345' })).toEqual(['registerNo']);
    expect(paths({ ...validIndividual, customerType: 'LEGAL_ENTITY', registerNo: 'УБ90010112' })).toEqual(['registerNo']);
  });
  it('legal entity does not need personal fields', () => {
    const legal = { customerType: 'LEGAL_ENTITY', registerNo: '5012345', firstName: 'Тэнгэр ХХК', phone: '77001122', email: 'info@tenger.mn', activitySector: 'Барилга', segment: 'ЖДБ', officialAddress: address, residenceSameAsOfficial: true };
    expect(paths(legal)).toEqual([]);
    expect(paths({ ...legal, phone: undefined })).toEqual(['phone']);
  });
  it('rejects bad phone, email, dates and counts; treats blanks as missing', () => {
    expect(paths({ ...validIndividual, phone: '123' })).toEqual(['phone']);
    expect(paths({ ...validIndividual, email: 'not-an-email' })).toEqual(['email']);
    expect(paths({ ...validIndividual, birthDate: '2999-01-01' })).toEqual(['birthDate']);
    expect(paths({ ...validIndividual, birthDate: '1990-02-31' })).toEqual(['birthDate']);
    expect(paths({ ...validIndividual, familySize: 0 })).toEqual(['familySize']);
    expect(paths({ ...validIndividual, lastName: '   ' })).toEqual(['lastName']);
    expect(paths({ ...validIndividual, email: '' })).toEqual(['email']);
  });
  it('validates emergency contacts (FR-2.4)', () => {
    const c = { relation: 'SPOUSE', firstName: 'Сараа', phone: '88112233' };
    expect(CustomerInput.parse({ ...validIndividual, contacts: [c] }).contacts).toHaveLength(1);
    expect(paths({ ...validIndividual, contacts: [{ ...c, relation: 'BOSS' }] })).toEqual(['contacts.0.relation']);
    expect(paths({ ...validIndividual, contacts: [{ ...c, phone: '1' }] })).toEqual(['contacts.0.phone']);
    expect(paths({ ...validIndividual, contacts: [{ ...c, registerNo: 'bad' }] })).toEqual(['contacts.0.registerNo']);
  });
});

describe('request schemas', () => {
  it('create is partial except for the register (XYP fills the rest) and defaults to MANUAL', () => {
    expect(CreateCustomerRequest.parse({ registerNo: 'уб90010112' })).toMatchObject({ registerNo: 'УБ90010112', source: 'MANUAL' });
    expect(CreateCustomerRequest.safeParse({}).success).toBe(false);
    // partial() нь default-ыг идэвхжүүлэхгүй — XYP-ээр нөхөхөд "өгөөгүй" гэдэг нь "undefined" хэвээр
    expect(CreateCustomerRequest.parse({ registerNo: 'уб90010112' }).isPep).toBeUndefined();
  });
  it('update cannot touch the register number or type', () => {
    expect(UpdateCustomerRequest.parse({ registerNo: 'УБ00000001', customerType: 'LEGAL_ENTITY', phone: '99112233' })).toEqual({ phone: '99112233' });
  });
});

describe('XypCitizen', () => {
  it('requires every key (nullable, not optional) so a partial upstream reply is caught at the boundary', () => {
    expect(XypCitizen.safeParse({ registerNo: 'УБ90010112', firstName: 'Бат' }).success).toBe(false);
  });
});
