import { describe, expect, it } from 'vitest';
import { UserRole } from './enums';
import { INCOMPATIBLE_ROLE_PAIRS, PRIVILEGED_ROLES, incompatibleRolePair } from './role-rules';

// F9-19: нэг хүнд бэлтгэгч (OFFICER) ба батлагч (APPROVER) дүрийг зэрэг олгохыг хориглоно.
describe('incompatibleRolePair', () => {
  it('OFFICER + APPROVER хос байвал хосыг буцаана (дарааллаас үл хамаарна)', () => {
    expect(incompatibleRolePair(['OFFICER', 'APPROVER'])).toEqual(['OFFICER', 'APPROVER']);
    expect(incompatibleRolePair(['APPROVER', 'OFFICER'])).toEqual(['OFFICER', 'APPROVER']);
  });

  it('хос гурав дахь дүртэй холилдсон ч илэрнэ', () => {
    expect(incompatibleRolePair(['ADMIN', 'OFFICER', 'APPROVER'])).toEqual(['OFFICER', 'APPROVER']);
  });

  it.each([
    [[]],
    [['OFFICER']],
    [['APPROVER']],
    [['OFFICER', 'ADMIN']],
    [['BRANCH_MANAGER', 'APPROVER']],
    [['COMPLIANCE', 'APPROVER']],
  ])('зөвшөөрөгдсөн хослол %j → null', (roles) => {
    expect(incompatibleRolePair(roles)).toBeNull();
  });

  it('жагсаалтын дүр бүр бодит UserRole (бичгийн алдаагүй)', () => {
    for (const r of [...INCOMPATIBLE_ROLE_PAIRS.flat(), ...PRIVILEGED_ROLES]) expect(UserRole).toContain(r);
  });
});
