import { describe, expect, it, vi } from 'vitest';
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
