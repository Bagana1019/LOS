// F8-9 (DB): PATCH-ийн `expectedUpdatedAt` бодит PostgreSQL дээр. Юуг баталгаажуулах вэ:
//  - `updatedAt` нь timestamp(3)-аар хадгалагдаж ISO мөр болон буцахад ИЖИЛ утга (форм үүнийг шууд буцааж илгээдэг);
//  - хуучирсан утга → 409 BLACKLIST_STALE, мөр өөрчлөгдөхгүй; зэрэг ирсэн 2 засвараас яг нэг нь хожно.
// TEST_DATABASE_URL байхгүй бол алгасна. Тест бүр өвөрмөц org-той.
import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../../prisma.service';
import { ChangeHandlerRegistry } from '../maker-checker/change-handler';
import { PrismaChangeRequestStore } from '../maker-checker/infra/prisma-change-request.store';
import { MakerCheckerService } from '../maker-checker/maker-checker.service';
import { TestClock } from '../maker-checker/testing/fixtures';
import { BlacklistCreateBody, BlacklistPatchBody } from './blacklist.schemas';
import { BlacklistService } from './blacklist.service';
import { PrismaBlacklistRepository, type BlacklistPrismaClient } from './prisma-blacklist.repository';
import { adminCtx, entryInput, fakeCipher, fixedSettings } from './test-support';

const URL = process.env.TEST_DATABASE_URL;
const STALE = { code: 'BLACKLIST_STALE', message: 'Бичлэг өөр хэрэглэгчээр өөрчлөгдсөн байна. Хуудсаа шинэчлээд дахин оролдоно уу' };

describe.skipIf(!URL)('blacklist edit optimistic concurrency on PostgreSQL (F8-9)', () => {
  let prisma: PrismaService;
  let bl: BlacklistService;
  let org: string;

  beforeAll(() => { prisma = new PrismaService({ datasources: { db: { url: URL! } } }); }, 30_000);
  afterAll(async () => { await prisma?.$disconnect(); });
  beforeEach(() => {
    org = `it-${randomUUID().slice(0, 8)}`;
    // Бодит цаг: updatedAt нь тест бүрт өөр, ms-ийн нарийвчлалтай (TestClock-ийн тогтмол цаг хоёр засварыг ялгахгүй байх байсан)
    const clock = { now: () => new Date() };
    const mc = new MakerCheckerService(new PrismaChangeRequestStore(prisma), new ChangeHandlerRegistry(), new TestClock());
    bl = new BlacklistService(new PrismaBlacklistRepository(prisma as unknown as BlacklistPrismaClient), fakeCipher, clock, { uuid: randomUUID }, mc, fixedSettings(12));
  });

  const ctx = () => adminCtx({ orgId: org, userId: 'it-user', branchId: 'B1' });
  const grey = () => BlacklistCreateBody.parse(entryInput({ severity: 'GREY' }));
  const patch = (body: Record<string, unknown>) => BlacklistPatchBody.parse(body);
  const outcome = (p: Promise<unknown>) => p.then(() => 'ok' as const, (e: unknown) => e);

  it('the updatedAt returned by create round-trips through the database unchanged (get, list, update)', async () => {
    const created = await bl.create(ctx(), grey());
    expect(created.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect((await bl.get(ctx(), created.id)).updatedAt).toBe(created.updatedAt);
    const [listed] = (await bl.list(ctx(), { limit: 10, offset: 0 })).items;
    expect(listed?.updatedAt).toBe(created.updatedAt);
  });

  it('an edit that echoes the loaded updatedAt succeeds; replaying the same (now outdated) value answers 409 and changes nothing', async () => {
    const created = await bl.create(ctx(), grey());
    const first = await bl.update(ctx(), created.id, patch({ name: 'A-гийн нэр', expectedUpdatedAt: created.updatedAt }));
    expect(first.name).toBe('A-гийн нэр');
    expect(first.updatedAt).not.toBe(created.updatedAt);

    const stale = await outcome(bl.update(ctx(), created.id, patch({ reasonText: 'B-гийн шалтгаан', expectedUpdatedAt: created.updatedAt })));
    expect(stale).toBeInstanceOf(ConflictException);
    expect((stale as ConflictException).getResponse()).toEqual(STALE);
    expect(await bl.get(ctx(), created.id)).toMatchObject({ name: 'A-гийн нэр', reasonText: created.reasonText, updatedAt: first.updatedAt });
  });

  it('two concurrent edits carrying the same loaded updatedAt: exactly one wins, the other gets the coded 409, no lost update', async () => {
    const created = await bl.create(ctx(), grey());
    const results = await Promise.all([
      outcome(bl.update(ctx(), created.id, patch({ name: 'Tab A', expectedUpdatedAt: created.updatedAt }))),
      outcome(bl.update(ctx(), created.id, patch({ name: 'Tab B', expectedUpdatedAt: created.updatedAt }))),
    ]);
    const winners = results.filter((r) => r === 'ok');
    const losers = results.filter((r): r is ConflictException => r instanceof ConflictException);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]?.getResponse()).toEqual(STALE);
    const stored = await bl.get(ctx(), created.id);
    expect(['Tab A', 'Tab B']).toContain(stored.name);
  });

  it('without the field a second edit from an old form still applies (backwards compatible)', async () => {
    const created = await bl.create(ctx(), grey());
    await bl.update(ctx(), created.id, patch({ name: 'A-гийн нэр' }));
    expect(await bl.update(ctx(), created.id, patch({ reasonText: 'B-гийн шалтгаан' }))).toMatchObject({ name: 'A-гийн нэр', reasonText: 'B-гийн шалтгаан' });
  });
});
