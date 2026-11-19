import { describe, expect, it, vi } from 'vitest';
import { OrgDirectory } from '@los/contracts';
import { DirectoryService } from './directory.service';

// FR-1.2 (M2): жагсаалтад салбар / ЗЭЗ-ийн UUID биш нэр харуулах унших-зөвхөн лавлах. Stub prisma-аар (DB-гүй).
function svc(branches: Array<{ id: string; name: string }>, users: Array<{ id: string; fullName: string }>) {
  const prisma = { branch: { findMany: vi.fn(async () => branches) }, user: { findMany: vi.fn(async () => users) } };
  return { s: new DirectoryService(prisma as never), prisma };
}

describe('DirectoryService.get', () => {
  it('салбар, хэрэглэгчийг id → харуулах нэр болгон буцаана', async () => {
    const { s } = svc([{ id: 'b1', name: 'Төв салбар' }, { id: 'b2', name: 'Баянзүрх салбар' }], [{ id: 'u1', fullName: 'ЗЭЗ А' }]);
    const dir = await s.get('org-1');
    expect(dir).toEqual({ branches: { b1: 'Төв салбар', b2: 'Баянзүрх салбар' }, users: { u1: 'ЗЭЗ А' } });
    expect(OrgDirectory.safeParse(dir).success).toBe(true);
  });

  it('хоёр хүсэлт хоёулаа дуудагчийн байгууллагаар хязгаарлагдана (бусад байгууллагын нэр алдагдахгүй)', async () => {
    const { s, prisma } = svc([], []);
    await s.get('org-1');
    expect(prisma.branch.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ orgId: 'org-1' }) }));
    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ orgId: 'org-1' }) }));
  });

  it('PII уншихгүй: зөвхөн id + харуулах нэрийг select хийнэ (username, email, phone, passwordHash, roles байхгүй)', async () => {
    const { s, prisma } = svc([], []);
    await s.get('org-1');
    expect(prisma.branch.findMany).toHaveBeenCalledWith(expect.objectContaining({ select: { id: true, name: true } }));
    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ select: { id: true, fullName: true } }));
  });

  it('идэвхгүй салбар / хэрэглэгчийг хасахгүй — хуучин хүсэлтийн ЗЭЗ, салбарыг нэрээр нь харуулах ёстой', async () => {
    const { s, prisma } = svc([], []);
    await s.get('org-1');
    const [branchArgs] = prisma.branch.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }];
    const [userArgs] = prisma.user.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }];
    expect(branchArgs.where).not.toHaveProperty('isActive');
    expect(userArgs.where).not.toHaveProperty('isActive');
  });

  it('хоосон байгууллага → хоёр хоосон map (алдаа биш)', async () => {
    const { s } = svc([], []);
    await expect(s.get('org-1')).resolves.toEqual({ branches: {}, users: {} });
  });

  it('кирилл, тусгай тэмдэгттэй нэрийг өөрчлөхгүй хадгална', async () => {
    const { s } = svc([{ id: 'b1', name: 'Салбар "А" & Б <1>' }], [{ id: 'u1', fullName: 'Бат-Эрдэнэ О.' }]);
    const dir = await s.get('org-1');
    expect(dir.branches.b1).toBe('Салбар "А" & Б <1>');
    expect(dir.users.u1).toBe('Бат-Эрдэнэ О.');
  });

  it('өгөгдлийн сангийн алдааг залгихгүй (500 болж харагдана, хоосон лавлах болж хуурахгүй)', async () => {
    const prisma = { branch: { findMany: vi.fn(async () => { throw new Error('db down'); }) }, user: { findMany: vi.fn(async () => []) } };
    await expect(new DirectoryService(prisma as never).get('org-1')).rejects.toThrow('db down');
  });
});
