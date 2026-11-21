import { describe, expect, it, vi } from 'vitest';
import type { UpdateUserBody } from '@los/contracts';
import { AdminService } from './admin.service';

// FR-13 · "сүүлийн идэвхтэй админ" хамгаалалт (e2e-д seed админыг эвдэхгүйн тулд stub prisma-аар)
const admin = (id: string) => ({ id, orgId: 'o', roles: ['ADMIN'], isActive: true, branchId: null, fullName: 'A', email: null, phone: null });
function svc(otherAdmins: number) {
  const prisma = {
    user: { findFirst: vi.fn(async () => admin('target')), findFirstOrThrow: vi.fn(async () => ({ ...admin('target'), isActive: false })), count: vi.fn(async () => otherAdmins) },
    $transaction: vi.fn(async () => undefined),
  };
  return { s: new AdminService(prisma as never), prisma };
}
const meta = { correlationId: null, ip: null };

describe('AdminService last-admin guard', () => {
  it('өөр идэвхтэй админ байхгүй бол идэвхгүй болгох 422 LAST_ADMIN', async () => {
    await expect(svc(0).s.setUserActive('o', 'actor', 'target', false, meta)).rejects.toMatchObject({ response: { code: 'LAST_ADMIN' } });
  });
  it('өөр идэвхтэй админ байхгүй бол ADMIN дүрийг хасах 422 LAST_ADMIN', async () => {
    await expect(svc(0).s.updateUser('o', 'actor', 'target', { fullName: 'A', email: null, phone: null, roles: ['APPROVER'], branchId: null }, meta)).rejects.toMatchObject({ response: { code: 'LAST_ADMIN' } });
  });
  it('өөр идэвхтэй админ байвал зөвшөөрнө', async () => {
    const { s } = svc(1);
    await expect(s.setUserActive('o', 'actor', 'target', false, meta)).resolves.toMatchObject({ isActive: false });
  });
});

// F9-19: эрх олголтын хамгаалалт — OFFICER+APPROVER хослол, өөртөө эрх нэмэх
describe('AdminService role-grant guards (F9-19)', () => {
  const user = (roles: string[]) => ({ id: 'target', orgId: 'o', roles, isActive: true, branchId: 'b1', fullName: 'Бат', email: null, phone: null, mustChangePassword: false, lastLoginAt: null, username: 'bat' });
  function make(roles: string[]) {
    const prisma = {
      user: { findFirst: vi.fn(async () => user(roles)), findFirstOrThrow: vi.fn(async () => user(roles)), findUnique: vi.fn(async () => null), count: vi.fn(async () => 1) },
      branch: { findFirst: vi.fn(async () => ({ id: 'b1', orgId: 'o', isActive: true })) },
      $transaction: vi.fn(async () => undefined),
    };
    return { s: new AdminService(prisma as never), prisma };
  }
  const body = (roles: string[]) => ({ fullName: 'Бат', email: null, phone: null, roles, branchId: 'b1' }) as UpdateUserBody;

  it('шинэ хэрэглэгчид OFFICER+APPROVER зэрэг олгох нь 422 ROLE_COMBINATION_FORBIDDEN', async () => {
    const { s } = make([]);
    await expect(s.createUser('o', 'actor', { ...body(['OFFICER', 'APPROVER']), username: 'bat' } as never, meta)).rejects.toMatchObject({ response: { code: 'ROLE_COMBINATION_FORBIDDEN' }, status: 422 });
  });

  it('OFFICER-т APPROVER нэмэх нь 422 ROLE_COMBINATION_FORBIDDEN, юу ч хадгалагдахгүй', async () => {
    const { s, prisma } = make(['OFFICER']);
    await expect(s.updateUser('o', 'actor', 'target', body(['OFFICER', 'APPROVER']), meta)).rejects.toMatchObject({ response: { code: 'ROLE_COMBINATION_FORBIDDEN' }, status: 422 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('хуучин хослолтой хэрэглэгчийн профайл (дүр өөрчлөхгүй) засахад саад болохгүй', async () => {
    const { s } = make(['OFFICER', 'APPROVER']);
    await expect(s.updateUser('o', 'actor', 'target', body(['OFFICER', 'APPROVER']), meta)).resolves.toMatchObject({ id: 'target' });
  });

  it('хуучин хослолоос нэг дүрийг хасах нь зөвшөөрөгдөнө', async () => {
    const { s } = make(['OFFICER', 'APPROVER']);
    await expect(s.updateUser('o', 'actor', 'target', body(['APPROVER']), meta)).resolves.toMatchObject({ id: 'target' });
  });

  it('өөр хэрэглэгчид зөвшөөрөгдсөн дүр (APPROVER) олгох нь зөвшөөрөгдөнө', async () => {
    const { s } = make(['BRANCH_MANAGER']);
    await expect(s.updateUser('o', 'actor', 'target', body(['BRANCH_MANAGER', 'APPROVER']), meta)).resolves.toMatchObject({ id: 'target' });
  });

  it('өөртөө дүр нэмэх нь 422 SELF_ROLE_GRANT', async () => {
    const { s, prisma } = make(['OFFICER']);
    await expect(s.updateUser('o', 'target', 'target', body(['OFFICER', 'COMPLIANCE']), meta)).rejects.toMatchObject({ response: { code: 'SELF_ROLE_GRANT' }, status: 422 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('өөрийн профайл засах, өөрийн дүрээс нэгийг (ADMIN биш) хасах нь зөвшөөрөгдөнө', async () => {
    const { s } = make(['OFFICER', 'COMPLIANCE']);
    await expect(s.updateUser('o', 'target', 'target', body(['OFFICER', 'COMPLIANCE']), meta)).resolves.toMatchObject({ id: 'target' });
    await expect(s.updateUser('o', 'target', 'target', body(['OFFICER']), meta)).resolves.toMatchObject({ id: 'target' });
  });
});
