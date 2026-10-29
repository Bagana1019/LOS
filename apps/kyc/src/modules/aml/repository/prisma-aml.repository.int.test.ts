import 'reflect-metadata';
import { afterAll, beforeAll, describe } from 'vitest';
import type { DomainEvent } from '@los/contracts';
import { PrismaService } from '../../../prisma.service';
import { truncateKycTables } from '../test-db';
import { describeAmlRepositoryContract } from './aml-repository.contract';
import { PrismaAmlRepository } from './prisma-aml.repository';

// Бодит Postgres шаардана (TEST_DATABASE_URL — migrate хийгдсэн kyc schema, test/global-setup.ts); үгүй бол алгасна.
// Хүснэгтүүдийг TRUNCATE хийдэг тул өгөгдлийн сангийн нэр 'test' агуулсан байх ёстой (test-db.ts).
describe.skipIf(!process.env.TEST_DATABASE_URL)('PrismaAmlRepository (Postgres)', () => {
  let prisma: PrismaService;
  beforeAll(() => {
    prisma = new PrismaService();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  describeAmlRepositoryContract('postgres', async () => {
    await truncateKycTables(prisma); // DATABASE_URL-ийн нэрэнд 'test' байхгүй бол татгалзана
    return {
      repo: new PrismaAmlRepository(prisma),
      outbox: async () => (await prisma.outbox.findMany()).map((row) => row.payload as unknown as DomainEvent),
    };
  });
});
