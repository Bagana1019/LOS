import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BorrowerErrorCode, BorrowerRelation, BorrowerRole, BorrowerWarningCode, CustomerType, GuaranteeType } from '@los/contracts';
import type { BorrowerCandidate, BorrowerSummary, BorrowerView, BorrowerWarning } from '@los/contracts';
import mnBorrower from '../../../../../packages/ui/src/i18n/mn.borrower.json';
import {
  ERROR_KEYS, buildAddRequest, buildUpdateRequest, candidateRoleOptions, consentState, coverageBelowLoan, customerWarningCodes, defaultIncomeIncluded, describeError,
  describeLiability, describeWarning, effectiveGuaranteeType, firstEnabledRole, formatAmount, formatDateTime, formatPercent, fromUbInputValue, groupDigits,
  initialFormValues, isSearchableRegisterNo, isStaleStateError, normalizeRegisterNo, percentToShare, remainingSharePercent, roleDefaults, roleOptions,
  rowGates, shareToPercent, sortWarnings, toConsentRequest, toUbInputValue, visibleFields, warningBadgeKey, warningTitleKey,
  type Translate,
} from './borrowers.utils';

const dict = mnBorrower as Record<string, string>;
/** lib/i18n.ts-ийн t()-тэй ижил: олдохгүй түлхүүрийг "!" угтвартай буцаана (тестэд илрүүлнэ). */
const tr: Translate = (key, params) => {
  const raw = dict[key] ?? `!${key}`;
  return params ? raw.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`)) : raw;
};

// ── fixtures ────────────────────────────────────────────────────────────────────────
let seq = 0;
function borrower(over: Partial<BorrowerView> & { name?: string; customerType?: 'INDIVIDUAL' | 'LEGAL_ENTITY' } = {}): BorrowerView {
  seq += 1;
  const { name, customerType, ...rest } = over;
  const role = rest.role ?? 'PRIMARY';
  return {
    id: `b${seq}`,
    applicationId: 'app1',
    customerId: `c${seq}`,
    role,
    isPrimary: role === 'PRIMARY',
    relationToPrimary: null,
    liabilityShare: null,
    guaranteeType: null,
    guaranteeAmount: null,
    consentFileId: null,
    consentSignedAt: null,
    incomeIncluded: role === 'PRIMARY' || role === 'CO_BORROWER',
    note: null,
    customer: {
      id: `c${seq}`, customerType: customerType ?? 'INDIVIDUAL', displayName: name ?? `Харилцагч ${seq}`, registerNoMasked: 'УБ******12',
      phone: null, email: null, isPep: false, isRelatedParty: false,
    },
    createdAt: '2026-10-28T09:00:00.000Z',
    ...rest,
  };
}

const summary = (over: Partial<BorrowerSummary> = {}): BorrowerSummary => ({
  primaryCount: 0, coBorrowerCount: 0, guarantorCount: 0, pledgorCount: 0, clientStepComplete: false, primaryLiabilityShare: null,
  incomeContributorCustomerIds: [], guaranteeCoverageRatio: null, limits: { maxCoBorrowers: 3, maxGuarantors: 3 }, editable: true, ...over,
});

const candidate = (over: Partial<BorrowerCandidate> = {}): BorrowerCandidate => ({
  customerId: 'cx', displayName: 'Бат Болд', registerNoMasked: 'УБ******12', customerType: 'INDIVIDUAL', phone: null, linkedRoles: [], ...over,
});

// ── хувь, мөнгө, огноо ───────────────────────────────────────────────────────────────
describe('хувь ба мөнгөний хөрвүүлэлт', () => {
  it('хувь ↔ бутархай хөвөгч таслалтын алдаагүй', () => {
    expect(percentToShare(33.33)).toBe(0.3333);
    expect(percentToShare(0.01)).toBe(0.0001);
    expect(percentToShare(100)).toBe(1);
    expect(percentToShare(66.67)).toBe(0.6667);
    expect(shareToPercent(0.3333)).toBe(33.33);
    expect(shareToPercent(0.0001)).toBe(0.01);
    for (const p of [0.01, 0.07, 12.34, 33.33, 50, 66.67, 99.99, 100]) expect(shareToPercent(percentToShare(p))).toBe(p);
  });

  it('formatPercent', () => {
    expect(formatPercent(0.5)).toBe('50%');
    expect(formatPercent(0.3333)).toBe('33.33%');
    expect(formatPercent(0.335)).toBe('33.5%');
    expect(formatPercent(1)).toBe('100%');
    expect(formatPercent(2)).toBe('200%'); // JOINT баталгааны хамрах хувь 1-ээс их байж болно
    expect(formatPercent(0)).toBe('0%');
  });

  it('formatAmount ба groupDigits', () => {
    expect(formatAmount(1250000)).toBe('1,250,000 ₮');
    expect(formatAmount(999)).toBe('999 ₮');
    expect(formatAmount(1234.5)).toBe('1,234.50 ₮');
    expect(formatAmount(0)).toBe('0 ₮');
    expect(groupDigits(1250000.5)).toBe('1,250,000.5');
    expect(groupDigits('1000')).toBe('1,000');
    expect(groupDigits(undefined)).toBe('');
    expect(groupDigits(null)).toBe('');
  });

  it('огноо Улаанбаатарын цагаар (UTC+8), хөтчийн цагийн бүснээс үл хамаарна', () => {
    expect(formatDateTime('2026-10-28T09:10:00.000Z')).toBe('2026-10-28 17:10');
    expect(formatDateTime('2026-10-28T16:30:00.000Z')).toBe('2026-10-29 00:30'); // өдөр шилжинэ, "24:30" биш
    expect(formatDateTime('not-a-date')).toBe('not-a-date');
    expect(toUbInputValue('2026-10-28T09:10:00.000Z')).toBe('2026-10-28T17:10');
    expect(fromUbInputValue('2026-10-28T17:10')?.toISOString()).toBe('2026-10-28T09:10:00.000Z');
    expect(fromUbInputValue('2026-10-28T17:10:45')?.toISOString()).toBe('2026-10-28T09:10:00.000Z');
    expect(fromUbInputValue('2026-10-28')).toBeNull();
    expect(fromUbInputValue('')).toBeNull();
    expect(fromUbInputValue(toUbInputValue('2026-01-01T00:05:00.000Z'))?.toISOString()).toBe('2026-01-01T00:05:00.000Z');
  });

  it('toConsentRequest нь ISO instant, файлын ID-г цэвэрлэнэ', () => {
    expect(toConsentRequest('  file-1 ', new Date('2026-10-28T09:10:00.000Z'))).toEqual({ fileId: 'file-1', signedAt: '2026-10-28T09:10:00.000Z' });
  });
});

describe('регистр хайлт', () => {
  it('нормчилно: зай арилгаж, кирилл том үсэг', () => {
    expect(normalizeRegisterNo(' уб 99010112 ')).toBe('УБ99010112');
    expect(normalizeRegisterNo('өү12345678')).toBe('ӨҮ12345678');
    expect(normalizeRegisterNo('2345678')).toBe('2345678');
  });
  it('хайлтын утгын хязгаар', () => {
    expect(isSearchableRegisterNo('')).toBe(false);
    expect(isSearchableRegisterNo('УБ99010112')).toBe(true);
    expect(isSearchableRegisterNo('Я'.repeat(33))).toBe(false);
    expect(isSearchableRegisterNo('Я'.repeat(32))).toBe(true);
  });
});

// ── талбарын харагдац ────────────────────────────────────────────────────────────────
describe('visibleFields — дүрээс хамаарсан талбар', () => {
  it('PRIMARY: холбоо, хувь, баталгаа байхгүй; орлого нэгтгэнэ', () => {
    expect(visibleFields('PRIMARY')).toEqual({ relationToPrimary: false, liabilityShare: false, guaranteeType: false, guaranteeAmount: false, incomeIncluded: true, note: true });
  });
  it('CO_BORROWER: холбоо, хувь, орлого', () => {
    expect(visibleFields('CO_BORROWER')).toEqual({ relationToPrimary: true, liabilityShare: true, guaranteeType: false, guaranteeAmount: false, incomeIncluded: true, note: true });
  });
  it('GUARANTOR: төрөл үргэлж, дүн зөвхөн LIMITED; орлого нэгтгэхгүй (BSA-BR-9)', () => {
    expect(visibleFields('GUARANTOR')).toMatchObject({ relationToPrimary: true, liabilityShare: false, guaranteeType: true, guaranteeAmount: false, incomeIncluded: false });
    expect(visibleFields('GUARANTOR', 'JOINT_AND_SEVERAL').guaranteeAmount).toBe(false);
    expect(visibleFields('GUARANTOR', 'LIMITED').guaranteeAmount).toBe(true);
  });
  it('PLEDGOR: зөвхөн холбоо ба тэмдэглэл', () => {
    expect(visibleFields('PLEDGOR')).toEqual({ relationToPrimary: true, liabilityShare: false, guaranteeType: false, guaranteeAmount: false, incomeIncluded: false, note: true });
  });
  it('дүр сонгоогүй бол юу ч харуулахгүй', () => {
    expect(Object.values(visibleFields(undefined)).some(Boolean)).toBe(false);
  });
  it('баталгааны төрөл зөвхөн GUARANTOR-д', () => {
    expect(effectiveGuaranteeType('GUARANTOR', null)).toBe('JOINT_AND_SEVERAL');
    expect(effectiveGuaranteeType('GUARANTOR', 'LIMITED')).toBe('LIMITED');
    expect(effectiveGuaranteeType('CO_BORROWER', 'LIMITED')).toBeNull();
  });
  it('орлого нэгтгэх анхдагч утга ба дүр солиход анхдагч утга', () => {
    expect(BorrowerRole.map(defaultIncomeIncluded)).toEqual([true, true, false, false]);
    expect(roleDefaults('GUARANTOR')).toMatchObject({ guaranteeType: 'JOINT_AND_SEVERAL', incomeIncluded: false, liabilityPercent: null, guaranteeAmount: null });
    expect(roleDefaults('CO_BORROWER')).toMatchObject({ guaranteeType: null, incomeIncluded: true });
  });
});

describe('remainingSharePercent', () => {
  it('хамтран зээлдэгчдийн хувийг хасаж, өөрийгөө тооцохгүй', () => {
    const a = borrower({ role: 'CO_BORROWER', liabilityShare: 0.3333 });
    const b = borrower({ role: 'CO_BORROWER', liabilityShare: 0.3333 });
    const c = borrower({ role: 'CO_BORROWER', liabilityShare: null });
    expect(remainingSharePercent([a, b, c])).toBe(33.34);
    expect(remainingSharePercent([a, b, c], a.id)).toBe(66.67);
    expect(remainingSharePercent([])).toBe(100);
  });
  it('PRIMARY болон бусад дүрийн хувийг тооцохгүй, сөрөг гарахгүй', () => {
    expect(remainingSharePercent([borrower({ role: 'PRIMARY', liabilityShare: 0.9 })])).toBe(100);
    expect(remainingSharePercent([borrower({ role: 'CO_BORROWER', liabilityShare: 1 }), borrower({ role: 'CO_BORROWER', liabilityShare: 0.5 })])).toBe(0);
  });
});

// ── хүсэлт бүрдүүлэх ──────────────────────────────────────────────────────────────────
describe('buildAddRequest', () => {
  it('дүр сонгоогүй бол null', () => {
    expect(buildAddRequest('c1', {})).toBeNull();
  });
  it('PRIMARY: холбоо/хувь/баталгаа ирсэн ч явуулахгүй; орлого анхдагчаар true', () => {
    expect(buildAddRequest('c1', { role: 'PRIMARY', relationToPrimary: 'SPOUSE', liabilityPercent: 50, guaranteeType: 'LIMITED', guaranteeAmount: 1000 })).toEqual({
      customerId: 'c1', role: 'PRIMARY', incomeIncluded: true,
    });
  });
  it('CO_BORROWER: хувийг бутархай болгоно, холбоо, орлого, тэмдэглэгээ', () => {
    expect(buildAddRequest('c2', { role: 'CO_BORROWER', relationToPrimary: 'SPOUSE', liabilityPercent: 33.33, incomeIncluded: false, note: '  хамтран  ' })).toEqual({
      customerId: 'c2', role: 'CO_BORROWER', relationToPrimary: 'SPOUSE', liabilityShare: 0.3333, incomeIncluded: false, note: 'хамтран',
    });
    expect(buildAddRequest('c2', { role: 'CO_BORROWER' })).toEqual({ customerId: 'c2', role: 'CO_BORROWER', incomeIncluded: true });
  });
  it('GUARANTOR төрөл өгөөгүй бол бүрэн баталгаа; дүн явуулахгүй; орлого явуулахгүй', () => {
    expect(buildAddRequest('c3', { role: 'GUARANTOR', guaranteeAmount: 5000, incomeIncluded: true })).toEqual({ customerId: 'c3', role: 'GUARANTOR', guaranteeType: 'JOINT_AND_SEVERAL' });
  });
  it('GUARANTOR LIMITED: дүнг 2 орноор бөөрөнхийлж явуулна', () => {
    expect(buildAddRequest('c3', { role: 'GUARANTOR', guaranteeType: 'LIMITED', guaranteeAmount: 5000000.456 })).toEqual({
      customerId: 'c3', role: 'GUARANTOR', guaranteeType: 'LIMITED', guaranteeAmount: 5000000.46,
    });
  });
  it('PLEDGOR: хувь, баталгаа, орлого явуулахгүй; хоосон тэмдэглэл орхино', () => {
    expect(buildAddRequest('c4', { role: 'PLEDGOR', relationToPrimary: 'FRIEND', liabilityPercent: 10, incomeIncluded: true, note: '   ' })).toEqual({
      customerId: 'c4', role: 'PLEDGOR', relationToPrimary: 'FRIEND',
    });
  });
});

describe('buildUpdateRequest', () => {
  it('өөрчлөлт байхгүй бол null (хоосон PATCH 400 өгнө)', () => {
    for (const b of [
      borrower({ role: 'PRIMARY' }),
      borrower({ role: 'CO_BORROWER', liabilityShare: 0.4, relationToPrimary: 'SPOUSE', note: 'x' }),
      borrower({ role: 'GUARANTOR', guaranteeType: 'LIMITED', guaranteeAmount: 1000.5 }),
      borrower({ role: 'GUARANTOR' }), // төрөл null (хуучин мөр) → бүрэн баталгаа
      borrower({ role: 'PLEDGOR' }),
    ])
      expect(buildUpdateRequest(b, initialFormValues(b))).toBeNull();
  });

  it('CO: хувь өөрчилөх / арилгах (null)', () => {
    const b = borrower({ role: 'CO_BORROWER', liabilityShare: 0.4 });
    expect(buildUpdateRequest(b, { ...initialFormValues(b), liabilityPercent: 25.5 })).toEqual({ liabilityShare: 0.255 });
    expect(buildUpdateRequest(b, { ...initialFormValues(b), liabilityPercent: null })).toEqual({ liabilityShare: null });
  });

  it('CO: хувь тогтоогоогүйгээс тогтоох', () => {
    const b = borrower({ role: 'CO_BORROWER' });
    expect(buildUpdateRequest(b, { ...initialFormValues(b), liabilityPercent: 50 })).toEqual({ liabilityShare: 0.5 });
  });

  it('холбоо өөрчилөх/арилгах, орлого нэгтгэх, тэмдэглэл', () => {
    const b = borrower({ role: 'CO_BORROWER', relationToPrimary: 'SPOUSE', note: 'хуучин' });
    expect(buildUpdateRequest(b, { ...initialFormValues(b), relationToPrimary: 'FRIEND' })).toEqual({ relationToPrimary: 'FRIEND' });
    expect(buildUpdateRequest(b, { ...initialFormValues(b), relationToPrimary: null })).toEqual({ relationToPrimary: null });
    expect(buildUpdateRequest(b, { ...initialFormValues(b), incomeIncluded: false })).toEqual({ incomeIncluded: false });
    expect(buildUpdateRequest(b, { ...initialFormValues(b), note: '  ' })).toEqual({ note: null });
    expect(buildUpdateRequest(b, { ...initialFormValues(b), note: ' шинэ ' })).toEqual({ note: 'шинэ' });
  });

  it('GUARANTOR: LIMITED → JOINT үед дүнг арилгана', () => {
    const b = borrower({ role: 'GUARANTOR', guaranteeType: 'LIMITED', guaranteeAmount: 2000 });
    expect(buildUpdateRequest(b, { ...initialFormValues(b), guaranteeType: 'JOINT_AND_SEVERAL', guaranteeAmount: 2000 })).toEqual({ guaranteeType: 'JOINT_AND_SEVERAL', guaranteeAmount: null });
  });
  it('GUARANTOR: JOINT → LIMITED үед дүнтэй нь явуулна', () => {
    const b = borrower({ role: 'GUARANTOR', guaranteeType: 'JOINT_AND_SEVERAL' });
    expect(buildUpdateRequest(b, { ...initialFormValues(b), guaranteeType: 'LIMITED', guaranteeAmount: 7500 })).toEqual({ guaranteeType: 'LIMITED', guaranteeAmount: 7500 });
  });
  it('GUARANTOR: LIMITED дүн өөрчилөх', () => {
    const b = borrower({ role: 'GUARANTOR', guaranteeType: 'LIMITED', guaranteeAmount: 2000 });
    expect(buildUpdateRequest(b, { ...initialFormValues(b), guaranteeAmount: 3000 })).toEqual({ guaranteeAmount: 3000 });
  });
  it('GUARANTOR: орлого нэгтгэх талбарыг хэзээ ч явуулахгүй', () => {
    const b = borrower({ role: 'GUARANTOR', guaranteeType: 'JOINT_AND_SEVERAL', incomeIncluded: false });
    expect(buildUpdateRequest(b, { ...initialFormValues(b), incomeIncluded: true })).toBeNull();
  });
  it('PRIMARY: хувь/холбоо ирсэн ч үл хэрэгсэнэ', () => {
    const b = borrower({ role: 'PRIMARY' });
    expect(buildUpdateRequest(b, { ...initialFormValues(b), liabilityPercent: 40, relationToPrimary: 'SPOUSE' })).toBeNull();
  });
});

// ── дүр сонгох боломж ──────────────────────────────────────────────────────────────────
describe('roleOptions (backend-ийн дүрмийн толь)', () => {
  const blocked = (opts: ReturnType<typeof roleOptions>) => Object.fromEntries(opts.map((o) => [o.role, o.reason?.key ?? null]));

  it('шинэ харилцагч, хоосон хүсэлт: бүх дүр боломжтой', () => {
    const opts = candidateRoleOptions(candidate(), summary());
    expect(opts.every((o) => o.reason === null)).toBe(true);
    expect(firstEnabledRole(opts)).toBe('PRIMARY');
  });

  it('үндсэн зээлдэгч байвал PRIMARY хаалттай, дараагийн боломжтой дүр нь CO_BORROWER', () => {
    const opts = candidateRoleOptions(candidate(), summary({ primaryCount: 1 }));
    expect(blocked(opts).PRIMARY).toBe('borrower.roleBlocked.primaryExists');
    expect(firstEnabledRole(opts)).toBe('CO_BORROWER');
  });

  it('хуулийн этгээд хамтран зээлдэгч байж болохгүй', () => {
    const opts = candidateRoleOptions(candidate({ customerType: 'LEGAL_ENTITY' }), summary());
    expect(blocked(opts)).toEqual({ PRIMARY: null, CO_BORROWER: 'borrower.roleBlocked.entity', GUARANTOR: null, PLEDGOR: null });
  });

  it('аль хэдийн бүртгэлтэй дүр — давхардал; PLEDGOR-оос бусад дүр хослохгүй', () => {
    expect(blocked(candidateRoleOptions(candidate({ linkedRoles: ['PRIMARY'] }), summary({ primaryCount: 1 })))).toEqual({
      PRIMARY: 'borrower.roleBlocked.duplicate', CO_BORROWER: 'borrower.roleBlocked.conflict', GUARANTOR: 'borrower.roleBlocked.conflict', PLEDGOR: null,
    });
    expect(blocked(candidateRoleOptions(candidate({ linkedRoles: ['GUARANTOR'] }), summary({ guarantorCount: 1 })))).toEqual({
      PRIMARY: 'borrower.roleBlocked.conflict', CO_BORROWER: 'borrower.roleBlocked.conflict', GUARANTOR: 'borrower.roleBlocked.duplicate', PLEDGOR: null,
    });
  });

  it('барьцаалагч нь бусад дүртэй хамт байж болно, гэхдээ давхардахгүй', () => {
    expect(blocked(candidateRoleOptions(candidate({ linkedRoles: ['PLEDGOR'] }), summary()))).toEqual({
      PRIMARY: null, CO_BORROWER: null, GUARANTOR: null, PLEDGOR: 'borrower.roleBlocked.duplicate',
    });
    expect(blocked(candidateRoleOptions(candidate({ linkedRoles: ['PLEDGOR', 'PRIMARY'] }), summary({ primaryCount: 1 }))).PLEDGOR).toBe('borrower.roleBlocked.duplicate');
  });

  it('тоо хязгаар: CO ба GUARANTOR (PLEDGOR хязгааргүй)', () => {
    const opts = candidateRoleOptions(candidate(), summary({ coBorrowerCount: 2, guarantorCount: 1, pledgorCount: 9, limits: { maxCoBorrowers: 2, maxGuarantors: 3 } }));
    expect(opts.find((o) => o.role === 'CO_BORROWER')?.reason).toEqual({ key: 'borrower.roleBlocked.limit', params: { limit: 2 } });
    expect(opts.find((o) => o.role === 'GUARANTOR')?.reason).toBeNull();
    expect(opts.find((o) => o.role === 'PLEDGOR')?.reason).toBeNull();
  });

  it('боломжтой дүр огт байхгүй бол firstEnabledRole = undefined', () => {
    const opts = candidateRoleOptions(candidate({ customerType: 'LEGAL_ENTITY', linkedRoles: ['PRIMARY', 'PLEDGOR'] }), summary({ primaryCount: 1 }));
    expect(firstEnabledRole(opts)).toBeUndefined();
  });
});

// ── мөрийн үйлдлийн эрх ───────────────────────────────────────────────────────────────
describe('rowGates', () => {
  it('засах боломжгүй төлөвт бүх мутаци хаалттай', () => {
    const co = borrower({ role: 'CO_BORROWER' });
    const g = rowGates(co, [co], summary({ editable: false }));
    expect([g.edit.allowed, g.consent.allowed, g.remove.allowed, g.makePrimary.allowed]).toEqual([false, false, false, false]);
    expect(g.edit.reason?.key).toBe('borrower.gate.notEditable');
    expect(g.makePrimary.visible).toBe(true);
  });

  it('үндсэн зээлдэгчийг бусад оролцогчтой үед шууд хасахгүй; ганцаараа бол хасна', () => {
    const p = borrower({ role: 'PRIMARY' });
    const co = borrower({ role: 'CO_BORROWER' });
    expect(rowGates(p, [p, co], summary()).remove.reason?.key).toBe('borrower.gate.primaryRequired');
    expect(rowGates(p, [p], summary()).remove.allowed).toBe(true);
    expect(rowGates(co, [p, co], summary()).remove.allowed).toBe(true);
  });

  it('make-primary зөвхөн CO_BORROWER-д харагдана', () => {
    const p = borrower({ role: 'PRIMARY' });
    const rows = [p, borrower({ role: 'CO_BORROWER' }), borrower({ role: 'GUARANTOR' }), borrower({ role: 'PLEDGOR' })];
    expect(rows.map((r) => rowGates(r, rows, summary()).makePrimary.visible)).toEqual([false, true, false, false]);
  });

  it('одоогийн үндсэн хуулийн этгээд бол make-primary хаалттай (тэр хамтран зээлдэгч болж чадахгүй)', () => {
    const p = borrower({ role: 'PRIMARY', customerType: 'LEGAL_ENTITY' });
    const co = borrower({ role: 'CO_BORROWER' });
    const g = rowGates(co, [p, co], summary());
    expect(g.makePrimary.allowed).toBe(false);
    expect(g.makePrimary.reason?.key).toBe('borrower.gate.entityPrimary');
  });

  it('үндсэн байхгүй үед CO-г шууд үндсэн болгож болно', () => {
    const co = borrower({ role: 'CO_BORROWER' });
    expect(rowGates(co, [co], summary()).makePrimary.allowed).toBe(true);
  });
});

describe('зөвшөөрөл ба хариуцлагын тайлбар', () => {
  it('consentState', () => {
    expect(consentState({ role: 'CO_BORROWER', consentSignedAt: null })).toBe('MISSING');
    expect(consentState({ role: 'GUARANTOR', consentSignedAt: null })).toBe('MISSING');
    expect(consentState({ role: 'PRIMARY', consentSignedAt: null })).toBe('NOT_REQUIRED');
    expect(consentState({ role: 'PLEDGOR', consentSignedAt: null })).toBe('NOT_REQUIRED');
    expect(consentState({ role: 'PLEDGOR', consentSignedAt: '2026-10-28T09:10:00.000Z' })).toBe('SIGNED');
    expect(consentState({ role: 'GUARANTOR', consentSignedAt: '2026-10-28T09:10:00.000Z' })).toBe('SIGNED');
  });

  it('describeLiability', () => {
    const s = summary({ primaryLiabilityShare: 0.6667 });
    expect(describeLiability(borrower({ role: 'CO_BORROWER', liabilityShare: 0.3333 }), s, tr)).toBe('Хувь: 33.33%');
    expect(describeLiability(borrower({ role: 'CO_BORROWER' }), s, tr)).toBe('Хувь тогтоогоогүй');
    expect(describeLiability(borrower({ role: 'PRIMARY' }), s, tr)).toBe('Үлдэгдэл хувь: 66.67%');
    expect(describeLiability(borrower({ role: 'PRIMARY' }), summary(), tr)).toBeNull();
    expect(describeLiability(borrower({ role: 'GUARANTOR', guaranteeType: 'JOINT_AND_SEVERAL' }), s, tr)).toBe('Бүрэн баталгаа');
    expect(describeLiability(borrower({ role: 'GUARANTOR' }), s, tr)).toBe('Бүрэн баталгаа');
    expect(describeLiability(borrower({ role: 'GUARANTOR', guaranteeType: 'LIMITED', guaranteeAmount: 5000000 }), s, tr)).toBe('Хязгаартай: 5,000,000 ₮');
    expect(describeLiability(borrower({ role: 'PLEDGOR' }), s, tr)).toBeNull();
  });

  it('баталгааны хамрах хувь < 100% бол анхаарна', () => {
    expect(coverageBelowLoan(0)).toBe(true);
    expect(coverageBelowLoan(0.99)).toBe(true);
    expect(coverageBelowLoan(1)).toBe(false);
    expect(coverageBelowLoan(2)).toBe(false);
    expect(coverageBelowLoan(null)).toBe(false);
  });
});

// ── анхааруулга ───────────────────────────────────────────────────────────────────────
describe('анхааруулга (BR-9)', () => {
  const bad = borrower({ role: 'PRIMARY', name: 'Бат Болд' });
  const co = borrower({ role: 'CO_BORROWER', name: 'Дорж Сүх' });
  const items = [bad, co];
  const w = (over: Partial<BorrowerWarning> & Pick<BorrowerWarning, 'code'>): BorrowerWarning => ({ message: 'серверийн мессеж', customerId: null, ...over });

  it('BLACKLISTED — улаан, шалтгаантай', () => {
    const d = describeWarning(w({ code: 'BLACKLISTED', customerId: bad.customerId, details: { reasonCode: 'FRAUD', listType: 'INTERNAL' } }), items, tr);
    expect(d.severity).toBe('error');
    expect(d.title).toBe('Хар жагсаалтад бүртгэлтэй');
    expect(d.description).toBe('Бат Болд хар жагсаалтад бүртгэлтэй байна (шалтгаан: FRAUD).');
  });

  it('PEP, RELATED_PARTY — шар', () => {
    expect(describeWarning(w({ code: 'PEP', customerId: bad.customerId }), items, tr)).toMatchObject({ severity: 'warning', description: 'Бат Болд улс төрд нөлөө бүхий этгээд гэж тэмдэглэгдсэн байна.' });
    expect(describeWarning(w({ code: 'RELATED_PARTY', customerId: co.customerId }), items, tr).description).toBe('Дорж Сүх ББСБ-д хамааралтай этгээд гэж тэмдэглэгдсэн байна.');
  });

  it('CONSENT_MISSING — дүрийн нэртэй', () => {
    const d = describeWarning(w({ code: 'CONSENT_MISSING', customerId: co.customerId, details: { role: 'CO_BORROWER', borrowerId: co.id } }), items, tr);
    expect(d.description).toBe('Дорж Сүх (Хамтран зээлдэгч)-ийн гарын үсэгтэй зөвшөөрөл бүртгэгдээгүй байна.');
  });

  it('GUARANTEE_BELOW_LOAN — дүнгүүдтэй', () => {
    const d = describeWarning(w({ code: 'GUARANTEE_BELOW_LOAN', details: { covered: 3000000, loanAmount: 5000000, shortfall: 2000000 } }), items, tr);
    expect(d.description).toBe('Батлан даагчдын баталгааны нийлбэр (3,000,000 ₮) зээлийн дүнгээс (5,000,000 ₮) бага байна. Дутагдал: 2,000,000 ₮.');
  });

  it('LIABILITY_SHARE_INCOMPLETE — тогтоосон хувьтай', () => {
    const d = describeWarning(w({ code: 'LIABILITY_SHARE_INCOMPLETE', details: { specifiedTotal: 0.4, missingCustomerIds: ['x'] } }), items, tr);
    expect(d.description).toContain('тогтоосон хувь 40%');
  });

  it('details дутуу/гэнэтийн бол серверийн мессежийг ашиглана', () => {
    expect(describeWarning(w({ code: 'GUARANTEE_BELOW_LOAN', details: { covered: 'x' } }), items, tr).description).toBe('серверийн мессеж');
    expect(describeWarning(w({ code: 'BLACKLISTED', customerId: 'unknown', details: { reasonCode: 'FRAUD' } }), items, tr).description).toBe('серверийн мессеж');
    expect(describeWarning(w({ code: 'CONSENT_MISSING', customerId: co.customerId, details: { role: 'HACKER' } }), items, tr).description).toBe('серверийн мессеж');
    expect(describeWarning(w({ code: 'LIABILITY_SHARE_INCOMPLETE' }), items, tr).description).toBe('серверийн мессеж');
  });

  it('бүх анхааруулгын кодод гарчиг ба тэмдэг i18n-д бий, хар жагсаалт л улаан', () => {
    for (const code of BorrowerWarningCode) {
      expect(dict[warningTitleKey(code)], code).toBeTruthy();
      expect(dict[`borrower.warning.${code}.text`], code).toBeTruthy();
    }
    for (const code of ['BLACKLISTED', 'PEP', 'RELATED_PARTY'] as const) expect(dict[warningBadgeKey(code)], code).toBeTruthy();
    expect(BorrowerWarningCode.filter((c) => describeWarning(w({ code: c }), items, tr).severity === 'error')).toEqual(['BLACKLISTED']);
  });

  it('sortWarnings: улаан эхэнд, дараа нь тогтсон дараалал', () => {
    const sorted = sortWarnings([w({ code: 'LIABILITY_SHARE_INCOMPLETE' }), w({ code: 'CONSENT_MISSING' }), w({ code: 'PEP' }), w({ code: 'BLACKLISTED' })]);
    expect(sorted.map((x) => x.code)).toEqual(['BLACKLISTED', 'PEP', 'CONSENT_MISSING', 'LIABILITY_SHARE_INCOMPLETE']);
  });

  it('customerWarningCodes: зөвхөн харилцагчийн түвшний кодууд, давхардалгүй', () => {
    const map = customerWarningCodes([
      w({ code: 'BLACKLISTED', customerId: 'a' }), w({ code: 'BLACKLISTED', customerId: 'a' }), w({ code: 'PEP', customerId: 'a' }),
      w({ code: 'CONSENT_MISSING', customerId: 'a' }), w({ code: 'GUARANTEE_BELOW_LOAN', customerId: null }), w({ code: 'RELATED_PARTY', customerId: 'b' }),
    ]);
    expect(map.get('a')).toEqual(['BLACKLISTED', 'PEP']);
    expect(map.get('b')).toEqual(['RELATED_PARTY']);
    expect(map.size).toBe(2);
  });
});

// ── алдаа ─────────────────────────────────────────────────────────────────────────────
describe('describeError', () => {
  it('BorrowerErrorCode бүр монгол мессежтэй', () => {
    for (const code of BorrowerErrorCode) {
      const d = describeError({ status: 409, code, message: 'english message' }, tr);
      expect(d.code).toBe(code);
      expect(d.message).not.toContain('!borrower.error');
      expect(d.message).not.toBe('english message');
      expect(d.message.length).toBeGreaterThan(10);
    }
    expect(ERROR_KEYS.every((k) => dict[k])).toBe(true);
  });

  it('тодорхой кодууд', () => {
    expect(describeError({ status: 409, code: 'PRIMARY_EXISTS' }, tr).message).toContain('Үндсэн зээлдэгч аль хэдийн бүртгэгдсэн');
    expect(describeError({ status: 422, code: 'LIABILITY_SHARE_EXCEEDED' }, tr).message).toContain('100%-иас хэтэрч');
    expect(describeError({ status: 409, code: 'BORROWER_OWNS_COLLATERAL' }, tr).message).toContain('барьцаа хөрөнгийн өмчлөгч');
    expect(describeError({ status: 403, code: 'FORBIDDEN' }, tr).message).toContain('эрх хүрэхгүй');
  });

  it('VALIDATION_FAILED үед талбарын жагсаалтыг буцаана', () => {
    const d = describeError({ status: 400, code: 'VALIDATION_FAILED', message: 'x', issues: [{ path: 'liabilityShare', message: 'буруу' }, { path: '', message: 'ерөнхий' }, { path: 'a', message: '' }, null] }, tr);
    expect(d.issues).toEqual(['liabilityShare: буруу', 'ерөнхий']);
  });

  it('код байхгүй үед статусаар', () => {
    expect(describeError({ status: 401, code: null }, tr).message).toBe(dict['borrower.error.UNAUTHENTICATED']);
    expect(describeError({ status: 403, code: null }, tr).message).toBe(dict['borrower.error.FORBIDDEN']);
    expect(describeError({ status: 502, code: 'X' }, tr).message).toBe(dict['borrower.error.SERVER']);
  });

  it('сүлжээний алдаа (fetch TypeError) ба тодорхойгүй', () => {
    expect(describeError(new TypeError('Failed to fetch'), tr).message).toBe(dict['borrower.error.NETWORK']);
    expect(describeError(undefined, tr).message).toBe(dict['borrower.error.UNKNOWN']);
    expect(describeError('boom', tr).message).toBe(dict['borrower.error.UNKNOWN']);
  });

  it('үл мэдэгдэх кодтой 4xx-д серверийн мессежийг харуулна', () => {
    expect(describeError({ status: 400, code: 'SOMETHING_NEW', message: 'Шинэ дүрэм зөрчигдлөө' }, tr).message).toBe('Шинэ дүрэм зөрчигдлөө');
  });

  it('isStaleStateError: 404/409', () => {
    expect(isStaleStateError({ status: 404 })).toBe(true);
    expect(isStaleStateError({ status: 409 })).toBe(true);
    expect(isStaleStateError({ status: 422 })).toBe(false);
    expect(isStaleStateError(null)).toBe(false);
  });
});

// ── i18n бүрэн байдал ──────────────────────────────────────────────────────────────────
describe('mn.borrower.json', () => {
  it('enum бүрийн утгад орчуулга бий', () => {
    for (const r of BorrowerRole) {
      expect(dict[`borrower.role.${r}`], r).toBeTruthy();
      expect(dict[`borrower.roleHint.${r}`], r).toBeTruthy();
    }
    for (const r of BorrowerRelation) expect(dict[`borrower.relation.${r}`], r).toBeTruthy();
    for (const g of GuaranteeType) expect(dict[`borrower.guaranteeType.${g}`], g).toBeTruthy();
    for (const c of CustomerType) expect(dict[`borrower.customerType.${c}`], c).toBeTruthy();
  });

  it('компонентууд дотор хэрэглэсэн `borrower.…` түлхүүр бүр JSON-д бий, JSON-ы түлхүүр бүр хаа нэгтээ хэрэглэгдсэн', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const sources = readdirSync(dir)
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('.test.ts'))
      .map((f) => readFileSync(`${dir}${f}`, 'utf8'));
    const literal = new Set<string>();
    const prefixes = new Set<string>();
    for (const src of sources) {
      for (const m of src.matchAll(/['"`](borrower\.[A-Za-z0-9_.]+)['"`]/g)) literal.add(m[1]);
      for (const m of src.matchAll(/`(borrower\.[A-Za-z0-9_.]*)\$\{/g)) prefixes.add(m[1]);
    }
    expect([...literal].filter((k) => !(k in dict)), 'JSON-д байхгүй түлхүүр').toEqual([]);
    const unused = Object.keys(dict).filter((k) => !literal.has(k) && ![...prefixes].some((p) => k.startsWith(p)));
    expect(unused, 'хэрэглэгдээгүй түлхүүр').toEqual([]);
  });

  it('{param} бүхий мессежүүд хаалтаа зөв хаасан', () => {
    for (const [k, v] of Object.entries(dict)) expect((v.match(/\{/g) ?? []).length, k).toBe((v.match(/\}/g) ?? []).length);
  });
});
