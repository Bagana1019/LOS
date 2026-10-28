import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashRegisterNo } from '@los/database';
import { adminCtx, entryInput, FixedClock, fakeCipher, gateReads } from './test-support';
import { ConflictException } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import type { BlacklistPrismaClient } from './prisma-blacklist.repository';
import { DuplicateBlacklistEntryError, StaleBlacklistEntryError, type BlacklistChangedEvent, type BlacklistRow } from './blacklist.repository';
import { BlacklistCreateBody, BlacklistListQuery, BlacklistPatchBody } from './blacklist.schemas';
import { BlacklistService } from './blacklist.service';
import { PrismaBlacklistRepository } from './prisma-blacklist.repository';

// Бодит Postgres (TEST_DATABASE_URL, migrate хийгдсэн — test/global-setup.ts) шаардана. Тест бүр өөрийн orgId-тай тул хүснэгт цэвэрлэхгүй.
describe.skipIf(!process.env.TEST_DATABASE_URL)('PrismaBlacklistRepository (Postgres)', () => {
  let prisma: PrismaService;
  let repo: PrismaBlacklistRepository;
  let orgId: string;
  const clock = new FixedClock();
  const ids = { uuid: () => randomUUID() };

  beforeAll(async () => {
    prisma = new PrismaService();
    repo = new PrismaBlacklistRepository(prisma as unknown as BlacklistPrismaClient);
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    vi.unstubAllEnvs();
  });
  beforeEach(() => {
    orgId = `org-${randomUUID()}`;
  });

  const key = (registerNo: string) => hashRegisterNo(registerNo);
  const makeRow = (over: Partial<BlacklistRow> = {}): BlacklistRow => ({
    id: randomUUID(), orgId, branchId: 'branch-1', registerNoEncrypted: fakeCipher.encrypt('УБ12345678'), registerNoHash: key('УБ12345678'),
    customerType: 'INDIVIDUAL', name: 'Бат Болд', listType: 'DELINQUENT', reasonCode: 'LATE_PAYMENT', reasonText: 'text',
    registeredBy: 'user-1', registeredAt: new Date('2026-10-28T09:00:00.123Z'), isActive: true,
    createdAt: new Date('2026-10-28T09:00:00.123Z'), updatedAt: new Date('2026-10-28T09:00:00.123Z'), createdBy: 'user-1', updatedBy: 'user-1', ...over,
  });
  const makeEvent = (row: BlacklistRow, over: Partial<BlacklistChangedEvent> = {}): BlacklistChangedEvent => ({
    type: 'BlacklistEntryChanged', eventId: randomUUID(), occurredAt: '2026-10-28T09:00:00.123Z', version: 1, orgId: row.orgId, actorId: 'user-1',
    correlationId: 'corr-1', entryId: row.id, registerNoHash: row.registerNoHash, customerType: row.customerType, name: row.name,
    listType: row.listType, reasonCode: row.reasonCode, isActive: row.isActive, changedAt: '2026-10-28T09:00:00.123Z', ...over,
  });
  const outbox = (eventId: string) => prisma.outbox.findUnique({ where: { id: eventId } });

  describe('saveWithEvent', () => {
    it('inserts the row and the outbox event (id = eventId, unpublished) and round-trips every column', async () => {
      const row = makeRow();
      const event = makeEvent(row);
      await repo.saveWithEvent(row, event, null);

      expect(await repo.findById(orgId, row.id)).toEqual(row);
      expect(await outbox(event.eventId)).toMatchObject({ id: event.eventId, type: 'BlacklistEntryChanged', payload: event, publishedAt: null });
    });

    it('updates an existing row by id together with a new event', async () => {
      const row = makeRow();
      await repo.saveWithEvent(row, makeEvent(row), null);
      const changed = makeRow({ ...row, name: 'Өөрчлөгдсөн', isActive: false, updatedBy: 'user-2', updatedAt: new Date('2026-10-28T10:00:00.000Z') });
      const event = makeEvent(changed);
      await repo.saveWithEvent(changed, event, row.updatedAt);

      expect(await repo.findById(orgId, row.id)).toEqual(changed);
      expect(await outbox(event.eventId)).toMatchObject({ payload: { name: 'Өөрчлөгдсөн', isActive: false } });
      expect(await prisma.blacklist.count({ where: { orgId } })).toBe(1);
    });

    it('rolls the row back when the outbox insert fails (insert)', async () => {
      const first = makeRow({ registerNoHash: key('АА00000001') });
      const taken = makeEvent(first);
      await repo.saveWithEvent(first, taken, null);

      const second = makeRow({ registerNoHash: key('АА00000002') });
      await expect(repo.saveWithEvent(second, makeEvent(second, { eventId: taken.eventId }), null)).rejects.not.toBeInstanceOf(DuplicateBlacklistEntryError);

      expect(await repo.findById(orgId, second.id)).toBeNull();
      expect(await prisma.blacklist.count({ where: { orgId } })).toBe(1);
    });

    it('rolls the row back when the outbox insert fails (update keeps the previous values)', async () => {
      const row = makeRow();
      const taken = makeEvent(row);
      await repo.saveWithEvent(row, taken, null);

      const changed = makeRow({ ...row, name: 'Never persisted' });
      await expect(repo.saveWithEvent(changed, makeEvent(changed, { eventId: taken.eventId }), row.updatedAt)).rejects.toThrow();

      expect(await repo.findById(orgId, row.id)).toMatchObject({ name: 'Бат Болд' });
    });

    it('raises DuplicateBlacklistEntryError on a (org, register hash, listType) clash and writes no event', async () => {
      const row = makeRow();
      await repo.saveWithEvent(row, makeEvent(row), null);
      const clash = makeRow();
      const event = makeEvent(clash);

      await expect(repo.saveWithEvent(clash, event, null)).rejects.toBeInstanceOf(DuplicateBlacklistEntryError);
      expect(await outbox(event.eventId)).toBeNull();
      expect(await repo.findById(orgId, clash.id)).toBeNull();
    });

    it('allows the same register under another listType or org', async () => {
      const row = makeRow();
      await repo.saveWithEvent(row, makeEvent(row), null);
      const otherList = makeRow({ listType: 'FRAUD' });
      const otherOrg = makeRow({ orgId: `${orgId}-b` });
      await repo.saveWithEvent(otherList, makeEvent(otherList), null);
      await repo.saveWithEvent(otherOrg, makeEvent(otherOrg), null);
      expect(await prisma.blacklist.count({ where: { registerNoHash: row.registerNoHash, orgId: { in: [orgId, `${orgId}-b`] } } })).toBe(3);
    });

    it('raises DuplicateBlacklistEntryError when an update moves a row onto another row\'s key', async () => {
      const a = makeRow({ registerNoHash: key('АА00000001') });
      const b = makeRow({ registerNoHash: key('АА00000002') });
      await repo.saveWithEvent(a, makeEvent(a), null);
      await repo.saveWithEvent(b, makeEvent(b), null);
      const moved = makeRow({ ...b, registerNoHash: a.registerNoHash });
      await expect(repo.saveWithEvent(moved, makeEvent(moved), b.updatedAt)).rejects.toBeInstanceOf(DuplicateBlacklistEntryError);
      expect(await repo.findById(orgId, b.id)).toMatchObject({ registerNoHash: b.registerNoHash });
    });
  });

  // [24]/[28] Шинэчлэлт нь updatedAt дээрх compare-and-set (мөр + outbox нэг транзакцид).
  describe('saveWithEvent compare-and-set', () => {
    const insert = async (over: Partial<BlacklistRow> = {}) => {
      const row = makeRow(over);
      await repo.saveWithEvent(row, makeEvent(row), null);
      return row;
    };
    const eventsOf = (entryId: string) => prisma.outbox.findMany({ where: { payload: { path: ['entryId'], equals: entryId } } });

    it('rejects a stale expectedUpdatedAt with StaleBlacklistEntryError: row unchanged, no outbox event', async () => {
      const row = await insert();
      const stale = makeRow({ ...row, name: 'Stale write', updatedAt: new Date('2026-10-28T10:00:00.000Z') });
      const event = makeEvent(stale);

      await expect(repo.saveWithEvent(stale, event, new Date('2026-10-28T08:00:00.000Z'))).rejects.toBeInstanceOf(StaleBlacklistEntryError);

      expect(await repo.findById(orgId, row.id)).toEqual(row);
      expect(await outbox(event.eventId)).toBeNull();
    });

    it('matches expectedUpdatedAt to the millisecond and stores the explicit updatedAt (Prisma @updatedAt must not override it)', async () => {
      const row = await insert({ updatedAt: new Date('2026-10-28T09:00:00.456Z') });
      const second = makeRow({ ...row, name: 'Second', updatedAt: new Date('2026-10-28T09:00:00.457Z') });
      await expect(repo.saveWithEvent(second, makeEvent(second), new Date('2026-10-28T09:00:00.455Z'))).rejects.toBeInstanceOf(StaleBlacklistEntryError);
      await expect(repo.saveWithEvent(second, makeEvent(second), new Date('2026-10-28T09:00:00.457Z'))).rejects.toBeInstanceOf(StaleBlacklistEntryError);
      await repo.saveWithEvent(second, makeEvent(second), new Date('2026-10-28T09:00:00.456Z'));

      expect((await repo.findById(orgId, row.id))?.updatedAt.toISOString()).toBe('2026-10-28T09:00:00.457Z');
      const third = makeRow({ ...second, name: 'Third', updatedAt: new Date('2026-10-28T09:00:00.458Z') });
      await repo.saveWithEvent(third, makeEvent(third), second.updatedAt);
      expect(await repo.findById(orgId, row.id)).toEqual(third);
    });

    it('does not upsert: updating an id that does not exist is stale, not a create', async () => {
      const ghost = makeRow();
      const event = makeEvent(ghost);
      await expect(repo.saveWithEvent(ghost, event, ghost.updatedAt)).rejects.toBeInstanceOf(StaleBlacklistEntryError);
      expect(await repo.findById(orgId, ghost.id)).toBeNull();
      expect(await outbox(event.eventId)).toBeNull();
    });

    it('scopes the compare-and-set by org: a row of another org with the same id is not updated', async () => {
      const row = await insert();
      const otherOrg = makeRow({ ...row, orgId: `${orgId}-other`, name: 'Cross-org write' });
      await expect(repo.saveWithEvent(otherOrg, makeEvent(otherOrg), row.updatedAt)).rejects.toBeInstanceOf(StaleBlacklistEntryError);
      expect(await repo.findById(orgId, row.id)).toEqual(row);
    });

    it('treats a create over an existing id as a duplicate and writes no event', async () => {
      const row = await insert();
      const again = makeRow({ ...row, name: 'Again' });
      const event = makeEvent(again);
      await expect(repo.saveWithEvent(again, event, null)).rejects.toBeInstanceOf(DuplicateBlacklistEntryError);
      expect(await outbox(event.eventId)).toBeNull();
      expect(await repo.findById(orgId, row.id)).toEqual(row);
    });

    it('lets exactly one of N concurrent writes based on the same version win; the others write neither row nor event', async () => {
      const row = await insert();
      const attempts = Array.from({ length: 6 }, (_, i) => {
        const next = makeRow({ ...row, name: `Writer ${i}`, updatedAt: new Date('2026-10-28T09:00:01.000Z') });
        return { next, event: makeEvent(next) };
      });

      const results = await Promise.allSettled(attempts.map(({ next, event }) => repo.saveWithEvent(next, event, row.updatedAt)));

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').forEach((r) => expect(r.reason).toBeInstanceOf(StaleBlacklistEntryError));
      const winner = results.findIndex((r) => r.status === 'fulfilled');
      expect((await repo.findById(orgId, row.id))?.name).toBe(`Writer ${winner}`);
      const events = await eventsOf(row.id);
      expect(events).toHaveLength(2); // эхний үүсгэлт + ялагч
      expect(await Promise.all(attempts.map((a) => outbox(a.event.eventId)))).toEqual(attempts.map((_, i) => (i === winner ? expect.anything() : null)));
    });
  });

  describe('finders', () => {
    it('findById is org-scoped and findByKey matches the unique key', async () => {
      const row = makeRow();
      await repo.saveWithEvent(row, makeEvent(row), null);

      expect(await repo.findById(orgId, row.id)).not.toBeNull();
      expect(await repo.findById(`${orgId}-x`, row.id)).toBeNull();
      expect(await repo.findByKey(orgId, row.registerNoHash, 'DELINQUENT')).toMatchObject({ id: row.id });
      expect(await repo.findByKey(orgId, row.registerNoHash, 'FRAUD')).toBeNull();
      expect(await repo.findByKey(`${orgId}-x`, row.registerNoHash, 'DELINQUENT')).toBeNull();
    });
  });

  describe('list', () => {
    const seed = async () => {
      const rows = [
        makeRow({ registerNoHash: key('АА00000001'), name: 'Бат Болд', registeredAt: new Date('2026-10-28T09:00:00Z') }),
        makeRow({ registerNoHash: key('АА00000002'), name: 'Сарангэрэл', listType: 'FRAUD', registeredAt: new Date('2026-10-28T10:00:00Z') }),
        makeRow({ registerNoHash: key('АА00000003'), name: '100% Discount_Co', isActive: false, registeredAt: new Date('2026-10-28T11:00:00Z') }),
      ];
      for (const r of rows) await repo.saveWithEvent(r, makeEvent(r), null);
      return rows;
    };
    const base = { limit: 20, offset: 0 };

    it('orders by registeredAt desc with total, and paginates', async () => {
      const rows = await seed();
      const all = await repo.list(orgId, base);
      expect(all.total).toBe(3);
      expect(all.items.map((r) => r.id)).toEqual([rows[2].id, rows[1].id, rows[0].id]);
      const page = await repo.list(orgId, { limit: 1, offset: 1 });
      expect(page.total).toBe(3);
      expect(page.items.map((r) => r.id)).toEqual([rows[1].id]);
    });

    it('filters by listType and isActive and is org-scoped', async () => {
      const rows = await seed();
      expect((await repo.list(orgId, { ...base, listType: 'FRAUD' })).items.map((r) => r.id)).toEqual([rows[1].id]);
      expect((await repo.list(orgId, { ...base, isActive: false })).items.map((r) => r.id)).toEqual([rows[2].id]);
      expect((await repo.list(orgId, { ...base, isActive: true })).total).toBe(2);
      expect((await repo.list(`${orgId}-x`, base)).total).toBe(0);
    });

    it('searches a name substring case-insensitively (Cyrillic included) or an exact register hash', async () => {
      const rows = await seed();
      const search = (text: string, registerNoHash = 'no-such-hash') => repo.list(orgId, { ...base, search: { text, registerNoHash } });

      expect((await search('БОЛД')).items.map((r) => r.id)).toEqual([rows[0].id]);
      expect((await search('сарангэ')).items.map((r) => r.id)).toEqual([rows[1].id]);
      expect((await search('zzz', key('АА00000001'))).items.map((r) => r.id)).toEqual([rows[0].id]);
      expect((await search('сарангэ', key('АА00000001'))).items.map((r) => r.id)).toEqual([rows[1].id, rows[0].id]);
    });

    it('treats LIKE wildcards in the search text literally', async () => {
      const rows = await seed();
      const search = (text: string) => repo.list(orgId, { ...base, search: { text, registerNoHash: 'no-such-hash' } });

      expect((await search('%')).items.map((r) => r.id)).toEqual([rows[2].id]);
      expect((await search('_')).items.map((r) => r.id)).toEqual([rows[2].id]);
      expect((await search('0% D')).items.map((r) => r.id)).toEqual([rows[2].id]);

      const backslash = makeRow({ registerNoHash: key('АА00000004'), name: 'Back\\slash' });
      await repo.saveWithEvent(backslash, makeEvent(backslash), null);
      expect((await search('k\\s')).items.map((r) => r.id)).toEqual([backslash.id]);
    });
  });

  describe('BlacklistService on Postgres', () => {
    it('imports with upsert semantics and writes one outbox event per created/updated row, none for skipped', async () => {
      const service = new BlacklistService(repo, fakeCipher, clock, ids);
      const ctx = adminCtx({ orgId });
      const first = await service.create(ctx, BlacklistCreateBody.parse(entryInput({ registerNo: 'УБ11111111' })));
      const second = await service.create(ctx, BlacklistCreateBody.parse(entryInput({ registerNo: 'УБ22222222' })));
      await service.deactivate(ctx, second.id);
      const eventsBefore = await prisma.outbox.count({ where: { payload: { path: ['orgId'], equals: orgId } } });

      const result = await service.importRows(ctx, [
        { row: 1, data: entryInput({ registerNo: 'УБ11111111' }) },
        { row: 2, data: entryInput({ registerNo: 'УБ22222222', name: 'Дахин идэвхжсэн' }) },
        { row: 3, data: entryInput({ registerNo: 'УБ33333333' }) },
        { row: 4, data: entryInput({ registerNo: 'УБ44444444', customerType: 'ROBOT' }) },
      ]);

      expect(result).toMatchObject({ created: 1, updated: 1, skipped: 1, errors: [{ row: 4 }] });
      expect(await service.get(ctx, second.id)).toMatchObject({ isActive: true, name: 'Дахин идэвхжсэн', registerNo: 'УБ22222222' });
      expect(await service.get(ctx, first.id)).toMatchObject({ isActive: true });
      expect(await prisma.outbox.count({ where: { payload: { path: ['orgId'], equals: orgId } } })).toBe(eventsBefore + 2);
      expect(await prisma.blacklist.count({ where: { orgId } })).toBe(3);
    });

    it('lists through the hash for a register query and keeps the stored register encrypted', async () => {
      const service = new BlacklistService(repo, fakeCipher, clock, ids);
      const ctx = adminCtx({ orgId });
      await service.create(ctx, BlacklistCreateBody.parse(entryInput({ registerNo: 'УБ11111111', name: 'Бат' })));
      await service.create(ctx, BlacklistCreateBody.parse(entryInput({ registerNo: 'УБ22222222', name: 'Дорж' })));

      const page = await service.list(ctx, BlacklistListQuery.parse({ q: 'уб-2222 2222' }));
      expect(page.items.map((i) => i.name)).toEqual(['Дорж']);
      const raw = await prisma.blacklist.findMany({ where: { orgId } });
      expect(JSON.stringify(raw)).not.toContain('УБ22222222');
    });

    // [24]/[28] Зэрэг PATCH-ууд: чимээгүй алдагдал байхгүй, kyc-д очих сүүлийн event нь DB-ийн эцсийн мөртэй таарна.
    describe('concurrent PATCH', () => {
      const eventsOf = async (entryId: string) => {
        const rows = await prisma.outbox.findMany({ where: { payload: { path: ['entryId'], equals: entryId } } });
        return rows.map((r) => r.payload as unknown as BlacklistChangedEvent).sort((a, b) => Date.parse(a.changedAt) - Date.parse(b.changedAt));
      };
      const setup = async (i: number) => {
        const writer = new BlacklistService(repo, fakeCipher, new FixedClock(), ids);
        const ctx = adminCtx({ orgId });
        const entry = await writer.create(ctx, BlacklistCreateBody.parse(entryInput({ registerNo: `УБ9000000${i}` })));
        await writer.deactivate(ctx, entry.id);
        return { ctx, id: entry.id, writer };
      };
      const toggle = BlacklistPatchBody.parse({ isActive: true });
      const correct = BlacklistPatchBody.parse({ reasonCode: 'CORRECTED' });

      it('lets exactly one of PATCH {isActive:true} and PATCH {reasonCode} win and answers 409 to the other (both read the same version)', async () => {
        for (let i = 0; i < 8; i++) {
          const { ctx, id } = await setup(i);
          const gated = new BlacklistService(gateReads(repo, 2), fakeCipher, new FixedClock(), ids);

          const results = await Promise.allSettled([gated.update(ctx, id, toggle), gated.update(ctx, id, correct)]);

          expect(results.filter((r) => r.status === 'fulfilled'), `iteration ${i}`).toHaveLength(1);
          const loser = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
          expect(loser?.reason).toBeInstanceOf(ConflictException);
          expect((loser?.reason as ConflictException).getStatus()).toBe(409);
          expect((loser?.reason as ConflictException).message).toContain('modified concurrently');

          const row = await repo.findById(orgId, id);
          const events = await eventsOf(id);
          expect(events).toHaveLength(3); // create, deactivate, ялагч
          const winnerIsToggle = results[0].status === 'fulfilled';
          expect(row).toMatchObject(winnerIsToggle ? { isActive: true, reasonCode: 'LATE_PAYMENT' } : { isActive: false, reasonCode: 'CORRECTED' });
          expect(events.at(-1)).toMatchObject({ isActive: row?.isActive, reasonCode: row?.reasonCode, changedAt: row?.updatedAt.toISOString() });
          const times = events.map((e) => Date.parse(e.changedAt));
          times.forEach((t, k) => k > 0 && expect(t).toBeGreaterThan(times[k - 1]));
        }
      });

      it('applies both changes once the loser retries', async () => {
        const { ctx, id, writer } = await setup(20);
        const gated = new BlacklistService(gateReads(repo, 2), fakeCipher, new FixedClock(), ids);
        const results = await Promise.allSettled([gated.update(ctx, id, toggle), gated.update(ctx, id, correct)]);
        await writer.update(ctx, id, results[0].status === 'rejected' ? toggle : correct);

        expect(await writer.get(ctx, id)).toMatchObject({ isActive: true, reasonCode: 'CORRECTED' });
        const events = await eventsOf(id);
        expect(events.at(-1)).toMatchObject({ isActive: true, reasonCode: 'CORRECTED', changedAt: (await repo.findById(orgId, id))?.updatedAt.toISOString() });
        const times = events.map((e) => Date.parse(e.changedAt));
        times.forEach((t, k) => k > 0 && expect(t).toBeGreaterThan(times[k - 1]));
      });

      it('never loses an update when the PATCHes are fired unsynchronised: a failure is always a 409 and the final row/event reflect every successful PATCH', async () => {
        for (let i = 0; i < 15; i++) {
          const { ctx, id, writer } = await setup(30 + i);
          const results = await Promise.allSettled([writer.update(ctx, id, toggle), writer.update(ctx, id, correct)]);

          results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').forEach((r) => expect(r.reason).toBeInstanceOf(ConflictException));
          const row = await repo.findById(orgId, id);
          if (results[0].status === 'fulfilled') expect(row?.isActive, `iteration ${i}`).toBe(true);
          if (results[1].status === 'fulfilled') expect(row?.reasonCode, `iteration ${i}`).toBe('CORRECTED');
          const events = await eventsOf(id);
          expect(events.at(-1)).toMatchObject({ isActive: row?.isActive, reasonCode: row?.reasonCode, changedAt: row?.updatedAt.toISOString() });
        }
      });
    });
  });
});
