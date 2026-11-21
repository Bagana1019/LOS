import { describe, expect, it } from 'vitest';
import { XYP_OTP_RESEND_COOLDOWN_SEC, buildPayload, canEditCustomer, isValidXypOtp, issuePath, normalizeOtpInput, otpResendRemainingSec, pruneEmpty, validateCustomer, xypLockedFields, xypOtpToFetchResult } from './customers.utils';

const fixed = { customerType: 'INDIVIDUAL', registerNo: 'УБ90010112' };
const addr = { province: 'УБ', district: 'БЗД', khoroo: '1', detail: 'Байр 1' };
const full = {
  lastName: 'Болд', firstName: 'Бат', gender: 'MALE', birthDate: '1990-01-01', phone: '99112233', email: 'bat@example.mn', photoFileId: 'f1', familySize: 3,
  activitySector: 'Худалдаа', maritalStatus: 'MARRIED', segment: 'Жижиг', education: 'Бакалавр', officialAddress: addr, residenceSameAsOfficial: true,
  employment: { organization: 'ХХК', position: 'Менежер' },
};

// ХУР иргэний зөвшөөрөл (нэг удаагийн код): маягтын тусламж функцүүд. Кодын дүрэм нь contracts-ийн `XypOtpCode`-той ижил (нэг эх сурвалж).
describe('иргэний код (OTP) — тусламж', () => {
  it('normalizeOtpInput: зөвхөн цифр үлдээж 8 оронд таслана (буулгасан "123 456", "12-34-56", үсэг)', () => {
    expect(normalizeOtpInput('123 456')).toBe('123456');
    expect(normalizeOtpInput('12-34-56')).toBe('123456');
    expect(normalizeOtpInput('ab12cd')).toBe('12');
    expect(normalizeOtpInput('1234567890')).toBe('12345678');
    expect(normalizeOtpInput('')).toBe('');
  });

  it.each([['1234', true], ['123456', true], ['12345678', true], ['123', false], ['123456789', false], ['12a456', false], ['', false]])('isValidXypOtp(%j) = %s', (code, ok) => {
    expect(isValidXypOtp(code)).toBe(ok);
  });

  it('xypOtpToFetchResult: бүртгэлтэй харилцагч — ХУР дуудаагүй (fetchedAt, snapshotToken null), existing / warnings дамжина', () => {
    const existing = { id: 'c1', registerNo: 'УБ90010112' } as never;
    const warnings = [{ code: 'BLACKLISTED' }] as never;
    expect(xypOtpToFetchResult({ sent: false, requestedAt: null, existing, warnings }, 'УБ90010112', 'INDIVIDUAL')).toEqual({
      registerNo: 'УБ90010112', customerType: 'INDIVIDUAL', fetchedAt: null, prefill: {}, prefilledFields: [], missing: [], existing, warnings, snapshotToken: null,
    });
  });

  it('otpResendRemainingSec: илгээснээс хойш 60 секунд хүртэл үлдсэнийг (дээш бөөнжүүлж) тоолж, дараа нь 0; огноо байхгүй / буруу бол 0', () => {
    const t0 = Date.parse('2026-11-19T10:00:00.000Z');
    expect(XYP_OTP_RESEND_COOLDOWN_SEC).toBe(60);
    expect(otpResendRemainingSec('2026-11-19T10:00:00.000Z', t0)).toBe(60);
    expect(otpResendRemainingSec('2026-11-19T10:00:00.000Z', t0 + 10_400)).toBe(50);
    expect(otpResendRemainingSec('2026-11-19T10:00:00.000Z', t0 + 60_000)).toBe(0);
    expect(otpResendRemainingSec('2026-11-19T10:00:00.000Z', t0 + 120_000)).toBe(0);
    expect(otpResendRemainingSec(null, t0)).toBe(0);
    expect(otpResendRemainingSec('not a date', t0)).toBe(0);
  });
});

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

  // F1-13: дэд талбарын алдаа (employment.phone) гарахад validateCustomer дараагийн алдаа хайхаар `employment`-г бүхэлд нь устгадаг. Дараагийн шалгалт
  // түүнийг "заавал бөглөнө" гэж давхар мэдэгдэж, бөглөсөн байгууллагын нэр хайрцагт худал алдаа харагддаг байсан.
  it('F1-13: утасны дэд талбар буруу байхад бөглөсөн байгууллагыг "заавал бөглөнө" гэж давхар мэдэгдэхгүй', () => {
    const p = buildPayload({ ...full, employment: { organization: 'ХХК', position: 'Менежер', phone: '7011-22' } }, fixed);
    const issues = validateCustomer(p);
    expect(issues.map((i) => i.name.join('.'))).toEqual(['employment.phone']);
    expect(issues[0]!.message).not.toMatch(/Заавал/);
  });

  it('F1-13: нэг объектын хоёр өөр дэд талбарын алдаа хоёулаа нэг л удаа гарч, бөглөсөн талбарт худал алдаа үүсэхгүй', () => {
    const p = buildPayload({ ...full, employment: { organization: 'ХХК', position: 'Менежер', phone: '7011-22', address: 'а'.repeat(301) } }, fixed);
    const names = validateCustomer(p).map((i) => i.name.join('.'));
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(['employment.phone', 'employment.address']));
    expect(names).not.toContain('employment.organization');
    expect(names).not.toContain('employment.position');
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

describe('xypLockedFields (M5: ХУР-ын эзэмшдэг талбар засагдахгүй)', () => {
  it('locks the official address and identity fields that XYP filled; leaves officer-owned and fill-only fields editable', () => {
    const locked = xypLockedFields(['officialAddress.province', 'officialAddress.detail', 'lastName', 'firstName', 'birthDate', 'maritalStatus', 'familySize', 'segment']);
    expect([...locked].sort()).toEqual(['birthDate', 'firstName', 'lastName', 'officialAddress']);
  });

  it('nothing is locked for a manual entry or when XYP returned no address', () => {
    expect(xypLockedFields([]).size).toBe(0);
    expect(xypLockedFields(['firstName']).has('officialAddress')).toBe(false);
  });
});
