import { describe, expect, it } from 'vitest';
import { AmlSubject } from '@los/contracts';
import { evaluateAmlGate, isBlockingScreening, shouldReuseScreening, toAmlSubject, uniqueSubjects, type GateBorrower, type GateScreening } from './aml-gate.rules';

// G1 (docs/01 §4, docs/05-compliance-aml.md §5): AML хаалтын цэвэр дүрэм.
const NOW = new Date('2026-11-18T10:00:00Z');
const HOUR = 3_600_000;
const at = (msAgo: number) => new Date(NOW.getTime() - msAgo);

const borrower = (customerId: string, role: GateBorrower['role'] = 'PRIMARY', updatedHoursAgo = 48): GateBorrower => ({ customerId, role, customerUpdatedAt: at(updatedHoursAgo * HOUR) });
/** `customerUpdatedAt` = kyc-д илгээхээс ӨМНӨ уншсан харилцагчийн `updated_at` (шалгасан identity-ийн snapshot). borrower()-ийн анхдагчтай тэнцүү. */
const screening = (customerId: string, o: Partial<GateScreening> = {}): GateScreening => ({ customerId, screeningId: `s-${customerId}`, status: 'CLEAR', blocking: false, customerUpdatedAt: at(48 * HOUR), ...o });

describe('isBlockingScreening', () => {
  it.each([
    ['CLEAR', false, false], ['WARNING', false, false], ['CLEARED_AFTER_REVIEW', false, false],
    ['REVIEW_REQUIRED', true, true], ['CONFIRMED_MATCH', true, true],
    // хамгаалалт: kyc-ийн `blocking` флаг төлөвөөс үл хамааран хүндэтгэгдэнэ
    ['WARNING', true, true], ['REVIEW_REQUIRED', false, true],
  ] as const)('%s blocking=%s → %s', (status, blocking, expected) => {
    expect(isBlockingScreening({ status, blocking })).toBe(expected);
  });
});

describe('shouldReuseScreening (aml.screening_reuse_hours)', () => {
  const current = at(48 * HOUR);
  const latest = (hoursAgo: number, o: { blocking?: boolean; status?: GateScreening['status'] } = {}) => ({ screenedAt: at(hoursAgo * HOUR).toISOString(), blocking: o.blocking ?? false, status: o.status ?? 'CLEAR' });

  it('шалгалт байхгүй → шинээр шалгана', () => {
    expect(shouldReuseScreening(null, current, current, NOW, 24)).toBe(false);
  });
  it('цонх дотор + origination-ий snapshot одоогийн updated_at-тай ТЭНЦҮҮ → дахин ашиглана', () => {
    expect(shouldReuseScreening(latest(1), current, current, NOW, 24)).toBe(true);
  });
  it('snapshot байхгүй (kyc-д өөр газраас хийгдсэн шалгалт — ямар identity-г шалгасан нь тодорхойгүй) → шинээр', () => {
    expect(shouldReuseScreening(latest(1), null, current, NOW, 24)).toBe(false);
  });
  it('snapshot ≠ одоогийн updated_at (харилцагч засагдсан) → шинээр, шалгалт засварын дараа хийгдсэн байсан ч', () => {
    expect(shouldReuseScreening(latest(0.1), at(49 * HOUR), current, NOW, 24)).toBe(false);
  });
  it('хил: яг reuseHours настай → дахин ашиглана; 1 мс илүү → шинээр', () => {
    expect(shouldReuseScreening({ ...latest(0), screenedAt: at(24 * HOUR).toISOString() }, current, current, NOW, 24)).toBe(true);
    expect(shouldReuseScreening({ ...latest(0), screenedAt: at(24 * HOUR + 1).toISOString() }, current, current, NOW, 24)).toBe(false);
  });
  it('0 цаг → цэвэр үр дүнг үргэлж шинээр шалгана', () => {
    expect(shouldReuseScreening(latest(0), current, current, NOW, 0)).toBe(false);
  });
  it('блоклосон шалгалтыг насаас, snapshot-оос үл хамааран дахин ашиглана (аюулгүй тал — блоклоно)', () => {
    expect(shouldReuseScreening(latest(500, { blocking: true, status: 'REVIEW_REQUIRED' }), null, current, NOW, 0)).toBe(true);
    expect(shouldReuseScreening(latest(500, { status: 'CONFIRMED_MATCH' }), at(1), current, NOW, 24)).toBe(true);
  });
  it('огноо уншигдахгүй → шинээр шалгана (fail-closed)', () => {
    expect(shouldReuseScreening({ screenedAt: 'not-a-date', blocking: false, status: 'CLEAR' }, current, current, NOW, 24)).toBe(false);
  });
});

describe('evaluateAmlGate', () => {
  it('оролцогч бүр цэвэр (CLEAR / WARNING / CLEARED_AFTER_REVIEW) → нэвтэрнэ', () => {
    const bs = [borrower('c1'), borrower('c2', 'CO_BORROWER'), borrower('c3', 'GUARANTOR'), borrower('c4', 'PLEDGOR')];
    const ss = [screening('c1'), screening('c2', { status: 'WARNING' }), screening('c3', { status: 'CLEARED_AFTER_REVIEW' }), screening('c4')];
    expect(evaluateAmlGate(bs, ss)).toEqual({ ok: true });
  });

  it('оролцогч байхгүй → 422 PRIMARY_BORROWER_MISSING (хоосон жагсаалт хэзээ ч нэвтрэхгүй)', () => {
    expect(evaluateAmlGate([], [])).toMatchObject({ ok: false, code: 'PRIMARY_BORROWER_MISSING', httpStatus: 422 });
  });

  it('шийдвэрлэгдээгүй hit (REVIEW_REQUIRED) → 422 AML_REVIEW_REQUIRED, асуудалтай оролцогчийг л жагсаана', () => {
    const v = evaluateAmlGate([borrower('c1'), borrower('c3', 'GUARANTOR')], [screening('c1'), screening('c3', { status: 'REVIEW_REQUIRED', blocking: true })]);
    expect(v).toMatchObject({ ok: false, code: 'AML_REVIEW_REQUIRED', httpStatus: 422 });
    if (v.ok) throw new Error('unreachable');
    expect(v.issues).toEqual([{ customerId: 'c3', role: 'GUARANTOR', screeningId: 's-c3', status: 'REVIEW_REQUIRED', reason: 'REVIEW_REQUIRED' }]);
    expect(v.message).toMatch(/илгээх боломжгүй/);
  });

  it('баталгаажсан тохирол (CONFIRMED_MATCH) нь review-ээс давамгайлна → AML_CONFIRMED_MATCH', () => {
    const v = evaluateAmlGate(
      [borrower('c1'), borrower('c2', 'CO_BORROWER')],
      [screening('c1', { status: 'REVIEW_REQUIRED', blocking: true }), screening('c2', { status: 'CONFIRMED_MATCH', blocking: true })],
    );
    expect(v).toMatchObject({ ok: false, code: 'AML_CONFIRMED_MATCH', httpStatus: 422 });
    if (v.ok) throw new Error('unreachable');
    expect(v.issues.map((i) => i.reason)).toEqual(['REVIEW_REQUIRED', 'CONFIRMED_MATCH']);
  });

  it('шалгагдаагүй оролцогч (жнь урьдчилсан шалгалтын дараа нэмэгдсэн) → 409 AML_SCREENING_STALE (дахин оролдох боломжтой)', () => {
    const v = evaluateAmlGate([borrower('c1'), borrower('c9', 'GUARANTOR')], [screening('c1')]);
    expect(v).toMatchObject({ ok: false, code: 'AML_SCREENING_STALE', httpStatus: 409 });
    if (v.ok) throw new Error('unreachable');
    expect(v.issues).toEqual([{ customerId: 'c9', role: 'GUARANTOR', screeningId: null, status: null, reason: 'NOT_SCREENED' }]);
  });

  it('шалгалтаас хойш харилцагчийн мэдээлэл өөрчлөгдсөн (snapshot ≠ одоогийн) → AML_SCREENING_STALE (OUTDATED)', () => {
    const v = evaluateAmlGate([borrower('c1', 'PRIMARY', 0.5)], [screening('c1')]);
    expect(v).toMatchObject({ ok: false, code: 'AML_SCREENING_STALE' });
    if (v.ok) throw new Error('unreachable');
    expect(v.issues[0]).toMatchObject({ customerId: 'c1', reason: 'OUTDATED' });
  });

  it('RACE: kyc дуудлагын ЯВЦАД засагдсан (засвар < хадгалсан цаг) ч snapshot зөрүүтэй тул OUTDATED — цагийн дараалалд найдахгүй', () => {
    // уншсан updated_at = 48ц өмнө → kyc дуудаж байх зуур 1 мин өмнө засагдсан → мөр одоо хадгалагдсан
    const v = evaluateAmlGate([{ ...borrower('c1'), customerUpdatedAt: new Date(NOW.getTime() - 60_000) }], [screening('c1', { customerUpdatedAt: at(48 * HOUR) })]);
    expect(v).toMatchObject({ ok: false, code: 'AML_SCREENING_STALE', httpStatus: 409 });
  });

  it('блоклох нь хуучралтаас давамгайлна (тодорхой шалтгааныг эхэлж харуулна)', () => {
    const v = evaluateAmlGate([borrower('c1'), borrower('c2', 'CO_BORROWER')], [screening('c1', { status: 'REVIEW_REQUIRED', blocking: true })]);
    expect(v).toMatchObject({ ok: false, code: 'AML_REVIEW_REQUIRED' });
  });

  it('нэг харилцагч хоёр дүрд (PRIMARY + PLEDGOR) — нэг шалгалт хоёуланг нь хамарна', () => {
    expect(evaluateAmlGate([borrower('c1'), borrower('c1', 'PLEDGOR')], [screening('c1')])).toEqual({ ok: true });
  });
});

describe('uniqueSubjects', () => {
  it('харилцагчийг нэг удаа, эхний (PRIMARY-ийг тэргүүлсэн) дүрээр буцаана', () => {
    const out = uniqueSubjects([borrower('c2', 'PLEDGOR'), borrower('c1', 'GUARANTOR'), borrower('c2', 'PRIMARY')]);
    expect(out.map((b) => [b.customerId, b.role])).toEqual([['c2', 'PRIMARY'], ['c1', 'GUARANTOR']]);
  });
});

describe('toAmlSubject', () => {
  it('хувь хүн: овог, нэр, төрсөн огноо (YYYY-MM-DD), PEP, холбоотой этгээд; AmlSubject схемд нийцнэ', () => {
    const s = toAmlSubject({ customerType: 'INDIVIDUAL', lastName: 'Дашдорж', firstName: 'Номин', birthDate: new Date('1990-05-04T00:00:00Z'), isPep: true, isRelatedParty: false }, 'УБ90000001');
    expect(s).toEqual({ subjectType: 'INDIVIDUAL', registerNo: 'УБ90000001', lastName: 'Дашдорж', firstName: 'Номин', birthDate: '1990-05-04', isPep: true, isRelatedParty: false });
    expect(AmlSubject.safeParse(s).success).toBe(true);
  });
  it('хуулийн этгээд: төрсөн огноо, овог дамжуулахгүй', () => {
    const s = toAmlSubject({ customerType: 'LEGAL_ENTITY', lastName: null, firstName: 'Радикс ХХК', birthDate: new Date('2010-01-01T00:00:00Z'), isPep: false, isRelatedParty: true }, '5012345');
    expect(s).toEqual({ subjectType: 'LEGAL_ENTITY', registerNo: '5012345', firstName: 'Радикс ХХК', isPep: false, isRelatedParty: true });
  });
  it('хоосон/зайтай овгийг орхино', () => {
    const s = toAmlSubject({ customerType: 'INDIVIDUAL', lastName: '  ', firstName: 'Бат', birthDate: null, isPep: false, isRelatedParty: false }, 'УБ90000002');
    expect(s).not.toHaveProperty('lastName');
    expect(s).not.toHaveProperty('birthDate');
  });
});
