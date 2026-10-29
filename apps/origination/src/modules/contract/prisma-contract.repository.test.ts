import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEED } from '@los/database';
import { PrismaService } from '../../prisma.service';
import { seedContract } from './contract-db.fixtures';
import { describeContractRepository } from './contract-repository.suite';
import { PrismaContractRepository } from './prisma-contract.repository';

// DB-тэй тест: TEST_DATABASE_URL (нэр нь `test`-ээр төгссөн) байхгүй бол алгасна (docs/00-foundation.md §4)
const HAS_DB = !!process.env.TEST_DATABASE_URL;
const db = new PrismaService();
const repo = new PrismaContractRepository(db);

beforeAll(async () => { if (HAS_DB) await db.$connect(); });
afterAll(async () => { if (HAS_DB) await db.$disconnect(); });

describeContractRepository('prisma (origination.contract)', () => ({ repo, seed: (input) => seedContract(db, input) }), { available: async () => HAS_DB });

describe.skipIf(!HAS_DB)('PrismaContractRepository: аудит (NFR-4)', () => {
  it('амжилттай шинэчлэл бүр CONTRACT_SIGNING_UPDATED аудит бичнэ; CAS-д унасан оролдлого бичихгүй', async () => {
    const applicationId = `app-${crypto.randomUUID()}`;
    await seedContract(db, { applicationId, signingRequestId: 'sr-1', signingStatus: 'PENDING' });

    expect(await repo.updateSigning(applicationId, { signingStatus: 'DECLINED', signingFailureReason: 'DECLINED' }, { expectedRequestId: 'sr-1' })).toBe(true);
    expect(await repo.updateSigning(applicationId, { signingStatus: 'FAILED' }, { expectedRequestId: 'sr-STALE' })).toBe(false);

    const rows = await db.auditLog.findMany({ where: { applicationId, entity: 'CONTRACT' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'CONTRACT_SIGNING_UPDATED', orgId: SEED.org.id, afterJson: { signingStatus: 'DECLINED', signingFailureReason: 'DECLINED' } });
  });

  it('DB-ийн CHECK constraint: SIGNED нь signed_file_id-гүй байж болохгүй; үл мэдэгдэх төлөв/суваг татгалзана', async () => {
    const applicationId = `app-${crypto.randomUUID()}`;
    await seedContract(db, { applicationId });
    await expect(db.contract.update({ where: { applicationId }, data: { signingStatus: 'SIGNED' } })).rejects.toThrow();
    await expect(db.contract.update({ where: { applicationId }, data: { signingStatus: 'WHATEVER' } })).rejects.toThrow();
    await expect(db.contract.update({ where: { applicationId }, data: { signChannel: 'FAX' } })).rejects.toThrow();
    await expect(db.contract.update({ where: { applicationId }, data: { signingStatus: 'SIGNED', signedFileId: 'f-1' } })).resolves.toMatchObject({ signingStatus: 'SIGNED' });
  });
});
