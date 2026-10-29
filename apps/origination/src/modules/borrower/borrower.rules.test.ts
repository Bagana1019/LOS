import { describe, expect, it } from 'vitest';
import { MAX_GUARANTEE_AMOUNT } from '@los/contracts';
import type { AddBorrowerRequest, BorrowerRole } from '@los/contracts';
import {
  checkEntityRole, checkLimit, checkPrimarySlot, checkRemovable, checkRoleCombination, checkRoleFields, checkShareTotal, computeSummary, computeWarnings, defaultIncomeIncluded,
  formatMnt, guaranteeCoverageCents, isEditableStatus, isViolation, normalizeAdd, planMakePrimary, planStepUpdates, planUpdate, primaryLiabilityShare, validateAdd,
  type BorrowerFields, type BorrowerRow, type Limits, type StepRow,
} from './borrower.rules';

const ROLES: BorrowerRole[] = ['PRIMARY', 'CO_BORROWER', 'GUARANTOR', 'PLEDGOR'];
const LIMITS: Limits = { maxCoBorrowers: 3, maxGuarantors: 3 };

let seq = 0;
function row(role: BorrowerRole, o: Partial<BorrowerRow> = {}): BorrowerRow {
  const n = ++seq;
  return {
    id: `b${n}`, customerId: `c${n}`, role, isPrimary: role === 'PRIMARY', relationToPrimary: null, liabilityShare: null, guaranteeType: null, guaranteeAmount: null,
    incomeIncluded: role === 'PRIMARY' || role === 'CO_BORROWER', note: null, consentSignedAt: null,
    customer: { displayName: `Нэр ${n}`, customerType: 'INDIVIDUAL', isPep: false, isRelatedParty: false },
    ...o,
  };
}
const fields = (o: Partial<BorrowerFields> = {}): BorrowerFields => ({ relationToPrimary: null, liabilityShare: null, guaranteeType: null, guaranteeAmount: null, incomeIncluded: false, note: null, ...o });
const code = (v: unknown) => (isViolation(v) ? v.code : null);
const NOW = new Date('2026-10-28T02:00:00Z');

describe('FR-10.4: засах боломжтой төлөв', () => {
  it('зөвхөн DRAFT ба RETURNED', () => {
    expect(['DRAFT', 'RETURNED'].map(isEditableStatus)).toEqual([true, true]);
    for (const s of ['SUBMITTED', 'IN_APPROVAL', 'APPROVED', 'DISBURSING', 'ACTIVE', 'CLOSED', 'MIGRATED', 'draft', '']) expect(isEditableStatus(s)).toBe(false);
  });
});

describe('normalizeAdd (5: анхдагч утга)', () => {
  const base = { customerId: 'c' };
  it('incomeIncluded: PRIMARY/CO=true, GUARANTOR/PLEDGOR=false', () => {
    expect(ROLES.map((role) => normalizeAdd({ ...base, role }).incomeIncluded)).toEqual([true, true, false, false]);
    expect(ROLES.map(defaultIncomeIncluded)).toEqual([true, true, false, false]);
  });
  it('өгсөн incomeIncluded-ийг хүндэлнэ', () => {
    expect(normalizeAdd({ ...base, role: 'CO_BORROWER', incomeIncluded: false }).incomeIncluded).toBe(false);
    expect(normalizeAdd({ ...base, role: 'PRIMARY', incomeIncluded: false }).incomeIncluded).toBe(false);
  });
  it('батлан даагч төрөл/дүн өгөөгүй бол бүрэн баталгаа; дүнтэй бол төрлийг нь өөрчлөхгүй', () => {
    expect(normalizeAdd({ ...base, role: 'GUARANTOR' })).toMatchObject({ guaranteeType: 'JOINT_AND_SEVERAL', guaranteeAmount: null });
    expect(normalizeAdd({ ...base, role: 'GUARANTOR', guaranteeType: 'LIMITED', guaranteeAmount: 5_000_000 })).toMatchObject({ guaranteeType: 'LIMITED', guaranteeAmount: 5_000_000 });
    expect(normalizeAdd({ ...base, role: 'GUARANTOR', guaranteeAmount: 100 } as AddBorrowerRequest).guaranteeType).toBeNull();
    expect(normalizeAdd({ ...base, role: 'CO_BORROWER' }).guaranteeType).toBeNull();
  });
  it('хувийг 4, дүнг 2 оронд бөөрөнхийлж, тэмдэглэлийг цэвэрлэнэ', () => {
    const f = normalizeAdd({ ...base, role: 'CO_BORROWER', liabilityShare: 0.33333, note: '  тэмдэглэл  ' });
    expect(f.liabilityShare).toBe(0.3333);
    expect(f.note).toBe('тэмдэглэл');
    expect(normalizeAdd({ ...base, role: 'GUARANTOR', guaranteeType: 'LIMITED', guaranteeAmount: 1234.5678 }).guaranteeAmount).toBe(1234.57);
    expect(normalizeAdd({ ...base, role: 'PLEDGOR', note: '   ' }).note).toBeNull();
  });
});

describe('checkRoleFields (5: талбарын дүрэм)', () => {
  it('liabilityShare зөвхөн CO_BORROWER', () => {
    expect(checkRoleFields('CO_BORROWER', fields({ liabilityShare: 0.5, incomeIncluded: true }))).toBeNull();
    for (const role of ['PRIMARY', 'GUARANTOR', 'PLEDGOR'] as const)
      expect(checkRoleFields(role, fields({ liabilityShare: 0.5 }))).toMatchObject({ status: 422, code: 'FIELD_NOT_ALLOWED_FOR_ROLE', details: { field: 'liabilityShare', role } });
  });
  it('guaranteeType/guaranteeAmount зөвхөн GUARANTOR', () => {
    for (const role of ['PRIMARY', 'CO_BORROWER', 'PLEDGOR'] as const) {
      expect(checkRoleFields(role, fields({ guaranteeType: 'JOINT_AND_SEVERAL' }))).toMatchObject({ code: 'FIELD_NOT_ALLOWED_FOR_ROLE', details: { field: 'guaranteeType' } });
      expect(checkRoleFields(role, fields({ guaranteeAmount: 100 }))).toMatchObject({ code: 'FIELD_NOT_ALLOWED_FOR_ROLE', details: { field: 'guaranteeAmount' } });
    }
  });
  it('relationToPrimary PRIMARY-д байхгүй, бусад дүрд зөвшөөрнө', () => {
    expect(checkRoleFields('PRIMARY', fields({ relationToPrimary: 'SPOUSE', incomeIncluded: true }))).toMatchObject({ code: 'FIELD_NOT_ALLOWED_FOR_ROLE', details: { field: 'relationToPrimary' } });
    for (const role of ['CO_BORROWER', 'GUARANTOR', 'PLEDGOR'] as const) expect(checkRoleFields(role, fields({ relationToPrimary: 'SPOUSE' }))).toBeNull();
  });
  it('GUARANTOR/PLEDGOR дээр incomeIncluded=true бол 422 INCOME_NOT_ALLOWED (BSA-BR-9)', () => {
    for (const role of ['GUARANTOR', 'PLEDGOR'] as const) expect(checkRoleFields(role, fields({ incomeIncluded: true }))).toMatchObject({ status: 422, code: 'INCOME_NOT_ALLOWED' });
    for (const role of ['PRIMARY', 'CO_BORROWER'] as const) {
      expect(checkRoleFields(role, fields({ incomeIncluded: true }))).toBeNull();
      expect(checkRoleFields(role, fields({ incomeIncluded: false }))).toBeNull();
    }
  });
  it('баталгааны төрөл/дүнгийн уялдаа', () => {
    expect(checkRoleFields('GUARANTOR', fields({ guaranteeType: 'JOINT_AND_SEVERAL' }))).toBeNull();
    expect(checkRoleFields('GUARANTOR', fields({ guaranteeType: 'LIMITED', guaranteeAmount: 1 }))).toBeNull();
    expect(checkRoleFields('GUARANTOR', fields())).toBeNull(); // төрөл тодорхойгүй хуучин мөр
    expect(checkRoleFields('GUARANTOR', fields({ guaranteeType: 'LIMITED' }))).toMatchObject({ code: 'GUARANTEE_INVALID' });
    expect(checkRoleFields('GUARANTOR', fields({ guaranteeType: 'JOINT_AND_SEVERAL', guaranteeAmount: 5 }))).toMatchObject({ code: 'GUARANTEE_INVALID' });
    expect(checkRoleFields('GUARANTOR', fields({ guaranteeAmount: 5 }))).toMatchObject({ code: 'GUARANTEE_INVALID' });
    expect(checkRoleFields('GUARANTOR', fields({ guaranteeType: 'LIMITED', guaranteeAmount: 0.004 }))).toMatchObject({ code: 'GUARANTEE_INVALID' }); // 2 оронд 0 болно
  });
  it('баталгааны дүн төгсгөлөг, дээд хязгаарт багтсан байх (Infinity/NaN/≥1e16 нь DB-д NULL эсвэл overflow болдог)', () => {
    for (const guaranteeAmount of [Infinity, -Infinity, NaN, MAX_GUARANTEE_AMOUNT + 0.01, 1e13, 1e15, 1e16, 1e17, Number.MAX_VALUE])
      expect(checkRoleFields('GUARANTOR', fields({ guaranteeType: 'LIMITED', guaranteeAmount })), String(guaranteeAmount)).toMatchObject({ status: 422, code: 'GUARANTEE_INVALID' });
    for (const guaranteeAmount of [0.01, 1, 1_000_000, MAX_GUARANTEE_AMOUNT])
      expect(checkRoleFields('GUARANTOR', fields({ guaranteeType: 'LIMITED', guaranteeAmount })), String(guaranteeAmount)).toBeNull();
  });
  it('planUpdate: Infinity / хэт том дүнг PATCH-ээр ч хүлээн авахгүй, мөр өөрчлөгдөхгүй', () => {
    const g = row('GUARANTOR', { guaranteeType: 'LIMITED', guaranteeAmount: 1000, incomeIncluded: false });
    for (const guaranteeAmount of [Infinity, NaN, 1e16, 1e17]) expect(code(planUpdate(g, { guaranteeAmount }, [])), String(guaranteeAmount)).toBe('GUARANTEE_INVALID');
    expect(code(planUpdate(g, { guaranteeAmount: MAX_GUARANTEE_AMOUNT }, []))).toBeNull();
  });
});

describe('checkEntityRole (6)', () => {
  it('хуулийн этгээд CO_BORROWER байж болохгүй, бусад дүрд болно', () => {
    expect(checkEntityRole('LEGAL_ENTITY', 'CO_BORROWER')).toMatchObject({ status: 422, code: 'ENTITY_CANNOT_CO_BORROW' });
    for (const role of ['PRIMARY', 'GUARANTOR', 'PLEDGOR'] as const) expect(checkEntityRole('LEGAL_ENTITY', role)).toBeNull();
    for (const role of ROLES) expect(checkEntityRole('INDIVIDUAL', role)).toBeNull();
  });
});

describe('checkRoleCombination (3): давхардал ба дүрийн хослол', () => {
  it('хоосон үед зөвшөөрнө', () => {
    for (const role of ROLES) expect(checkRoleCombination([], role)).toBeNull();
  });
  it('ижил дүр → BORROWER_DUPLICATE', () => {
    for (const role of ROLES) expect(checkRoleCombination([role], role)).toMatchObject({ status: 409, code: 'BORROWER_DUPLICATE' });
  });
  // Хослол бүр: зөвхөн PLEDGOR нь бусадтай хамт байж болно.
  const allowed = new Set(['PRIMARY+PLEDGOR', 'CO_BORROWER+PLEDGOR', 'GUARANTOR+PLEDGOR']);
  for (const a of ROLES) for (const b of ROLES) {
    if (a === b) continue;
    const ok = allowed.has(`${a}+${b}`) || allowed.has(`${b}+${a}`);
    it(`${a} байхад ${b} нэмэх → ${ok ? 'болно' : 'ROLE_CONFLICT'}`, () => {
      const v = checkRoleCombination([a], b);
      if (ok) expect(v).toBeNull(); else expect(v).toMatchObject({ status: 409, code: 'ROLE_CONFLICT' });
    });
  }
  it('PRIMARY+PLEDGOR байхад CO_BORROWER нэмэх → PRIMARY-тай зөрчилдөнө; PLEDGOR давхардал', () => {
    expect(checkRoleCombination(['PRIMARY', 'PLEDGOR'], 'CO_BORROWER')).toMatchObject({ code: 'ROLE_CONFLICT', details: { existingRole: 'PRIMARY' } });
    expect(checkRoleCombination(['PRIMARY', 'PLEDGOR'], 'PLEDGOR')).toMatchObject({ code: 'BORROWER_DUPLICATE' });
  });
});

describe('checkPrimarySlot (2)', () => {
  it('хоёр дахь PRIMARY → PRIMARY_EXISTS; бусад дүр нөлөөлөхгүй', () => {
    expect(checkPrimarySlot([], 'PRIMARY')).toBeNull();
    expect(checkPrimarySlot([row('CO_BORROWER'), row('GUARANTOR')], 'PRIMARY')).toBeNull();
    expect(checkPrimarySlot([row('PRIMARY')], 'PRIMARY')).toMatchObject({ status: 409, code: 'PRIMARY_EXISTS' });
    expect(checkPrimarySlot([row('PRIMARY')], 'CO_BORROWER')).toBeNull();
  });
});

describe('checkLimit (4)', () => {
  const many = (role: BorrowerRole, n: number) => Array.from({ length: n }, () => row(role));
  it('CO_BORROWER ба GUARANTOR хязгаарт хүрвэл LIMIT_EXCEEDED', () => {
    expect(checkLimit(many('CO_BORROWER', 2), 'CO_BORROWER', LIMITS)).toBeNull();
    expect(checkLimit(many('CO_BORROWER', 3), 'CO_BORROWER', LIMITS)).toMatchObject({ status: 409, code: 'LIMIT_EXCEEDED', details: { role: 'CO_BORROWER', limit: 3 } });
    expect(checkLimit(many('GUARANTOR', 2), 'GUARANTOR', LIMITS)).toBeNull();
    expect(checkLimit(many('GUARANTOR', 3), 'GUARANTOR', LIMITS)).toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });
  it('хязгаарууд тусдаа; хязгаар 0 бол үргэлж хэтэрнэ', () => {
    expect(checkLimit(many('GUARANTOR', 3), 'CO_BORROWER', LIMITS)).toBeNull();
    expect(checkLimit([], 'CO_BORROWER', { maxCoBorrowers: 0, maxGuarantors: 3 })).toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect(checkLimit(many('CO_BORROWER', 1), 'CO_BORROWER', { maxCoBorrowers: 1, maxGuarantors: 3 })).toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });
  it('PLEDGOR ба PRIMARY хязгааргүй', () => {
    expect(checkLimit(many('PLEDGOR', 50), 'PLEDGOR', { maxCoBorrowers: 0, maxGuarantors: 0 })).toBeNull();
    expect(checkLimit([], 'PRIMARY', { maxCoBorrowers: 0, maxGuarantors: 0 })).toBeNull();
  });
});

describe('checkShareTotal (5)', () => {
  const co = (liabilityShare: number | null) => ({ role: 'CO_BORROWER' as const, liabilityShare });
  it('нийлбэр ≤ 1 бол зөвшөөрнө (хөвөгч таслалгүй: 0.1 × 10 = 1)', () => {
    expect(checkShareTotal([co(0.6), co(0.4)])).toBeNull();
    expect(checkShareTotal(Array.from({ length: 10 }, () => co(0.1)))).toBeNull();
    expect(checkShareTotal([co(0.7), co(0.2), co(0.1)])).toBeNull();
    expect(checkShareTotal([co(null), co(null)])).toBeNull();
  });
  it('1-ээс хэтэрвэл 422 LIABILITY_SHARE_EXCEEDED', () => {
    expect(checkShareTotal([co(0.6), co(0.5)])).toMatchObject({ status: 422, code: 'LIABILITY_SHARE_EXCEEDED', details: { total: 1.1 } });
    expect(checkShareTotal([co(0.5001), co(0.5)])).toMatchObject({ code: 'LIABILITY_SHARE_EXCEEDED' });
  });
  it('CO биш дүрийн хувийг тооцохгүй', () => {
    expect(checkShareTotal([{ role: 'PRIMARY', liabilityShare: 0.9 }, co(0.5)])).toBeNull();
  });
});

describe('validateAdd — шалгалтын дараалал', () => {
  const existing = [row('PRIMARY', { customerId: 'p' }), row('CO_BORROWER', { customerId: 'co1', liabilityShare: 0.8 })];
  const f = fields();
  it('хуулийн этгээд CO → 422 (давхардлаас өмнө)', () => {
    expect(validateAdd({ role: 'CO_BORROWER', customerId: 'co1', customerType: 'LEGAL_ENTITY', fields: f, existing, limits: LIMITS })).toMatchObject({ code: 'ENTITY_CANNOT_CO_BORROW' });
  });
  it('давхардал → хослол → үндсэн → хязгаар → хувь', () => {
    expect(code(validateAdd({ role: 'CO_BORROWER', customerId: 'co1', customerType: 'INDIVIDUAL', fields: f, existing, limits: LIMITS }))).toBe('BORROWER_DUPLICATE');
    expect(code(validateAdd({ role: 'GUARANTOR', customerId: 'co1', customerType: 'INDIVIDUAL', fields: f, existing, limits: LIMITS }))).toBe('ROLE_CONFLICT');
    expect(code(validateAdd({ role: 'PRIMARY', customerId: 'new', customerType: 'INDIVIDUAL', fields: f, existing, limits: LIMITS }))).toBe('PRIMARY_EXISTS');
    expect(code(validateAdd({ role: 'CO_BORROWER', customerId: 'new', customerType: 'INDIVIDUAL', fields: fields({ liabilityShare: 0.3 }), existing, limits: { maxCoBorrowers: 1, maxGuarantors: 3 } }))).toBe('LIMIT_EXCEEDED');
    expect(code(validateAdd({ role: 'CO_BORROWER', customerId: 'new', customerType: 'INDIVIDUAL', fields: fields({ liabilityShare: 0.3 }), existing, limits: LIMITS }))).toBe('LIABILITY_SHARE_EXCEEDED');
    expect(validateAdd({ role: 'CO_BORROWER', customerId: 'new', customerType: 'INDIVIDUAL', fields: fields({ liabilityShare: 0.2 }), existing, limits: LIMITS })).toBeNull();
  });
  it('PLEDGOR нь PRIMARY-тай хамт байж болно', () => {
    expect(validateAdd({ role: 'PLEDGOR', customerId: 'p', customerType: 'INDIVIDUAL', fields: f, existing, limits: LIMITS })).toBeNull();
  });
});

describe('planUpdate (засах)', () => {
  it('өөрчлөлтгүй бол changed хоосон (idempotent)', () => {
    const r = row('CO_BORROWER', { liabilityShare: 0.4, note: 'a', relationToPrimary: 'SPOUSE' });
    const plan = planUpdate(r, { liabilityShare: 0.4, note: 'a', relationToPrimary: 'SPOUSE', incomeIncluded: true }, []);
    expect(plan).toMatchObject({ changed: [], compositionChanged: false });
  });
  it('null нь арилгана, undefined нь хэвээр үлдээнэ', () => {
    const r = row('CO_BORROWER', { liabilityShare: 0.4, note: 'a', relationToPrimary: 'SPOUSE' });
    const plan = planUpdate(r, { note: null, liabilityShare: undefined }, []);
    expect(isViolation(plan)).toBe(false);
    if (!isViolation(plan)) {
      expect(plan.changed).toEqual(['note']);
      expect(plan.next).toMatchObject({ note: null, liabilityShare: 0.4, relationToPrimary: 'SPOUSE' });
    }
  });
  it('compositionChanged: PRIMARY/CO-ийн incomeIncluded ба liabilityShare л', () => {
    const co = row('CO_BORROWER', { liabilityShare: 0.4 });
    expect(planUpdate(co, { incomeIncluded: false }, [])).toMatchObject({ compositionChanged: true });
    expect(planUpdate(co, { liabilityShare: 0.5 }, [])).toMatchObject({ compositionChanged: true });
    expect(planUpdate(co, { note: 'x', relationToPrimary: 'FRIEND' }, [])).toMatchObject({ compositionChanged: false });
    const g = row('GUARANTOR', { guaranteeType: 'JOINT_AND_SEVERAL' });
    expect(planUpdate(g, { note: 'x' }, [])).toMatchObject({ compositionChanged: false });
  });
  it('дүрд хамаарахгүй талбар / орлого / баталгаа → 422', () => {
    const g = row('GUARANTOR', { guaranteeType: 'JOINT_AND_SEVERAL' });
    expect(code(planUpdate(g, { liabilityShare: 0.1 }, []))).toBe('FIELD_NOT_ALLOWED_FOR_ROLE');
    expect(code(planUpdate(g, { incomeIncluded: true }, []))).toBe('INCOME_NOT_ALLOWED');
    expect(code(planUpdate(g, { guaranteeType: 'LIMITED' }, []))).toBe('GUARANTEE_INVALID');
    expect(code(planUpdate(row('PRIMARY'), { relationToPrimary: 'SPOUSE' }, []))).toBe('FIELD_NOT_ALLOWED_FOR_ROLE');
    expect(code(planUpdate(row('CO_BORROWER'), { guaranteeType: 'LIMITED', guaranteeAmount: 5 }, []))).toBe('FIELD_NOT_ALLOWED_FOR_ROLE');
  });
  it('баталгааг бүрэн болгоход дүнг автоматаар арилгана; LIMITED болгоход дүн шаардана', () => {
    const lim = row('GUARANTOR', { guaranteeType: 'LIMITED', guaranteeAmount: 5_000_000 });
    const plan = planUpdate(lim, { guaranteeType: 'JOINT_AND_SEVERAL' }, []);
    expect(isViolation(plan)).toBe(false);
    if (!isViolation(plan)) expect(plan.next).toMatchObject({ guaranteeType: 'JOINT_AND_SEVERAL', guaranteeAmount: null });
    const js = row('GUARANTOR', { guaranteeType: 'JOINT_AND_SEVERAL' });
    expect(code(planUpdate(js, { guaranteeType: 'LIMITED' }, []))).toBe('GUARANTEE_INVALID');
    expect(isViolation(planUpdate(js, { guaranteeType: 'LIMITED', guaranteeAmount: 3_000_000 }, []))).toBe(false);
  });
  it('хувийн нийлбэр хэтэрвэл 422', () => {
    const other = row('CO_BORROWER', { liabilityShare: 0.6 });
    const me = row('CO_BORROWER', { liabilityShare: 0.3 });
    expect(code(planUpdate(me, { liabilityShare: 0.5 }, [other]))).toBe('LIABILITY_SHARE_EXCEEDED');
    expect(isViolation(planUpdate(me, { liabilityShare: 0.4 }, [other]))).toBe(false);
  });
});

describe('checkRemovable (2, 10)', () => {
  it('PRIMARY: бусад оролцогч байвал PRIMARY_REQUIRED, ганц бол болно', () => {
    const p = row('PRIMARY');
    expect(checkRemovable(p, [p], false)).toBeNull();
    for (const role of ROLES.filter((r) => r !== 'PRIMARY')) expect(checkRemovable(p, [p, row(role)], false)).toMatchObject({ status: 409, code: 'PRIMARY_REQUIRED' });
  });
  it('PLEDGOR: барьцаа өмчилдөг бол BORROWER_OWNS_COLLATERAL', () => {
    const pl = row('PLEDGOR');
    expect(checkRemovable(pl, [row('PRIMARY'), pl], true)).toMatchObject({ status: 409, code: 'BORROWER_OWNS_COLLATERAL' });
    expect(checkRemovable(pl, [row('PRIMARY'), pl], false)).toBeNull();
  });
  it('хамтран зээлдэгч барьцаа өмчилдөг бол мөн BORROWER_OWNS_COLLATERAL; барьцаагүй бол чөлөөтэй хасагдана', () => {
    const rows = [row('PRIMARY'), row('CO_BORROWER'), row('GUARANTOR')];
    expect(checkRemovable(rows[1], rows, true)).toMatchObject({ status: 409, code: 'BORROWER_OWNS_COLLATERAL' });
    expect(checkRemovable(rows[1], rows, false)).toBeNull();
    expect(checkRemovable(rows[2], rows, false)).toBeNull();
  });
});

describe('planMakePrimary (2)', () => {
  it('аль хэдийн үндсэн бол noop', () => {
    const p = row('PRIMARY');
    expect(planMakePrimary([p, row('CO_BORROWER')], p.id)).toMatchObject({ noop: true });
  });
  it('зөвхөн CO_BORROWER-г дэвшүүлнэ', () => {
    const rows = [row('PRIMARY'), row('GUARANTOR'), row('PLEDGOR')];
    expect(planMakePrimary(rows, rows[1].id)).toMatchObject({ status: 409, code: 'NOT_CO_BORROWER' });
    expect(planMakePrimary(rows, rows[2].id)).toMatchObject({ status: 409, code: 'NOT_CO_BORROWER' });
  });
  it('одоогийн үндсэн хамтран зээлдэгч болно; хувь тогтоогоогүй бол null', () => {
    const p = row('PRIMARY'); const co = row('CO_BORROWER');
    expect(planMakePrimary([p, co], co.id)).toEqual({ noop: false, promoteId: co.id, demote: { id: p.id, liabilityShare: null } });
  });
  it('хувь тогтоосон бол хуваарь хадгалагдана: хуучин үндсэн = 1 − ΣCO', () => {
    const p = row('PRIMARY'); const co1 = row('CO_BORROWER', { liabilityShare: 0.4 }); const co2 = row('CO_BORROWER', { liabilityShare: 0.2 });
    const plan = planMakePrimary([p, co1, co2], co1.id);
    expect(plan).toEqual({ noop: false, promoteId: co1.id, demote: { id: p.id, liabilityShare: 0.4 } }); // үндсэн: 1 − 0.6 = 0.4
    // шалгалт: шинэ хамтран зээлдэгчид 0.4 + 0.2 = 0.6 → шинэ үндсэний үлдэгдэл 0.4 = co1-ийн хуучин хувь
  });
  it('үлдэгдэл 0 эсвэл дэвшүүлэгдэгчийн хувь тодорхойгүй бол хувь null', () => {
    const p = row('PRIMARY'); const full = row('CO_BORROWER', { liabilityShare: 1 });
    expect(planMakePrimary([p, full], full.id)).toMatchObject({ demote: { liabilityShare: null } });
    const a = row('CO_BORROWER'); const b = row('CO_BORROWER', { liabilityShare: 0.3 });
    expect(planMakePrimary([p, a, b], a.id)).toMatchObject({ demote: { liabilityShare: null } });
  });
  it('үндсэн байхгүй үед шууд дэвшүүлнэ', () => {
    const co = row('CO_BORROWER');
    expect(planMakePrimary([co, row('GUARANTOR')], co.id)).toEqual({ noop: false, promoteId: co.id, demote: null });
  });
  it('үндсэн нь хуулийн этгээд бол хамтран зээлдэгч болж чадахгүй → 422', () => {
    const p = row('PRIMARY', { customer: { displayName: 'ХХК', customerType: 'LEGAL_ENTITY', isPep: false, isRelatedParty: false } });
    const co = row('CO_BORROWER');
    expect(planMakePrimary([p, co], co.id)).toMatchObject({ status: 422, code: 'ENTITY_CANNOT_CO_BORROW' });
  });
});

describe('guaranteeCoverageCents / computeSummary (12)', () => {
  const g = (o: Partial<BorrowerRow>) => row('GUARANTOR', o);
  it('JOINT_AND_SEVERAL = зээлийн бүтэн дүн, LIMITED = заасан дүн', () => {
    expect(guaranteeCoverageCents([], 1_000_000_00)).toBe(0);
    expect(guaranteeCoverageCents([g({ guaranteeType: 'JOINT_AND_SEVERAL' })], 1_000_00)).toBe(1_000_00);
    expect(guaranteeCoverageCents([g({ guaranteeType: 'LIMITED', guaranteeAmount: 300 }), g({ guaranteeType: 'LIMITED', guaranteeAmount: 200.5 })], 1_000_00)).toBe(50_050);
    expect(guaranteeCoverageCents([g({ guaranteeType: 'JOINT_AND_SEVERAL' })], null)).toBeNull();
    expect(guaranteeCoverageCents([g({ guaranteeType: 'LIMITED', guaranteeAmount: 300 })], null)).toBe(30_000);
    expect(guaranteeCoverageCents([g({})], 500_00)).toBe(500_00); // төрөл ба дүн хоёулаа байхгүй хуучин мөр = бүрэн
    expect(guaranteeCoverageCents([row('CO_BORROWER'), row('PLEDGOR')], 500_00)).toBe(0);
  });

  it('тоо, income contributor (давхардалгүй), editable, хязгаар', () => {
    const p = row('PRIMARY', { customerId: 'A' });
    const rows = [p, row('PLEDGOR', { customerId: 'A' }), row('CO_BORROWER', { customerId: 'B' }), row('CO_BORROWER', { customerId: 'C', incomeIncluded: false }), g({ customerId: 'D' }), row('PLEDGOR', { customerId: 'E' })];
    const s = computeSummary({ rows, loanAmount: 10_000_000, limits: LIMITS, status: 'DRAFT' });
    expect(s).toMatchObject({ primaryCount: 1, coBorrowerCount: 2, guarantorCount: 1, pledgorCount: 2, clientStepComplete: true, editable: true, limits: LIMITS });
    expect(s.incomeContributorCustomerIds).toEqual(['A', 'B']);
    expect(computeSummary({ rows, loanAmount: 10_000_000, limits: LIMITS, status: 'SUBMITTED' }).editable).toBe(false);
    expect(computeSummary({ rows: [], loanAmount: 1, limits: LIMITS, status: 'RETURNED' })).toMatchObject({ clientStepComplete: false, primaryCount: 0, editable: true, incomeContributorCustomerIds: [], guaranteeCoverageRatio: 0 });
  });

  it('guaranteeCoverageRatio = Σ ÷ amount; amount байхгүй/0 бол null', () => {
    const lim = (amt: number) => g({ guaranteeType: 'LIMITED', guaranteeAmount: amt });
    expect(computeSummary({ rows: [lim(2_500_000)], loanAmount: 10_000_000, limits: LIMITS, status: 'DRAFT' }).guaranteeCoverageRatio).toBe(0.25);
    expect(computeSummary({ rows: [lim(1_000_000), lim(2_333_333)], loanAmount: 10_000_000, limits: LIMITS, status: 'DRAFT' }).guaranteeCoverageRatio).toBe(0.3333);
    expect(computeSummary({ rows: [g({ guaranteeType: 'JOINT_AND_SEVERAL' }), lim(5_000_000)], loanAmount: 10_000_000, limits: LIMITS, status: 'DRAFT' }).guaranteeCoverageRatio).toBe(1.5);
    expect(computeSummary({ rows: [lim(1)], loanAmount: null, limits: LIMITS, status: 'DRAFT' }).guaranteeCoverageRatio).toBeNull();
    expect(computeSummary({ rows: [lim(1)], loanAmount: 0, limits: LIMITS, status: 'DRAFT' }).guaranteeCoverageRatio).toBeNull();
  });

  it('primaryLiabilityShare = 1 − ΣCO; хувь тогтоогоогүй эсвэл үндсэн байхгүй бол null', () => {
    const p = row('PRIMARY');
    expect(primaryLiabilityShare([p, row('CO_BORROWER', { liabilityShare: 0.35 })])).toBe(0.65);
    expect(primaryLiabilityShare([p, row('CO_BORROWER', { liabilityShare: 1 })])).toBe(0);
    expect(primaryLiabilityShare([p, row('CO_BORROWER')])).toBeNull();
    expect(primaryLiabilityShare([row('CO_BORROWER', { liabilityShare: 0.5 })])).toBeNull();
    expect(primaryLiabilityShare([p])).toBeNull();
  });
});

describe('computeWarnings (7; BR-9)', () => {
  const none = { loanAmount: 10_000_000, hits: [] };
  const codes = (rows: BorrowerRow[], extra: Partial<Parameters<typeof computeWarnings>[0]> = {}) => computeWarnings({ rows, ...none, ...extra }).map((w) => w.code);

  it('цэвэр жагсаалтад CONSENT_MISSING-аас бусад анхааруулга байхгүй', () => {
    expect(codes([row('PRIMARY'), row('PLEDGOR')])).toEqual([]);
  });
  it('BLACKLISTED: орц бүрт нэг анхааруулга, details-д reasonCode/listType', () => {
    const p = row('PRIMARY', { customerId: 'A' });
    const w = computeWarnings({ rows: [p, row('PLEDGOR', { customerId: 'A' })], ...none, hits: [{ customerId: 'A', reasonCode: 'FRAUD', listType: 'INTERNAL' }, { customerId: 'A', reasonCode: 'OVERDUE', listType: 'SHARED' }, { customerId: 'ZZ', reasonCode: 'X', listType: 'Y' }] });
    expect(w).toHaveLength(2);
    expect(w[0]).toMatchObject({ code: 'BLACKLISTED', customerId: 'A', details: { reasonCode: 'FRAUD', listType: 'INTERNAL', roles: ['PRIMARY', 'PLEDGOR'] } });
    expect(w[0].message).toContain('хориглохгүй');
    expect(w[1].details).toMatchObject({ reasonCode: 'OVERDUE' });
  });
  it('PEP ба RELATED_PARTY: харилцагч тутамд нэг удаа (хоёр дүртэй байсан ч)', () => {
    const c = { displayName: 'Бат', customerType: 'INDIVIDUAL' as const, isPep: true, isRelatedParty: true };
    const w = computeWarnings({ rows: [row('PRIMARY', { customerId: 'A', customer: c }), row('PLEDGOR', { customerId: 'A', customer: c })], ...none });
    expect(w.map((x) => x.code)).toEqual(['PEP', 'RELATED_PARTY']);
    expect(w.every((x) => x.customerId === 'A')).toBe(true);
  });
  it('CONSENT_MISSING: зөвхөн CO_BORROWER ба GUARANTOR-д, зөвшөөрөлтэй бол үгүй', () => {
    const rows = [row('PRIMARY'), row('CO_BORROWER'), row('GUARANTOR', { guaranteeType: 'JOINT_AND_SEVERAL' }), row('PLEDGOR')];
    const w = computeWarnings({ rows, ...none }).filter((x) => x.code === 'CONSENT_MISSING');
    expect(w.map((x) => x.details?.role)).toEqual(['CO_BORROWER', 'GUARANTOR']);
    const signed = rows.map((r) => ({ ...r, consentSignedAt: NOW }));
    expect(codes(signed)).toEqual([]);
  });
  it('GUARANTEE_BELOW_LOAN: LIMITED нийлбэр < дүн үед; бүрэн баталгаа эсвэл хүрсэн бол үгүй; батлан даагчгүй бол үгүй', () => {
    const ok = { consentSignedAt: NOW };
    const lim = (amt: number) => row('GUARANTOR', { ...ok, guaranteeType: 'LIMITED', guaranteeAmount: amt });
    const w = computeWarnings({ rows: [lim(4_000_000), lim(5_000_000)], ...none });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ code: 'GUARANTEE_BELOW_LOAN', customerId: null, details: { covered: 9_000_000, loanAmount: 10_000_000, shortfall: 1_000_000 } });
    expect(w[0].message).toContain('9,000,000₮');
    expect(codes([lim(4_000_000), lim(6_000_000)])).toEqual([]);
    expect(codes([lim(1), row('GUARANTOR', { ...ok, guaranteeType: 'JOINT_AND_SEVERAL' })])).toEqual([]);
    expect(codes([row('PRIMARY')])).toEqual([]);
    expect(codes([lim(1)], { loanAmount: null })).toEqual([]);
  });
  it('LIABILITY_SHARE_INCOMPLETE: хувь тогтоосон ба тогтоогоогүй хамтран зээлдэгч хамт байвал', () => {
    const ok = { consentSignedAt: NOW };
    const p = row('PRIMARY');
    expect(codes([p, row('CO_BORROWER', { ...ok, liabilityShare: 0.4 })])).toEqual([]); // үндсэн = үлдэгдэл 0.6
    expect(codes([p, row('CO_BORROWER', { ...ok, liabilityShare: 0.4 }), row('CO_BORROWER', ok)])).toEqual(['LIABILITY_SHARE_INCOMPLETE']);
    expect(codes([p, row('CO_BORROWER', ok), row('CO_BORROWER', ok)])).toEqual([]); // хамтын хариуцлага
    const co = row('CO_BORROWER', { ...ok, liabilityShare: 0.4 }); const co2 = row('CO_BORROWER', ok);
    const w = computeWarnings({ rows: [p, co, co2], ...none });
    expect(w[0]).toMatchObject({ customerId: null, details: { specifiedTotal: 0.4, missingCustomerIds: [co2.customerId] } });
  });
  it('LIABILITY_SHARE_INCOMPLETE: үндсэнгүй үед нийлбэр ≠ 1 бол', () => {
    const ok = { consentSignedAt: NOW };
    expect(codes([row('CO_BORROWER', { ...ok, liabilityShare: 0.5 })])).toEqual(['LIABILITY_SHARE_INCOMPLETE']);
    expect(codes([row('CO_BORROWER', { ...ok, liabilityShare: 0.5 }), row('CO_BORROWER', { ...ok, liabilityShare: 0.5 })])).toEqual([]);
  });
  it('анхааруулгын дараалал тогтвортой', () => {
    const c = { displayName: 'Бат', customerType: 'INDIVIDUAL' as const, isPep: true, isRelatedParty: true };
    const p = row('PRIMARY', { customerId: 'A', customer: c });
    const g = row('GUARANTOR', { guaranteeType: 'LIMITED', guaranteeAmount: 1 });
    const co1 = row('CO_BORROWER', { liabilityShare: 0.3 }); const co2 = row('CO_BORROWER');
    const w = computeWarnings({ rows: [p, co1, co2, g], loanAmount: 100, hits: [{ customerId: 'A', reasonCode: 'R', listType: 'L' }] });
    expect(w.map((x) => x.code)).toEqual(['BLACKLISTED', 'PEP', 'RELATED_PARTY', 'CONSENT_MISSING', 'CONSENT_MISSING', 'CONSENT_MISSING', 'GUARANTEE_BELOW_LOAN', 'LIABILITY_SHARE_INCOMPLETE']);
  });
});

describe('formatMnt', () => {
  it('мянгатын таслалтай', () => {
    expect(formatMnt(0)).toBe('0');
    expect(formatMnt(999)).toBe('999');
    expect(formatMnt(1_234_567)).toBe('1,234,567');
    expect(formatMnt(1_234_567.5)).toBe('1,234,567.50');
  });
});

describe('planStepUpdates (8): алхамын матриц', () => {
  const steps = (o: Record<string, string> = {}, reason: Record<string, string | null> = {}): StepRow[] =>
    ['client', 'inquiry', 'income', 'loan', 'score'].map((k) => ({ id: `s-${k}`, stepKey: k, status: o[k] ?? 'PENDING', staleReason: reason[k] ?? null }));
  const idle = { hasPrimary: true, borrowerAdded: false, compositionChanged: false };

  it('client: ≥1 PRIMARY → COMPLETED (completedAt), PRIMARY байхгүй → PENDING', () => {
    expect(planStepUpdates(steps(), { ...idle, hasPrimary: true }, NOW)).toEqual([{ id: 's-client', stepKey: 'client', status: 'COMPLETED', completedAt: NOW, staleReason: null }]);
    expect(planStepUpdates(steps({ client: 'COMPLETED' }), { ...idle, hasPrimary: false }, NOW)).toEqual([{ id: 's-client', stepKey: 'client', status: 'PENDING', completedAt: null, staleReason: null }]);
  });
  it('client: байдал өөрчлөгдөхгүй бол шинэчлэхгүй (completedAt хэвээр)', () => {
    expect(planStepUpdates(steps({ client: 'COMPLETED' }), idle, NOW)).toEqual([]);
    expect(planStepUpdates(steps({ client: 'PENDING' }), { ...idle, hasPrimary: false }, NOW)).toEqual([]);
  });
  it('client STALE байсан бол дахин тооцоолно', () => {
    expect(planStepUpdates(steps({ client: 'STALE' }), idle, NOW)).toMatchObject([{ stepKey: 'client', status: 'COMPLETED' }]);
  });
  it('inquiry: оролцогч нэмэгдсэн ба COMPLETED бол PENDING + BORROWER_ADDED', () => {
    expect(planStepUpdates(steps({ client: 'COMPLETED', inquiry: 'COMPLETED' }), { ...idle, borrowerAdded: true }, NOW))
      .toEqual([{ id: 's-inquiry', stepKey: 'inquiry', status: 'PENDING', completedAt: null, staleReason: 'BORROWER_ADDED' }]);
  });
  it('inquiry: нэмэгдээгүй, эсвэл COMPLETED биш бол хөндөхгүй', () => {
    expect(planStepUpdates(steps({ client: 'COMPLETED', inquiry: 'COMPLETED' }), idle, NOW)).toEqual([]);
    for (const status of ['PENDING', 'STALE', 'LOCKED']) expect(planStepUpdates(steps({ client: 'COMPLETED', inquiry: status }), { ...idle, borrowerAdded: true }, NOW)).toEqual([]);
  });
  it('income, score: бүрдэл өөрчлөгдсөн ба COMPLETED бол STALE + BORROWERS_CHANGED (completedAt хөндөхгүй)', () => {
    const u = planStepUpdates(steps({ client: 'COMPLETED', income: 'COMPLETED', score: 'COMPLETED', loan: 'COMPLETED' }), { ...idle, compositionChanged: true }, NOW);
    expect(u).toEqual([
      { id: 's-income', stepKey: 'income', status: 'STALE', staleReason: 'BORROWERS_CHANGED' },
      { id: 's-score', stepKey: 'score', status: 'STALE', staleReason: 'BORROWERS_CHANGED' },
    ]);
    expect(u.every((x) => !('completedAt' in x))).toBe(true); // loan алхмыг хөндөөгүй
  });
  it('income/score: бүрдэл өөрчлөгдөөгүй, эсвэл COMPLETED биш бол хөндөхгүй', () => {
    expect(planStepUpdates(steps({ client: 'COMPLETED', income: 'COMPLETED', score: 'COMPLETED' }), idle, NOW)).toEqual([]);
    for (const status of ['PENDING', 'STALE', 'LOCKED']) expect(planStepUpdates(steps({ client: 'COMPLETED', income: status, score: status }), { ...idle, compositionChanged: true }, NOW)).toEqual([]);
  });
  it('LOCKED мөрийг хөндөхгүй (client-ийг ч); мөр байхгүй бол алгасна', () => {
    expect(planStepUpdates(steps({ client: 'LOCKED' }), idle, NOW)).toEqual([]);
    expect(planStepUpdates([], { hasPrimary: true, borrowerAdded: true, compositionChanged: true }, NOW)).toEqual([]);
    expect(planStepUpdates([{ id: 'x', stepKey: 'loan', status: 'COMPLETED', staleReason: null }], { hasPrimary: true, borrowerAdded: true, compositionChanged: true }, NOW)).toEqual([]);
  });
  it('нэг дор олон алхам (PRIMARY нэмэх)', () => {
    const u = planStepUpdates(steps({ client: 'PENDING', inquiry: 'COMPLETED', income: 'COMPLETED', score: 'COMPLETED' }), { hasPrimary: true, borrowerAdded: true, compositionChanged: true }, NOW);
    expect(u.map((x) => `${x.stepKey}:${x.status}`)).toEqual(['client:COMPLETED', 'inquiry:PENDING', 'income:STALE', 'score:STALE']);
  });
});
