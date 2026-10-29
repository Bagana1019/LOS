import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '.prisma/client-dms';
import { createFieldCrypto } from '@los/database';
import { DatabaseFieldCipher } from '../adapters/database-field-cipher';
import { DbOperationError } from './db-errors';
import { PrismaSigningStore } from './prisma-signing.store';
import { CONTRACT_TEST_ORG, audit, certificate, createTestClock, newRequest, requestedEvent, signedPatch, signingStoreContract } from './signing-store.contract';

// Бодит Postgres: TEST_DATABASE_URL (apps/dms/test/setup-env.ts DATABASE_URL-д `?schema=dms`-тэй тавина); байхгүй бол алгасна
const reachable = !!process.env.TEST_DATABASE_URL;
const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL ?? 'postgresql://unused:unused@127.0.0.1:1/unused' });
const cipher = new DatabaseFieldCipher();

async function cleanup(): Promise<void> {
  await prisma.signingEvent.deleteMany({ where: { signingRequest: { orgId: CONTRACT_TEST_ORG } } });
  await prisma.signingRequest.deleteMany({ where: { orgId: CONTRACT_TEST_ORG } });
  await prisma.outbox.deleteMany({ where: { payload: { path: ['orgId'], equals: CONTRACT_TEST_ORG } } });
}

afterAll(async () => {
  if (reachable) await cleanup();
  await prisma.$disconnect();
});

describe.skipIf(!reachable)('PrismaSigningStore (Postgres)', () => {
  signingStoreContract('PrismaSigningStore', {
    create: (clock) => ({
      store: new PrismaSigningStore(prisma, clock, cipher),
      outbox: async () => {
        const rows = await prisma.outbox.findMany({ where: { payload: { path: ['orgId'], equals: CONTRACT_TEST_ORG } }, orderBy: { id: 'asc' } });
        return rows.map((row) => ({ id: row.id, type: row.type, payload: row.payload }));
      },
    }),
    cleanup,
  });

  describe('Postgres тусгай', () => {
    const time = createTestClock();
    const store = new PrismaSigningStore(prisma, time.clock, cipher);

    it('гэрчилгээний регистр DB-д шифрлэгдсэн (plaintext байхгүй), store-оор уншихад задарна', async () => {
      try {
        const created = await store.create(newRequest());
        await store.transition(created.id, ['PENDING'], signedPatch({ certificate: certificate({ subjectRegisterNo: 'УА12345678' }) }));

        const [raw] = await prisma.$queryRaw<Array<{ certificate: string }>>`SELECT certificate::text AS certificate FROM dms.signing_request WHERE id = ${created.id}::uuid`;
        expect(raw.certificate).not.toContain('УА12345678');
        expect(raw.certificate).toMatch(/v1\./);
        expect((await store.getById(created.id))?.certificate?.subjectRegisterNo).toBe('УА12345678');
      } finally {
        await cleanup();
      }
    });

    it('түлхүүр буруу бол гэрчилгээг задлахгүй: алдаа, мессежид регистр байхгүй', async () => {
      try {
        const created = await store.create(newRequest());
        await store.transition(created.id, ['PENDING'], signedPatch({ certificate: certificate({ subjectRegisterNo: 'УА12345678' }) }));

        const other = createFieldCrypto({ keys: { other: Buffer.alloc(32, 7) }, currentKeyId: 'other', indexKey: Buffer.alloc(32, 9) });
        const wrongKey = new PrismaSigningStore(prisma, time.clock, { encrypt: (plain) => other.encrypt(plain), decrypt: (text) => other.decrypt(text) });
        const error = await wrongKey.getById(created.id).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).not.toContain('УА12345678');
      } finally {
        await cleanup();
      }
    });

    it('нэг гэрээний хоёр идэвхтэй мөрийг DB өөрөө (store-оос өнгөрсөн ч) partial unique index-ээр татгалзана', async () => {
      const contractId = `contract-${randomUUID()}`;
      const base = newRequest({ contractId });
      const insert = (id: string, tokenHash: string, status: string): Promise<number> => prisma.$executeRaw`
        INSERT INTO dms.signing_request (id, org_id, application_id, contract_id, contract_no, status, source_file_id, original_sha256, signer_customer_id, signer_name,
          signer_register_encrypted, signer_phone_encrypted, signer_register_masked, signer_phone_masked, token_hash, link_expires_at, correlation_id)
        VALUES (${id}::uuid, ${CONTRACT_TEST_ORG}, ${base.applicationId}, ${contractId}, ${base.contractNo}, ${status}, ${base.sourceFileId}, ${base.originalSha256}, ${base.signerCustomerId},
          ${base.signerName}, 'e', 'e', 'm', 'm', ${tokenHash}, now(), ${base.correlationId})`;
      try {
        await insert(randomUUID(), randomUUID(), 'PENDING');
        // 23505 = unique_violation (contract_id), 23514 = check_violation
        await expect(insert(randomUUID(), randomUUID(), 'FINALIZING')).rejects.toThrow(/23505[\s\S]*contract_id/);
        await expect(insert(randomUUID(), randomUUID(), 'SIGNED')).rejects.toThrow(/23514/);
        await expect(insert(randomUUID(), randomUUID(), 'CANCELLED')).resolves.toBe(1);
      } finally {
        await cleanup();
      }
    });

    it('миграцийн partial unique index үнэхээр байгаа (WHERE идэвхтэй төлвүүд)', async () => {
      const [index] = await prisma.$queryRaw<Array<{ definition: string }>>`
        SELECT indexdef AS definition FROM pg_indexes WHERE schemaname = 'dms' AND indexname = 'signing_request_active_contract_key'`;
      expect(index.definition).toMatch(/UNIQUE INDEX/);
      expect(index.definition).toMatch(/\(contract_id\)/);
      expect(index.definition).toMatch(/PENDING.*IN_PROGRESS.*FINALIZING/);
    });

    it('аудит мөр нь FK-аар хүсэлтэд холбогдсон: хүсэлтгүй мөр DB-д орохгүй', async () => {
      await expect(prisma.signingEvent.create({ data: { signingRequestId: randomUUID(), type: 'OPENED', actor: 'SYSTEM', at: new Date() } })).rejects.toMatchObject({ code: 'P2003' });
    });

    it('outbox мөр published_at = null-тай үүснэ (relay хараахан нийтлээгүй)', async () => {
      try {
        const input = newRequest();
        const event = requestedEvent(input);
        await store.create(input, { events: [event], audit: [audit('CREATED', time.now())] });
        const row = await prisma.outbox.findUniqueOrThrow({ where: { id: event.eventId } });
        expect(row.publishedAt).toBeNull();
        expect(row.payload).toEqual(event);
      } finally {
        await cleanup();
      }
    });
  });
});

describe('PrismaSigningStore (DB-д хүрэхгүй үед)', () => {
  it('дэд бүтцийн алдаа PII-гүй DbOperationError болно (Prisma код л үлдэнэ)', async () => {
    const unreachable = new PrismaClient({ datasourceUrl: 'postgresql://los:secret-pw@127.0.0.1:1/los' });
    try {
      const store = new PrismaSigningStore(unreachable, createTestClock().clock, cipher);
      const error = await store.getByTokenHash('0'.repeat(64)).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(DbOperationError);
      expect((error as Error).message).toBe('database operation failed: signing.getByTokenHash (INIT)');
      expect((error as Error).message).not.toContain('secret-pw');
    } finally {
      await unreachable.$disconnect();
    }
  });
});
