// Модуль 0 seed (docs/04): байгууллага, 2 салбар, 5 хэрэглэгч дүр бүрээр. Idempotent (create-only: нууц үгийг дахин тохируулахгүй).
// Нууц үг: SEED_PASSWORD (хөгжүүлэлтийн анхдагч). Production-д анхдагч нууц үгээр seed хийхээс татгалзана.
import { PrismaClient } from '.prisma/client-gateway';
import { SEED } from '@los/database';
import { hashPassword } from '../src/modules/auth/password';

const DEV_PASSWORD = 'Los@2026!dev';
const prisma = new PrismaClient();

async function main() {
  const password = process.env.SEED_PASSWORD ?? DEV_PASSWORD;
  if (process.env.NODE_ENV === 'production' && (password === DEV_PASSWORD || password.length < 12)) {
    throw new Error('Refusing to seed production with the default/short SEED_PASSWORD');
  }
  await prisma.org.upsert({ where: { id: SEED.org.id }, create: { ...SEED.org }, update: {} });
  for (const b of Object.values(SEED.branches)) {
    await prisma.branch.upsert({ where: { orgId_code: { orgId: SEED.org.id, code: b.code } }, create: { ...b, orgId: SEED.org.id }, update: {} });
  }
  for (const [code, name] of [['OFFICER', 'Зээлийн эдийн засагч'], ['BRANCH_MANAGER', 'Салбарын захирал'], ['APPROVER', 'Батлагч'], ['ADMIN', 'Админ']] as const) {
    await prisma.role.upsert({ where: { code }, create: { code, name }, update: {} });
  }
  const passwordHash = await hashPassword(password);
  for (const u of Object.values(SEED.users)) {
    await prisma.user.upsert({
      where: { username: u.username },
      create: { id: u.id, orgId: SEED.org.id, branchId: u.branch ? SEED.branches[u.branch].id : null, username: u.username, passwordHash, fullName: u.fullName, roles: [...u.roles], isActive: true },
      update: {},
    });
  }
  console.log(`gateway seed: org ${SEED.org.code}, ${Object.keys(SEED.branches).length} branches, ${Object.keys(SEED.users).length} users`);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
