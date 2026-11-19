import { XypCitizen } from '@los/contracts';
import { describe, expect, it } from 'vitest';
import { XypUnavailableError } from './xyp.client';
import { mapCitizenResponse } from './xyp-citizen.mapper';

// WS100101 getCitizenIDCardInfo → LOS XypCitizen. Талбарын нэр: gsb-ийн тест fixture-ээр нотлогдсон (firstname, lastname, gender, birthDateAsText,
// civilId, aimagCityName, soumDistrictName, bagKhorooName, addressStreetName, addressDetail, addressDoor, addressApartmentName, passportAddress, image).
const NOW = new Date('2026-11-19T01:00:00Z');
const REG = 'УБ90010112';
const full = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  firstname: 'Бат', lastname: 'Доржийн', gender: 'Эрэгтэй', birthDateAsText: '1990-01-01 00:00', civilId: '12345678',
  aimagCityName: 'Улаанбаатар', soumDistrictName: 'Сүхбаатар', bagKhorooName: '3-р хороо', addressStreetName: 'Энхтайвны өргөн чөлөө',
  addressApartmentName: '5-р байр', addressDetail: '12 тоот', passportAddress: 'Улаанбаатар, Сүхбаатар, 3-р хороо', image: 'IMAGE-BASE64-SECRET', ...over,
});

describe('mapCitizenResponse', () => {
  it('бүрэн хариуг XypCitizen болгоно; ХУР-д байхгүй талбар null', () => {
    expect(mapCitizenResponse(REG, full(), NOW)).toEqual({
      registerNo: REG, customerType: 'INDIVIDUAL', lastName: 'Доржийн', firstName: 'Бат', clanName: null, civilId: '12345678', gender: 'MALE', birthDate: '1990-01-01',
      maritalStatus: null, familySize: null, activitySector: null,
      address: { province: 'Улаанбаатар', district: 'Сүхбаатар', khoroo: '3-р хороо', detail: 'Энхтайвны өргөн чөлөө, 5-р байр, 12 тоот' },
      fetchedAt: '2026-11-19T01:00:00.000Z',
    });
  });

  it('гаралт нь @los/contracts-ийн XypCitizen схемд нийцнэ', () => {
    expect(() => XypCitizen.parse(mapCitizenResponse(REG, full(), NOW))).not.toThrow();
  });

  it('зураг (image) болон бусад хувийн мэдээллийг гаралтад оруулахгүй', () => {
    const out = JSON.stringify(mapCitizenResponse(REG, full(), NOW));
    expect(out).not.toContain('IMAGE-BASE64-SECRET');
    expect(out).not.toContain('image');
  });

  it.each([['Эрэгтэй', 'MALE'], ['эрэгтэй', 'MALE'], ['male', 'MALE'], ['MAN', 'MALE'], ['Эмэгтэй', 'FEMALE'], ['female', 'FEMALE'], ['woman', 'FEMALE'], [' Эмэгтэй ', 'FEMALE']])('хүйс %j → %s', (g, expected) => {
    expect(mapCitizenResponse(REG, full({ gender: g }), NOW).gender).toBe(expected);
  });
  it.each([[undefined], [''], ['бусад'], [1]])('хүйс %j танигдахгүй → null (таамаглахгүй)', (g) => {
    expect(mapCitizenResponse(REG, full({ gender: g }), NOW).gender).toBeNull();
  });

  it('төрсөн огноо: birthDateAsText ("YYYY-MM-DD HH:MM") → YYYY-MM-DD', () => {
    expect(mapCitizenResponse(REG, full({ birthDateAsText: '2000-05-07 00:00' }), NOW).birthDate).toBe('2000-05-07');
  });
  it('birthDateAsText байхгүй бол birthDate (Date эсвэл ISO string) ашиглана; задлагдахгүй бол null', () => {
    expect(mapCitizenResponse(REG, full({ birthDateAsText: undefined, birthDate: new Date('1995-03-04T00:00:00Z') }), NOW).birthDate).toBe('1995-03-04');
    expect(mapCitizenResponse(REG, full({ birthDateAsText: undefined, birthDate: '1995-03-04T00:00:00.000+08:00' }), NOW).birthDate).toBe('1995-03-04');
    expect(mapCitizenResponse(REG, full({ birthDateAsText: 'өчигдөр' }), NOW).birthDate).toBeNull();
    expect(mapCitizenResponse(REG, full({ birthDateAsText: undefined }), NOW).birthDate).toBeNull();
  });

  it('хаяг: хороо / дүүрэг / аймаг-хот заавал; аль нэг нь дутвал null (албан тушаалтан гараар бөглөнө)', () => {
    for (const missing of ['aimagCityName', 'soumDistrictName', 'bagKhorooName']) {
      expect(mapCitizenResponse(REG, full({ [missing]: undefined }), NOW).address).toBeNull();
      expect(mapCitizenResponse(REG, full({ [missing]: '  ' }), NOW).address).toBeNull();
    }
  });
  it('хаягийн дэлгэрэнгүй: addressDetail байхгүй бол addressDoor; бүгд байхгүй бол passportAddress; тэр ч байхгүй бол null', () => {
    expect(mapCitizenResponse(REG, full({ addressDetail: undefined, addressDoor: '7' }), NOW).address?.detail).toBe('Энхтайвны өргөн чөлөө, 5-р байр, 7');
    expect(mapCitizenResponse(REG, full({ addressStreetName: undefined, addressApartmentName: undefined, addressDetail: undefined }), NOW).address?.detail).toBe('Улаанбаатар, Сүхбаатар, 3-р хороо');
    expect(mapCitizenResponse(REG, full({ addressStreetName: undefined, addressApartmentName: undefined, addressDetail: undefined, passportAddress: undefined }), NOW).address).toBeNull();
  });

  it('civilId: тоо ч байж болно → string; байхгүй → null', () => {
    expect(mapCitizenResponse(REG, full({ civilId: 987654 }), NOW).civilId).toBe('987654');
    expect(mapCitizenResponse(REG, full({ civilId: undefined }), NOW).civilId).toBeNull();
  });

  it('нэрийн хоосон зайг тайрна; овог байхгүй бол lastName=null', () => {
    const c = mapCitizenResponse(REG, full({ firstname: '  Бат ', lastname: '' }), NOW);
    expect(c.firstName).toBe('Бат');
    expect(c.lastName).toBeNull();
  });

  it.each([[null], [undefined], ['x'], [[]], [{}], [full({ firstname: undefined })], [full({ firstname: '   ' })]])('хэлбэр буруу / нэргүй хариу %j → XypUnavailableError (зохиомол иргэн үүсгэхгүй)', (bad) => {
    expect(() => mapCitizenResponse(REG, bad, NOW)).toThrow(XypUnavailableError);
  });
});
