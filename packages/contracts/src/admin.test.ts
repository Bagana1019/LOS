import { describe, expect, it } from 'vitest';
import { UserRole } from './enums';
import { ADMIN_ASSIGNABLE_ROLES, ChangePasswordBody, CreateBranchBody, CreateUserBody, ContractNumberTemplateBody, ReplaceApprovalLevelsBody, validateApprovalLevels } from './admin';

const L = (levelNo: number, amountFrom: number, amountTo: number | null) => ({ levelNo, amountFrom, amountTo });

describe('validateApprovalLevels (BR-13)', () => {
  it('зөв шатлал', () => {
    expect(validateApprovalLevels([L(1, 0, 5), L(2, 5, 30), L(3, 30, null)])).toBeNull();
    expect(validateApprovalLevels([L(1, 0, null)])).toBeNull();
  });
  it('эрэмбэ хамаарахгүй (levelNo-оор)', () => {
    expect(validateApprovalLevels([L(2, 5, null), L(1, 0, 5)])).toBeNull();
  });
  it.each([
    ['1-ээс эхлээгүй', [L(2, 0, null)]],
    ['0-ээс эхлээгүй', [L(1, 10, null)]],
    ['завсартай', [L(1, 0, 5), L(2, 6, null)]],
    ['давхцсан', [L(1, 0, 5), L(2, 4, null)]],
    ['дунд нь хязгааргүй', [L(1, 0, null), L(2, 5, null)]],
    ['дээд ≤ доод', [L(1, 0, 0), L(2, 0, null)]],
    ['сүүлийнх хязгаартай', [L(1, 0, 5)]],
    ['түвшний дугаар алгассан', [L(1, 0, 5), L(3, 5, null)]],
  ])('%s → алдаа', (_n, ls) => {
    expect(validateApprovalLevels(ls)).toEqual(expect.any(String));
  });
});

describe('DTO schemas', () => {
  it('ReplaceApprovalLevelsBody: SLA > 0, нэр заавал', () => {
    const base = { levelNo: 1, name: 'A', amountFrom: 0, amountTo: null, slaHours: 24, members: [] };
    expect(ReplaceApprovalLevelsBody.safeParse({ levels: [base] }).success).toBe(true);
    expect(ReplaceApprovalLevelsBody.safeParse({ levels: [{ ...base, slaHours: 0 }] }).success).toBe(false);
    expect(ReplaceApprovalLevelsBody.safeParse({ levels: [{ ...base, name: ' ' }] }).success).toBe(false);
    expect(ReplaceApprovalLevelsBody.safeParse({ levels: [] }).success).toBe(false);
  });
  it('ContractNumberTemplateBody: {SEQ} заавал, угтвар зөвхөн үсэг/тоо', () => {
    expect(ContractNumberTemplateBody.safeParse({ pattern: '{PREFIX}{SEQ:3}', prefix: 'B', seqScope: 'DAY' }).success).toBe(true);
    expect(ContractNumberTemplateBody.safeParse({ pattern: '{PREFIX}', prefix: 'B', seqScope: 'DAY' }).success).toBe(false);
    expect(ContractNumberTemplateBody.safeParse({ pattern: '{SEQ}', prefix: 'B-1', seqScope: 'DAY' }).success).toBe(false);
  });
});

describe('FR-13 user/branch management schemas', () => {
  const uuid = '00000000-0000-4000-8000-000000000a01';
  it('assignable roles = every UserRole', () => expect([...ADMIN_ASSIGNABLE_ROLES].sort()).toEqual([...UserRole].sort()));
  it('branch code is upper-cased and validated', () => {
    expect(CreateBranchBody.parse({ code: ' ub2 ', name: 'Улаанбаатар 2' }).code).toBe('UB2');
    expect(CreateBranchBody.safeParse({ code: 'bad code', name: 'Тест' }).success).toBe(false);
    expect(CreateBranchBody.safeParse({ code: '1234567890123', name: 'Тест' }).success).toBe(false);
  });
  it('username lower-cased; roles non-empty, unique, known', () => {
    const base = { fullName: 'Бат Болд', branchId: uuid };
    expect(CreateUserBody.parse({ ...base, username: ' Bat.Bold ', roles: ['OFFICER'] }).username).toBe('bat.bold');
    expect(CreateUserBody.safeParse({ ...base, username: 'ab', roles: ['OFFICER'] }).success).toBe(false);
    expect(CreateUserBody.safeParse({ ...base, username: 'bat.bold', roles: [] }).success).toBe(false);
    expect(CreateUserBody.safeParse({ ...base, username: 'bat.bold', roles: ['OFFICER', 'OFFICER'] }).success).toBe(false);
    expect(CreateUserBody.safeParse({ ...base, username: 'bat.bold', roles: ['ROOT'] }).success).toBe(false);
    expect(CreateUserBody.parse({ ...base, username: 'bat.bold', roles: ['OFFICER'], email: '' }).email).toBeNull();
  });
  it('password policy: >=12 chars with lower, upper and digit', () => {
    const ok = (p: string) => ChangePasswordBody.safeParse({ currentPassword: 'x', newPassword: p }).success;
    expect(ok('NewPassw0rd-ok')).toBe(true);
    expect(ok('Short1a')).toBe(false);
    expect(ok('alllowercase123')).toBe(false);
    expect(ok('NoDigitsHereAtAll')).toBe(false);
  });
});
