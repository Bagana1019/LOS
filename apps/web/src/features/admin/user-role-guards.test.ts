import { describe, expect, it } from 'vitest';
import { INCOMPATIBLE_ROLE_PAIRS, PRIVILEGED_ROLES } from '@los/contracts';
import { ApiError } from '../../lib/api';
import { addedPrivilegedRoles, isRoleGuardError, roleDisabledReason, type RoleGuardCtx } from './user-role-guards';

// F9-19 · дүр сонгох хамгаалалт: серверийн дүрийг (contracts role-rules) яг тусгана, хуулбар хос web-д байхгүй.

const ctx = (o: Partial<RoleGuardCtx> = {}): RoleGuardCtx => ({ selected: [], original: [], isSelf: false, ...o });

describe('roleDisabledReason · хориглосон хос', () => {
  it('OFFICER сонгосон бол APPROVER хаагдана, эсрэгээр нь мөн', () => {
    expect(roleDisabledReason('APPROVER', ctx({ selected: ['OFFICER'] }))).toEqual({ kind: 'pair', partner: 'OFFICER' });
    expect(roleDisabledReason('OFFICER', ctx({ selected: ['APPROVER'] }))).toEqual({ kind: 'pair', partner: 'APPROVER' });
  });

  it('contracts-ийн INCOMPATIBLE_ROLE_PAIRS бүрийг хоёр чиглэлд мөрдөнө (web-д хос хуулаагүй)', () => {
    for (const [a, b] of INCOMPATIBLE_ROLE_PAIRS) {
      expect(roleDisabledReason(b, ctx({ selected: [a] }))).toEqual({ kind: 'pair', partner: a });
      expect(roleDisabledReason(a, ctx({ selected: [b] }))).toEqual({ kind: 'pair', partner: b });
    }
  });

  it('юу ч сонгоогүй, эсвэл хамааралгүй дүр сонгосон бол юу ч хаагдахгүй', () => {
    for (const r of ['ADMIN', 'APPROVER', 'BRANCH_MANAGER', 'OFFICER', 'COMPLIANCE']) expect(roleDisabledReason(r, ctx())).toBeNull();
    expect(roleDisabledReason('OFFICER', ctx({ selected: ['ADMIN'] }))).toBeNull();
    expect(roleDisabledReason('APPROVER', ctx({ selected: ['BRANCH_MANAGER', 'COMPLIANCE'] }))).toBeNull();
  });

  it('сонгосон дүр өөрөө хаагдахгүй (хасаж болно)', () => {
    expect(roleDisabledReason('OFFICER', ctx({ selected: ['OFFICER'] }))).toBeNull();
  });

  it('хуучин хэрэглэгч хоёуланг нь аль хэдийн эзэмшдэг бол юу ч хаагдахгүй: нэгийг хасч болно', () => {
    const both = ['OFFICER', 'APPROVER'];
    expect(roleDisabledReason('OFFICER', ctx({ original: both, selected: both }))).toBeNull();
    expect(roleDisabledReason('APPROVER', ctx({ original: both, selected: both }))).toBeNull();
    expect(roleDisabledReason('OFFICER', ctx({ original: both, selected: ['APPROVER'] }))).toBeNull();
  });
});

describe('roleDisabledReason · өөрийн бүртгэл', () => {
  it('өөрт байхгүй дүр хаагдана, байгаа дүр нь засагдахуйц хэвээр', () => {
    const c = ctx({ isSelf: true, original: ['ADMIN'], selected: ['ADMIN'] });
    expect(roleDisabledReason('OFFICER', c)).toEqual({ kind: 'self' });
    expect(roleDisabledReason('COMPLIANCE', c)).toEqual({ kind: 'self' });
    expect(roleDisabledReason('ADMIN', c)).toBeNull();
  });

  it('өөрийн дүрээс нэгийг хассан ч буцаан сонгож болно (шинээр нэмэлт биш), байхгүй дүр хаалттай', () => {
    const c = ctx({ isSelf: true, original: ['ADMIN', 'COMPLIANCE'], selected: ['ADMIN'] });
    expect(roleDisabledReason('COMPLIANCE', c)).toBeNull();
    expect(roleDisabledReason('APPROVER', c)).toEqual({ kind: 'self' });
  });

  it('өөрийн бүртгэл + хос: "өөртөө нэмэхгүй" шалтгаан нь түрүүлнэ', () => {
    const c = ctx({ isSelf: true, original: ['OFFICER'], selected: ['OFFICER'] });
    expect(roleDisabledReason('APPROVER', c)).toEqual({ kind: 'self' });
  });

  it('өөр хэрэглэгчийг засахад (isSelf=false) энэ хориг үйлчлэхгүй', () => {
    expect(roleDisabledReason('ADMIN', ctx({ isSelf: false, original: ['OFFICER'], selected: ['OFFICER'] }))).toBeNull();
  });
});

describe('addedPrivilegedRoles · баталгаажуулах цонх хэзээ гарах', () => {
  it('шинэ хэрэглэгч: эрх өсгөх дүр бүр нэмэгдсэнд тооцогдоно', () => {
    expect(addedPrivilegedRoles([], ['OFFICER'])).toEqual([]);
    expect(addedPrivilegedRoles([], ['OFFICER', 'ADMIN'])).toEqual(['ADMIN']);
  });

  it('засвар: шинээр нэмсэн эрх өсгөх дүрийг л буцаана', () => {
    expect(addedPrivilegedRoles(['OFFICER'], ['OFFICER', 'ADMIN'])).toEqual(['ADMIN']);
    expect(addedPrivilegedRoles(['ADMIN'], ['ADMIN'])).toEqual([]);
  });

  it('хасах, эрх өсгөхгүй дүр нэмэх, профайл засах үед хоосон', () => {
    expect(addedPrivilegedRoles(['ADMIN', 'COMPLIANCE'], ['ADMIN'])).toEqual([]);
    expect(addedPrivilegedRoles(['OFFICER'], ['OFFICER', 'BRANCH_MANAGER'])).toEqual([]);
    expect(addedPrivilegedRoles(['OFFICER'], ['OFFICER'])).toEqual([]);
  });

  it('хэд хэд нэмбэл PRIVILEGED_ROLES-ийн дарааллаар, байгаа нь давтагдахгүй', () => {
    const after = ['COMPLIANCE', 'ADMIN', 'OFFICER'];
    expect(addedPrivilegedRoles([], after)).toEqual(PRIVILEGED_ROLES.filter((r) => after.includes(r)));
    expect(addedPrivilegedRoles(['ADMIN'], after)).toEqual(['COMPLIANCE']);
  });
});

describe('isRoleGuardError · серверийн 422 алдааг маягтад харуулах эсэх', () => {
  it('ROLE_COMBINATION_FORBIDDEN, SELF_ROLE_GRANT бол үнэн', () => {
    expect(isRoleGuardError(new ApiError(422, 'ROLE_COMBINATION_FORBIDDEN', 'x'))).toBe(true);
    expect(isRoleGuardError(new ApiError(422, 'SELF_ROLE_GRANT', 'x'))).toBe(true);
  });

  it('бусад код, ApiError биш алдаа бол худал', () => {
    expect(isRoleGuardError(new ApiError(422, 'BRANCH_REQUIRED', 'x'))).toBe(false);
    expect(isRoleGuardError(new ApiError(500, null, 'x'))).toBe(false);
    expect(isRoleGuardError(new Error('boom'))).toBe(false);
    expect(isRoleGuardError(null)).toBe(false);
  });
});
