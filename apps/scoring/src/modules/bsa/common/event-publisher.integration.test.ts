// PrismaEventPublisher — БОДИТ PostgreSQL + Prisma транзакцийн клиент дээр. TEST_DATABASE_URL тохируулаагүй бол алгасна.
// Урьдчилсан нөхцөл: тест DB-д packages/database/init/00-schemas.sql хэрэглэсэн (scoring.outbox). АНХААР: scoring.outbox-ийг TRUNCATE хийнэ →
// DB-ийн нэрэнд "test" агуулагдах ёстой (persistence тестийн дүрэмтэй ижил).
import { PrismaClient, type Prisma } from '../../../../node_modules/.prisma/client-scoring';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildStatementImportedEvent, InvalidDomainEventError, PrismaEventPublisher } from './event-publisher';

const URL_ = process.env.TEST_DATABASE_URL;
const ctx = { orgId: 'org-1', correlationId: 'corr-1', userId: 'user-7' };
const ids = ['6f1b2c3d-1111-4111-8111-000000000001', '6f1b2c3d-2222-4222-8222-000000000002'];
const event = (n: number, rows = 10) =>
  buildStatementImportedEvent(
    { analysisId: `an-${n}`, applicationId: 'app-1', rows, status: 'COMPLETED', ctx },
    { uuid: () => ids[n - 1], now: () => new Date('2026-10-28T03:04:05.678Z') },
  );

/** Compile-time: бодит Prisma транзакцийн клиент нь publisher-ийн хүлээдэг `outbox.createMany`-тай (schema өөрчлөгдвөл энд tsc унана) */
type HasOutboxCreateMany = Prisma.TransactionClient extends { outbox: { createMany: (...args: never[]) => unknown } } ? true : false;
const compatibleWithPrisma: HasOutboxCreateMany = true;

describe.skipIf(!URL_)('PrismaEventPublisher (real PostgreSQL, TEST_DATABASE_URL)', () => {
  const publisher = new PrismaEventPublisher();
  let prisma: PrismaClient;

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(URL_!).pathname.slice(1));
    if (!/test/i.test(dbName)) throw new Error('TEST_DATABASE_URL must point to a database whose name contains "test": refusing to TRUNCATE');
    prisma = new PrismaClient({ datasourceUrl: URL_, log: [] });
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });
  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE "scoring"."outbox"');
  });

  it('knows the Prisma client shape', () => {
    expect(compatibleWithPrisma).toBe(true);
  });

  it('writes {id: eventId, type, payload} in the caller transaction', async () => {
    await prisma.$transaction((tx) => publisher.enqueue(tx, event(1)));
    const row = await prisma.outbox.findUniqueOrThrow({ where: { id: ids[0] } });
    expect(row).toMatchObject({ id: ids[0], type: 'StatementImported', publishedAt: null });
    expect(row.payload).toEqual(event(1));
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it('rolls the event back together with the business transaction', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await publisher.enqueue(tx, event(1));
        throw new Error('business write failed');
      }),
    ).rejects.toThrow('business write failed');
    expect(await prisma.outbox.count()).toBe(0);
  });

  it('a duplicate eventId is ignored and does NOT abort the surrounding transaction (later business writes still commit)', async () => {
    await prisma.$transaction(async (tx) => {
      await publisher.enqueue(tx, event(1));
      await publisher.enqueue(tx, event(1, 99)); // давхар
      await publisher.enqueue(tx, event(2)); // дараагийн бичилт ажиллана
    });
    expect(await prisma.outbox.count()).toBe(2);
    await prisma.$transaction((tx) => publisher.enqueue(tx, event(1, 12345))); // өөр транзакцид ч давхар
    expect(await prisma.outbox.count()).toBe(2);
    expect((await prisma.outbox.findUniqueOrThrow({ where: { id: ids[0] } })).payload).toEqual(event(1)); // анхных дарагдаагүй
  });

  it('why createMany(skipDuplicates): catching a unique violation of `create` leaves the PostgreSQL transaction aborted', async () => {
    await prisma.outbox.create({ data: { id: ids[0], type: 'StatementImported', payload: event(1) } });
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.outbox.create({ data: { id: ids[0], type: 'StatementImported', payload: event(1) } }).catch(() => undefined); // "барьсан"
        await tx.outbox.create({ data: { id: ids[1], type: 'StatementImported', payload: event(2) } }); // → "transaction is aborted"
      }),
    ).rejects.toThrow(/aborted|25P02/);
    expect(await prisma.outbox.count()).toBe(1);
  });

  it('rejects an invalid event before writing, and the caller transaction stays usable', async () => {
    await prisma.$transaction(async (tx) => {
      await expect(publisher.enqueue(tx, { ...event(1), version: 2 } as never)).rejects.toBeInstanceOf(InvalidDomainEventError);
      await publisher.enqueue(tx, event(2));
    });
    expect((await prisma.outbox.findMany()).map((r) => r.id)).toEqual([ids[1]]);
  });
});
