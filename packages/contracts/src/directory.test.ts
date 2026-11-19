import { describe, expect, it } from 'vitest';
import { APPROVAL_VOTER_ROLES, OrgDirectory, UserRole } from './index';

// FR-1.2 (M2): Салбар / Хариуцсан ЗЭЗ баганад UUID биш нэр харуулахын тулд gateway-ийн унших-зөвхөн лавлах (id → нэр).
describe('OrgDirectory (GET /api/directory)', () => {
  it('салбар, хэрэглэгчийн id → харуулах нэрийн map-ыг хүлээн авна', () => {
    const body = { branches: { b1: 'Төв салбар' }, users: { u1: 'ЗЭЗ А', u2: 'Батлагч' } };
    expect(OrgDirectory.parse(body)).toEqual(body);
  });

  it('хоосон лавлах хүчинтэй', () => {
    expect(OrgDirectory.safeParse({ branches: {}, users: {} }).success).toBe(true);
  });

  it('аль нэг map дутуу эсвэл нэр нь string биш бол татгалзана', () => {
    expect(OrgDirectory.safeParse({ branches: {} }).success).toBe(false);
    expect(OrgDirectory.safeParse({ branches: { b: 1 }, users: {} }).success).toBe(false);
    expect(OrgDirectory.safeParse({ branches: {}, users: { u: null } }).success).toBe(false);
  });

  it('PII талбар (username, email, phone, roles) схемд байхгүй — нэмэлт түлхүүрийг зөвшөөрөхгүй', () => {
    expect(OrgDirectory.safeParse({ branches: {}, users: {}, emails: { u: 'a@b.mn' } }).success).toBe(false);
  });
});

// FR-1.1 (M3): "Миний батлах" табыг санал өгөх дүрүүдэд л харуулна. `GET /approvals/mine`-ийн @Roles-той ижил байх ёстой.
describe('APPROVAL_VOTER_ROLES', () => {
  it('салбарын захирал, батлагч, админ', () => {
    expect([...APPROVAL_VOTER_ROLES].sort()).toEqual(['ADMIN', 'APPROVER', 'BRANCH_MANAGER']);
  });

  it('бүгд мэдэгдэх UserRole', () => {
    for (const r of APPROVAL_VOTER_ROLES) expect(UserRole).toContain(r);
  });

  it('ЗЭЗ, комплаенс санал өгөх дүр биш', () => {
    expect(APPROVAL_VOTER_ROLES).not.toContain('OFFICER');
    expect(APPROVAL_VOTER_ROLES).not.toContain('COMPLIANCE');
  });
});
