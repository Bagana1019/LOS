import { describe, expect, it } from 'vitest';
import type { CustomerLookup, CustomerView } from '@los/contracts';
import { buildUpdateBody, customerToFormValues, xypLockedPrefill } from './customer-edit';
import { lookupToFetchResult, usesCitizenOtp } from './customer-legal';

// F1-15: карт дээрх засвар = PUT /customers/:id (хэсэгчилсэн). Регистр/төрөл явахгүй, зөвхөн өөрчилсөн талбар, арилгах = "".
const ADDR = { province: 'Улаанбаатар', district: 'БЗД', khoroo: '1-р хороо', detail: 'Байр 1' };
const base: CustomerView = {
  id: '22222222-2222-4222-8222-222222222222', customerType: 'INDIVIDUAL', registerNo: 'УБ90010112', lastName: 'Болд', clanName: null, civilId: null, firstName: 'Бат',
  gender: 'MALE', birthDate: '1990-01-01', phone: '99112233', email: 'bat@example.mn', photoFileId: '33333333-3333-4333-8333-333333333333', familySize: 3,
  activitySector: 'Худалдаа', maritalStatus: 'MARRIED', segment: 'Жижиглэн', education: 'Бакалавр', isRelatedParty: false, isPep: false, amlRiskScore: null,
  officialAddress: ADDR, residenceAddress: ADDR, residenceSameAsOfficial: true, employment: { organization: 'ХХК', position: 'Менежер' },
  xypFetchedAt: '2026-11-03T00:00:00.000Z', branchId: 'branch', createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:00:00.000Z',
  contacts: [{ id: 'c1', relation: 'PARENT', registerNo: null, lastName: 'Болд', firstName: 'Дорж', phone: '88112233' }], warnings: [],
};
// Маягтаас (buildPayload) ирэх бие: customerType/registerNo-той, хоосон талбаргүй
const payloadOf = (card: CustomerView, patch: Record<string, unknown> = {}): Record<string, unknown> => {
  const { id: _i, registerNo: _r, ...contact } = card.contacts[0]!;
  return {
    customerType: card.customerType, registerNo: card.registerNo, lastName: 'Болд', firstName: 'Бат', gender: 'MALE', birthDate: '1990-01-01', phone: '99112233', email: 'bat@example.mn',
    photoFileId: card.photoFileId, familySize: 3, activitySector: 'Худалдаа', maritalStatus: 'MARRIED', segment: 'Жижиглэн', education: 'Бакалавр',
    isRelatedParty: false, isPep: false, residenceSameAsOfficial: true, officialAddress: ADDR, employment: { organization: 'ХХК', position: 'Менежер' }, contacts: [contact], ...patch,
  };
};

describe('customerToFormValues', () => {
  it('null-г хасаж, холбоо барих хүний id/null регистрийг арилгана', () => {
    const v = customerToFormValues(base);
    expect(v).not.toHaveProperty('clanName');
    expect(v).not.toHaveProperty('civilId');
    expect(v.contacts).toEqual([{ relation: 'PARENT', lastName: 'Болд', firstName: 'Дорж', phone: '88112233' }]);
  });

  it('оршин суугаа хаяг албан ёсныхтай ижил бол residenceAddress-ийг маягтад өгөхгүй', () => {
    const v = customerToFormValues(base);
    expect(v.residenceSameAsOfficial).toBe(true);
    expect(v).not.toHaveProperty('residenceAddress');
  });

  it('ялгаатай оршин суугаа хаягийг хэвээр өгнө', () => {
    const other = { ...ADDR, detail: 'Байр 9' };
    const v = customerToFormValues({ ...base, residenceSameAsOfficial: false, residenceAddress: other });
    expect(v.residenceAddress).toEqual(other);
  });
});

describe('xypLockedPrefill', () => {
  it('ХУР-аас татаагүй (xypFetchedAt=null) бол юу ч түгжихгүй', () => {
    expect(xypLockedPrefill({ ...base, xypFetchedAt: null })).toEqual([]);
  });

  it('ХУР-ын эзэмшдэг, утгатай талбарыг л түгжинэ (clanName/civilId хоосон бол түгжихгүй)', () => {
    expect(xypLockedPrefill(base).sort()).toEqual(['birthDate', 'firstName', 'lastName', 'officialAddress']);
    expect(xypLockedPrefill({ ...base, clanName: 'Боржигин', civilId: '1234567890' })).toEqual(expect.arrayContaining(['clanName', 'civilId']));
  });
});

describe('buildUpdateBody', () => {
  const initial = customerToFormValues(base);

  it('өөрчлөлтгүй бол хоосон бие', () => {
    expect(buildUpdateBody(payloadOf(base), initial)).toEqual({});
  });

  it('зөвхөн өөрчилсөн талбарыг явуулна; customerType/registerNo хэзээ ч явахгүй', () => {
    const body = buildUpdateBody(payloadOf(base, { phone: '99887766' }), initial);
    expect(body).toEqual({ phone: '99887766' });
    expect(body).not.toHaveProperty('customerType');
    expect(body).not.toHaveProperty('registerNo');
  });

  it('хөдөлмөрийн дэд талбар өөрчлөгдвөл бүтэн employment (сервер бүтнээр нь солино)', () => {
    const employment = { organization: 'ХХК', position: 'Захирал', phone: '70112233' };
    expect(buildUpdateBody(payloadOf(base, { employment }), initial)).toEqual({ employment });
  });

  it('заавал биш мөр талбарыг арилгавал "" явуулна (клиент хоосныг хасдаг тул сервер "өөрчлөхгүй" гэж ойлгох байсан)', () => {
    const withClan = { ...base, clanName: 'Боржигин' };
    const body = buildUpdateBody(payloadOf(withClan), customerToFormValues(withClan));
    expect(body).toEqual({ clanName: '' });
  });

  it('бүх холбоо барих хүнийг устгавал contacts: [] (бүхэлд нь солино)', () => {
    expect(buildUpdateBody(payloadOf(base, { contacts: undefined }), initial)).toEqual({ contacts: [] });
  });

  it('холбоо барих хүн нэмэх/засахад бүтэн жагсаалт', () => {
    const contacts = [...(payloadOf(base).contacts as unknown[]), { relation: 'FRIEND', firstName: 'Сүх', phone: '99001122' }];
    expect(buildUpdateBody(payloadOf(base, { contacts }), initial)).toEqual({ contacts });
  });

  it('оршин суугаа хаягийг тусад нь болгоход чекбокс + хаяг хоёулаа явна', () => {
    const residenceAddress = { ...ADDR, detail: 'Байр 9' };
    const body = buildUpdateBody(payloadOf(base, { residenceSameAsOfficial: false, residenceAddress }), initial);
    expect(body).toEqual({ residenceSameAsOfficial: false, residenceAddress });
  });

  it('PEP тэмдэглэгээ false → true өөрчлөлт явна', () => {
    expect(buildUpdateBody(payloadOf(base, { isPep: true }), initial)).toEqual({ isPep: true });
  });
});

// F1-16: иргэний зөвшөөрлийн код (иргэний утсанд) нь ААН-д хамаарахгүй
describe('usesCitizenOtp', () => {
  it('иргэнд л иргэний код', () => {
    expect(usesCitizenOtp('INDIVIDUAL')).toBe(true);
    expect(usesCitizenOtp('LEGAL_ENTITY')).toBe(false);
  });
});

describe('lookupToFetchResult', () => {
  const warning = { code: 'BLACKLISTED', severity: 'WARNING', listType: 'INTERNAL', listSeverity: 'BLACK', reasonCode: 'FRAUD', reasonText: 'Залилан', registeredAt: '2026-11-01T00:00:00.000Z' } as const;
  const lookup: CustomerLookup = { registerNo: '5301234', customerType: 'LEGAL_ENTITY', exists: false, customer: null, warnings: [warning] };

  it('бүртгэлгүй: ХУР-аар татаагүй (token байхгүй) → source=MANUAL үүсгэнэ, хар жагсаалтын анхааруулга хэвээр', () => {
    const r = lookupToFetchResult(lookup);
    expect(r).toMatchObject({ registerNo: '5301234', customerType: 'LEGAL_ENTITY', fetchedAt: null, snapshotToken: null, existing: null, prefilledFields: [], missing: [], warnings: [warning] });
  });

  it('бүртгэлтэй: existing = харилцагчийн хураангуй', () => {
    const customer = { id: 'x', customerType: 'LEGAL_ENTITY', registerNoMasked: '5****34', lastName: null, firstName: 'Нэгдэл ХХК', phone: null, isPep: false, isRelatedParty: false, blacklisted: false, createdAt: '2026-11-03T00:00:00.000Z' } as const;
    expect(lookupToFetchResult({ ...lookup, exists: true, customer, warnings: [] }).existing).toEqual(customer);
  });
});
