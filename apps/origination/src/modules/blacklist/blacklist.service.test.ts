import { ConflictException, Logger, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BlacklistEntry, BlacklistImportResult, DomainEvent } from '@los/contracts';
import { hashRegisterNo } from '@los/database';
import { adminCtx, entryInput, FixedClock, fakeCipher, gateReads, REGISTER, SequentialIds } from './test-support';
import { BlacklistCreateBody, BlacklistListQuery, BlacklistPatchBody, MAX_IMPORT_ROWS } from './blacklist.schemas';
import { BlacklistService, type ImportItem } from './blacklist.service';
import { DuplicateBlacklistEntryError, type BlacklistRepository } from './blacklist.repository';
import { InMemoryBlacklistRepository } from './in-memory-blacklist.repository';

const HOUR = 3_600_000;
const input = (over: Record<string, unknown> = {}) => BlacklistCreateBody.parse(entryInput(over));
const patch = (body: Record<string, unknown>) => BlacklistPatchBody.parse(body);
const query = (over: Record<string, unknown> = {}) => BlacklistListQuery.parse(over);

describe('BlacklistService', () => {
  let repo: InMemoryBlacklistRepository;
  let clock: FixedClock;
  let service: BlacklistService;
  const make = (r: BlacklistRepository = repo) => new BlacklistService(r, fakeCipher, clock, new SequentialIds());

  beforeEach(() => {
    repo = new InMemoryBlacklistRepository();
    clock = new FixedClock();
    service = make();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('create', () => {
    it('stores the register encrypted and hashed, returns the contract shape and emits one event atomically', async () => {
      const entry = await service.create(adminCtx(), input());

      expect(BlacklistEntry.parse(entry)).toMatchObject({
        orgId: 'org-1', registerNo: REGISTER, customerType: 'INDIVIDUAL', name: 'Бат Болд', listType: 'DELINQUENT',
        reasonCode: 'LATE_PAYMENT', reasonText: 'Delinquent over 90 days', isActive: true, registeredBy: 'user-1', registeredAt: '2026-10-28T09:00:00.000Z',
      });
      expect(Object.keys(entry)).not.toContain('registerNoHash');
      const row = await repo.findById('org-1', entry.id);
      expect(row).toMatchObject({
        registerNoHash: hashRegisterNo(REGISTER), branchId: 'branch-1', createdBy: 'user-1', updatedBy: 'user-1',
        registerNoEncrypted: fakeCipher.encrypt(REGISTER),
      });
      expect(repo.events).toHaveLength(1);
    });

    it('emits a BlacklistEntryChanged event that satisfies the contract and carries no plain register number', async () => {
      const entry = await service.create(adminCtx({ correlationId: 'corr-42' }), input());

      const [event] = repo.events;
      expect(DomainEvent.parse(event)).toEqual(event);
      expect(event).toMatchObject({
        type: 'BlacklistEntryChanged', version: 1, orgId: 'org-1', actorId: 'user-1', correlationId: 'corr-42', entryId: entry.id,
        registerNoHash: hashRegisterNo(REGISTER), customerType: 'INDIVIDUAL', name: 'Бат Болд', listType: 'DELINQUENT',
        reasonCode: 'LATE_PAYMENT', isActive: true, occurredAt: '2026-10-28T09:00:00.000Z', changedAt: '2026-10-28T09:00:00.000Z',
      });
      expect(JSON.stringify(event)).not.toContain(REGISTER);
    });

    it('normalizes the register number so differently formatted input is the same entry', async () => {
      const entry = await service.create(adminCtx(), input({ registerNo: ' уб 1234-5678 ' }));
      expect(entry.registerNo).toBe(REGISTER);
      await expect(service.create(adminCtx(), input())).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects an active duplicate (same org, register, listType) with 409 and writes nothing', async () => {
      await service.create(adminCtx(), input());
      await expect(service.create(adminCtx(), input({ name: 'Other' }))).rejects.toBeInstanceOf(ConflictException);
      expect(repo.events).toHaveLength(1);
    });

    it('allows the same register under another listType or another org', async () => {
      await service.create(adminCtx(), input());
      await service.create(adminCtx(), input({ listType: 'FRAUD' }));
      await service.create(adminCtx({ orgId: 'org-2' }), input());
      expect(repo.events).toHaveLength(3);
    });

    it('re-activates an inactive entry with the new data instead of failing, keeping its id and creator', async () => {
      const first = await service.create(adminCtx({ userId: 'creator' }), input());
      await service.deactivate(adminCtx(), first.id);
      clock.advance(HOUR);

      const again = await service.create(adminCtx({ userId: 'user-2', branchId: 'branch-2' }), input({ name: 'Бат Болдын', reasonCode: 'FRAUD_SUSPECT', reasonText: undefined }));

      expect(again).toMatchObject({ id: first.id, isActive: true, name: 'Бат Болдын', reasonCode: 'FRAUD_SUSPECT', reasonText: null, registeredBy: 'user-2', registeredAt: '2026-10-28T10:00:00.000Z' });
      expect(await repo.findById('org-1', first.id)).toMatchObject({ createdBy: 'creator', updatedBy: 'user-2', branchId: 'branch-2' });
      expect(repo.events.at(-1)).toMatchObject({ entryId: first.id, isActive: true, name: 'Бат Болдын', reasonCode: 'FRAUD_SUSPECT' });
      expect(repo.events).toHaveLength(3);
    });

    it('turns a repository uniqueness race into a 409', async () => {
      const racing: BlacklistRepository = {
        list: (...a) => repo.list(...a), findById: (...a) => repo.findById(...a),
        findByKey: async () => null,
        saveWithEvent: async () => { throw new DuplicateBlacklistEntryError(); },
      };
      await expect(make(racing).create(adminCtx(), input())).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('get', () => {
    it('returns the entry, 404 for an unknown id and for another org', async () => {
      const { id } = await service.create(adminCtx(), input());
      expect((await service.get(adminCtx(), id)).registerNo).toBe(REGISTER);
      await expect(service.get(adminCtx(), 'missing')).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.get(adminCtx({ orgId: 'org-2' }), id)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('update', () => {
    it('applies a partial update without touching omitted fields (incl. the listType default) and emits an event', async () => {
      const { id } = await service.create(adminCtx(), input({ listType: 'FRAUD' }));
      clock.advance(HOUR);

      const updated = await service.update(adminCtx({ userId: 'user-2' }), id, patch({ name: 'Шинэ нэр', reasonText: 'New text' }));

      expect(updated).toMatchObject({ name: 'Шинэ нэр', reasonText: 'New text', listType: 'FRAUD', reasonCode: 'LATE_PAYMENT', registeredBy: 'user-1', registeredAt: '2026-10-28T09:00:00.000Z' });
      expect(await repo.findById('org-1', id)).toMatchObject({ updatedBy: 'user-2', updatedAt: new Date('2026-10-28T10:00:00.000Z') });
      expect(repo.events).toHaveLength(2);
      expect(repo.events[1]).toMatchObject({ entryId: id, name: 'Шинэ нэр', actorId: 'user-2' });
    });

    it('clears reasonText with an empty string or null', async () => {
      const { id } = await service.create(adminCtx(), input());
      expect((await service.update(adminCtx(), id, patch({ reasonText: '' }))).reasonText).toBeNull();
      await service.update(adminCtx(), id, patch({ reasonText: 'again' }));
      expect((await service.update(adminCtx(), id, patch({ reasonText: null }))).reasonText).toBeNull();
      expect((await repo.findById('org-1', id))?.reasonText).toBeNull();
    });

    it('treats reasonText null on an entry without text as a no-op', async () => {
      const { id } = await service.create(adminCtx(), input({ reasonText: undefined }));
      await service.update(adminCtx(), id, patch({ reasonText: null }));
      expect(repo.events).toHaveLength(1);
    });

    it('is a no-op (no write, no event) when nothing changes, including a reformatted same register', async () => {
      const { id } = await service.create(adminCtx(), input());
      await service.update(adminCtx(), id, patch({}));
      await service.update(adminCtx(), id, patch({ name: 'Бат Болд', registerNo: 'уб 12345678' }));
      expect(repo.events).toHaveLength(1);
    });

    it('re-hashes and re-encrypts when the register number changes', async () => {
      const { id } = await service.create(adminCtx(), input());
      const updated = await service.update(adminCtx(), id, patch({ registerNo: 'АА87654321' }));

      expect(updated.registerNo).toBe('АА87654321');
      expect(await repo.findById('org-1', id)).toMatchObject({ registerNoHash: hashRegisterNo('АА87654321') });
      expect(repo.events[1]).toMatchObject({ registerNoHash: hashRegisterNo('АА87654321') });
      expect(JSON.stringify(repo.events)).not.toContain('АА87654321');
    });

    it('answers 409 when the new register or listType collides with another entry, active or not', async () => {
      const a = await service.create(adminCtx(), input());
      const b = await service.create(adminCtx(), input({ registerNo: 'АА87654321' }));
      const c = await service.create(adminCtx(), input({ listType: 'FRAUD' }));
      await service.deactivate(adminCtx(), c.id);

      await expect(service.update(adminCtx(), b.id, patch({ registerNo: REGISTER }))).rejects.toBeInstanceOf(ConflictException);
      await expect(service.update(adminCtx(), a.id, patch({ listType: 'FRAUD' }))).rejects.toBeInstanceOf(ConflictException);
      expect(repo.events).toHaveLength(4);
    });

    it('re-registers on inactive -> active and deactivates on active -> inactive', async () => {
      const { id } = await service.create(adminCtx({ userId: 'creator' }), input());
      expect((await service.update(adminCtx(), id, patch({ isActive: false }))).isActive).toBe(false);
      clock.advance(HOUR);
      const back = await service.update(adminCtx({ userId: 'user-2' }), id, patch({ isActive: true }));

      expect(back).toMatchObject({ isActive: true, registeredBy: 'user-2', registeredAt: '2026-10-28T10:00:00.000Z' });
      expect(repo.events.map((e) => e.isActive)).toEqual([true, false, true]);
    });

    it('404s for an unknown entry or another org', async () => {
      const { id } = await service.create(adminCtx(), input());
      await expect(service.update(adminCtx(), 'missing', patch({ name: 'x' }))).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.update(adminCtx({ orgId: 'org-2' }), id, patch({ name: 'x' }))).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('deactivate', () => {
    it('sets isActive=false (never deletes) and emits an event', async () => {
      const { id } = await service.create(adminCtx(), input());
      const entry = await service.deactivate(adminCtx({ userId: 'user-2' }), id);

      expect(entry.isActive).toBe(false);
      expect(await repo.findById('org-1', id)).toMatchObject({ isActive: false, updatedBy: 'user-2' });
      expect(repo.events.at(-1)).toMatchObject({ entryId: id, isActive: false });
    });

    it('is idempotent: a second call returns the entry and emits nothing', async () => {
      const { id } = await service.create(adminCtx(), input());
      await service.deactivate(adminCtx(), id);
      const again = await service.deactivate(adminCtx(), id);
      expect(again.isActive).toBe(false);
      expect(repo.events).toHaveLength(2);
    });

    it('404s for an unknown id', async () => {
      await expect(service.deactivate(adminCtx(), 'missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // [39] kyc нь changedAt-аар дараалал шалгадаг тул event бүрийн бүх талбарыг (changedAt, listType, customerType орно) тулгана.
  describe('BlacklistEntryChanged payload and ordering', () => {
    const T0 = Date.parse('2026-10-28T09:00:00.000Z');
    const iso = (ms: number) => new Date(T0 + ms).toISOString();
    const hash = hashRegisterNo(REGISTER);
    const expectedEvent = (entryId: string, over: Record<string, unknown>, ms: number, occurredMs = ms) => ({
      type: 'BlacklistEntryChanged', eventId: expect.any(String), version: 1, orgId: 'org-1', actorId: 'user-1', correlationId: 'corr-1',
      entryId, registerNoHash: hash, customerType: 'INDIVIDUAL', name: 'Бат Болд', listType: 'DELINQUENT', reasonCode: 'LATE_PAYMENT', isActive: true,
      occurredAt: iso(occurredMs), changedAt: iso(ms), ...over,
    });
    const strictlyIncreasing = () => {
      const times = repo.events.map((e) => Date.parse(e.changedAt));
      times.forEach((t, i) => i > 0 && expect(t).toBeGreaterThan(times[i - 1]));
    };

    it('stamps every create / update / deactivate / reactivate event with a fresh changedAt and the full current payload', async () => {
      const { id } = await service.create(adminCtx(), input());
      const steps: [string, () => Promise<unknown>, Record<string, unknown>][] = [
        ['name only', () => service.update(adminCtx(), id, patch({ name: 'Шинэ нэр' })), { name: 'Шинэ нэр' }],
        ['customerType only', () => service.update(adminCtx(), id, patch({ customerType: 'LEGAL_ENTITY' })), { name: 'Шинэ нэр', customerType: 'LEGAL_ENTITY' }],
        ['reasonCode only', () => service.update(adminCtx(), id, patch({ reasonCode: 'FRAUD_SUSPECT' })), { name: 'Шинэ нэр', customerType: 'LEGAL_ENTITY', reasonCode: 'FRAUD_SUSPECT' }],
        ['listType only', () => service.update(adminCtx(), id, patch({ listType: 'FRAUD' })), { name: 'Шинэ нэр', customerType: 'LEGAL_ENTITY', reasonCode: 'FRAUD_SUSPECT', listType: 'FRAUD' }],
        ['deactivate', () => service.deactivate(adminCtx(), id), { name: 'Шинэ нэр', customerType: 'LEGAL_ENTITY', reasonCode: 'FRAUD_SUSPECT', listType: 'FRAUD', isActive: false }],
        ['reactivate', () => service.update(adminCtx(), id, patch({ isActive: true })), { name: 'Шинэ нэр', customerType: 'LEGAL_ENTITY', reasonCode: 'FRAUD_SUSPECT', listType: 'FRAUD', isActive: true }],
      ];
      expect(repo.events).toHaveLength(1);
      expect(repo.events[0]).toEqual(expectedEvent(id, {}, 0));

      let ms = 0;
      for (const [label, run, over] of steps) {
        clock.advance(HOUR);
        ms += HOUR;
        await run();
        expect(repo.events.at(-1), label).toEqual(expectedEvent(id, over, ms));
      }
      expect(repo.events).toHaveLength(steps.length + 1);
      strictlyIncreasing();
      repo.events.forEach((e) => expect(DomainEvent.parse(e)).toEqual(e));
    });

    it('emits the changed customerType / reasonCode from an import that changes only that field', async () => {
      const { id } = await service.create(adminCtx(), input());
      clock.advance(HOUR);
      const onlyType = await service.importRows(adminCtx(), [{ row: 1, data: entryInput({ customerType: 'LEGAL_ENTITY' }) }]);
      expect(onlyType).toEqual({ created: 0, updated: 1, skipped: 0, errors: [] });
      expect(repo.events.at(-1)).toEqual(expectedEvent(id, { customerType: 'LEGAL_ENTITY' }, HOUR));

      clock.advance(HOUR);
      const onlyReason = await service.importRows(adminCtx(), [{ row: 1, data: entryInput({ customerType: 'LEGAL_ENTITY', reasonCode: 'FRAUD_SUSPECT' }) }]);
      expect(onlyReason).toEqual({ created: 0, updated: 1, skipped: 0, errors: [] });
      expect(repo.events.at(-1)).toEqual(expectedEvent(id, { customerType: 'LEGAL_ENTITY', reasonCode: 'FRAUD_SUSPECT' }, 2 * HOUR));

      clock.advance(HOUR);
      const same = await service.importRows(adminCtx(), [{ row: 1, data: entryInput({ customerType: 'LEGAL_ENTITY', reasonCode: 'FRAUD_SUSPECT' }) }]);
      expect(same).toEqual({ created: 0, updated: 0, skipped: 1, errors: [] });
      expect(repo.events).toHaveLength(3);
      strictlyIncreasing();
    });

    it('emits a re-activating import with the new data and a fresh changedAt', async () => {
      const { id } = await service.create(adminCtx(), input());
      clock.advance(HOUR);
      await service.deactivate(adminCtx(), id);
      clock.advance(HOUR);
      await service.importRows(adminCtx({ userId: 'user-2' }), [{ row: 1, data: entryInput({ name: 'Дахин' }) }]);
      expect(repo.events.at(-1)).toEqual(expectedEvent(id, { name: 'Дахин', actorId: 'user-2', isActive: true }, 2 * HOUR));
      strictlyIncreasing();
    });

    it('keeps changedAt strictly increasing for changes inside one millisecond (occurredAt stays the real time)', async () => {
      const { id } = await service.create(adminCtx(), input());
      await service.update(adminCtx(), id, patch({ name: 'A' }));
      await service.update(adminCtx(), id, patch({ name: 'B' }));
      await service.deactivate(adminCtx(), id);

      expect(repo.events.map((e) => e.changedAt)).toEqual([iso(0), iso(1), iso(2), iso(3)]);
      expect(repo.events.map((e) => e.occurredAt)).toEqual([iso(0), iso(0), iso(0), iso(0)]);
      expect(repo.events.at(-1)).toEqual(expectedEvent(id, { name: 'B', isActive: false }, 3, 0));
      expect((await repo.findById('org-1', id))?.updatedAt.toISOString()).toBe(iso(3));
    });

    it('never moves changedAt backwards when the clock steps back (max(now, previous updatedAt + 1ms))', async () => {
      const { id } = await service.create(adminCtx(), input());
      clock.advance(HOUR);
      await service.update(adminCtx(), id, patch({ name: 'A' }));
      clock.advance(-2 * HOUR);
      await service.update(adminCtx(), id, patch({ name: 'B' }));

      expect(repo.events.map((e) => e.changedAt)).toEqual([iso(0), iso(HOUR), iso(HOUR + 1)]);
      expect(repo.events.at(-1)).toEqual(expectedEvent(id, { name: 'B' }, HOUR + 1, -HOUR));
      strictlyIncreasing();
    });

    it('uses the same timestamp for the row updatedAt (the compare-and-set value) and the event changedAt', async () => {
      const { id } = await service.create(adminCtx(), input());
      await service.update(adminCtx(), id, patch({ name: 'A' }));
      expect((await repo.findById('org-1', id))?.updatedAt.toISOString()).toBe(repo.events.at(-1)?.changedAt);
    });
  });

  // [24]/[28] Зэрэг засвар: бичилт нь уншсан мөр дээрх compare-and-set — нэг нь хожиж нөгөө нь 409, чимээгүй алдагдал байхгүй.
  describe('concurrent modification', () => {
    const race = (svc: BlacklistService, id: string) => Promise.allSettled([
      svc.update(adminCtx({ userId: 'user-a' }), id, patch({ isActive: true })),
      svc.update(adminCtx({ userId: 'user-b' }), id, patch({ reasonCode: 'CORRECTED' })),
    ]);

    it('lets exactly one of two overlapping PATCHes win and answers 409 to the other; the event stream matches the row', async () => {
      const { id } = await service.create(adminCtx(), input());
      await service.deactivate(adminCtx(), id);
      clock.advance(HOUR);

      const results = await race(make(gateReads(repo, 2)), id);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(ConflictException);
      expect((rejected[0].reason as ConflictException).message).toContain('modified concurrently');

      // 3 event: create, deactivate, ялагчийн ганц event. Ялагдагчийн event/мөр бичигдээгүй.
      expect(repo.events).toHaveLength(3);
      const row = await repo.findById('org-1', id);
      const last = repo.events.at(-1);
      expect(last).toMatchObject({ isActive: row?.isActive, reasonCode: row?.reasonCode, changedAt: row?.updatedAt.toISOString() });
      expect(row?.isActive !== true || row?.reasonCode !== 'CORRECTED').toBe(true); // нөгөөгийн өөрчлөлт хоёулаа орж чадаагүй
    });

    it('applies both changes after the loser retries, with strictly increasing changedAt', async () => {
      const { id } = await service.create(adminCtx(), input());
      await service.deactivate(adminCtx(), id);
      clock.advance(HOUR);

      const results = await race(make(gateReads(repo, 2)), id);
      const loserIndex = results.findIndex((r) => r.status === 'rejected');
      await (loserIndex === 0
        ? service.update(adminCtx(), id, patch({ isActive: true }))
        : service.update(adminCtx(), id, patch({ reasonCode: 'CORRECTED' })));

      expect(await service.get(adminCtx(), id)).toMatchObject({ isActive: true, reasonCode: 'CORRECTED' });
      const times = repo.events.map((e) => Date.parse(e.changedAt));
      times.forEach((t, i) => i > 0 && expect(t).toBeGreaterThan(times[i - 1]));
      const row = await repo.findById('org-1', id);
      expect(repo.events.at(-1)).toMatchObject({ isActive: true, reasonCode: 'CORRECTED', changedAt: row?.updatedAt.toISOString() });
    });

    it('lets exactly one of a racing deactivate and rename win, and the last event equals the stored row', async () => {
      const { id } = await service.create(adminCtx(), input());
      const gated = make(gateReads(repo, 2));
      const results = await Promise.allSettled([gated.deactivate(adminCtx(), id), gated.update(adminCtx(), id, patch({ name: 'Renamed' }))]);

      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(repo.events).toHaveLength(2);
      const row = await repo.findById('org-1', id);
      expect(repo.events.at(-1)).toMatchObject({ name: row?.name, isActive: row?.isActive });
    });
  });

  describe('list', () => {
    beforeEach(async () => {
      await service.create(adminCtx(), input({ registerNo: 'УБ11111111', name: 'Бат Болд' }));
      clock.advance(HOUR);
      await service.create(adminCtx(), input({ registerNo: 'УБ22222222', name: 'Сарангэрэл', listType: 'FRAUD' }));
      clock.advance(HOUR);
      const c = await service.create(adminCtx(), input({ registerNo: 'УБ33333333', name: 'Болдбаатар' }));
      await service.deactivate(adminCtx(), c.id);
      await service.create(adminCtx({ orgId: 'org-2' }), input({ registerNo: 'УБ44444444', name: 'Бат Other org' }));
    });

    it('returns the org entries newest registration first with a total and contract-shaped items', async () => {
      const page = await service.list(adminCtx(), query());
      expect(page.total).toBe(3);
      expect(page.items.map((i) => i.registerNo)).toEqual(['УБ33333333', 'УБ22222222', 'УБ11111111']);
      page.items.forEach((i) => expect(BlacklistEntry.parse(i)).toBeTruthy());
    });

    it('never exposes the hash or the ciphertext', async () => {
      const json = JSON.stringify(await service.list(adminCtx(), query()));
      expect(json).not.toContain('registerNoHash');
      expect(json).not.toContain('registerNoEncrypted');
      expect(json).not.toContain('fake:');
    });

    it('matches q as a case-insensitive name substring', async () => {
      expect((await service.list(adminCtx(), query({ q: 'бол' }))).items.map((i) => i.name)).toEqual(['Болдбаатар', 'Бат Болд']);
    });

    it('matches q as a register number through the hash, whatever the formatting', async () => {
      const page = await service.list(adminCtx(), query({ q: ' уб-2222 2222 ' }));
      expect(page.items.map((i) => i.registerNo)).toEqual(['УБ22222222']);
    });

    it('does not match a partial register number (hash is exact)', async () => {
      expect((await service.list(adminCtx(), query({ q: 'УБ2222' }))).total).toBe(0);
    });

    it('filters by listType and isActive', async () => {
      expect((await service.list(adminCtx(), query({ listType: 'fraud' }))).items.map((i) => i.listType)).toEqual(['FRAUD']);
      expect((await service.list(adminCtx(), query({ isActive: 'false' }))).items.map((i) => i.registerNo)).toEqual(['УБ33333333']);
      expect((await service.list(adminCtx(), query({ isActive: 'true' }))).total).toBe(2);
    });

    it('paginates with limit/offset and keeps the total', async () => {
      const page = await service.list(adminCtx(), query({ limit: '1', offset: '1' }));
      expect(page.total).toBe(3);
      expect(page.items.map((i) => i.registerNo)).toEqual(['УБ22222222']);
    });

    it('is isolated per org', async () => {
      expect((await service.list(adminCtx({ orgId: 'org-2' }), query())).items.map((i) => i.registerNo)).toEqual(['УБ44444444']);
    });
  });

  describe('importRows', () => {
    const rows = (...data: Record<string, unknown>[]): ImportItem[] => data.map((d, i) => ({ row: i + 1, data: d }));

    it('creates, updates (incl. re-activating) and skips identical active rows, one event per change', async () => {
      const existing = await service.create(adminCtx(), input({ registerNo: 'УБ11111111' }));
      const inactive = await service.create(adminCtx(), input({ registerNo: 'УБ22222222' }));
      await service.deactivate(adminCtx(), inactive.id);
      const before = repo.events.length;

      const result = await service.importRows(adminCtx(), rows(
        entryInput({ registerNo: 'УБ11111111' }), // ижил, идэвхтэй
        entryInput({ registerNo: 'УБ22222222' }), // идэвхгүй -> дахин идэвхжинэ
        entryInput({ registerNo: 'УБ33333333' }), // шинэ
        entryInput({ registerNo: 'УБ11111111', name: 'Өөрчлөгдсөн' }), // нэр өөрчлөгдсөн
      ));

      expect(BlacklistImportResult.parse(result)).toEqual({ created: 1, updated: 2, skipped: 1, errors: [] });
      expect(repo.events.length - before).toBe(3);
      expect(await service.get(adminCtx(), inactive.id)).toMatchObject({ isActive: true });
      expect(await service.get(adminCtx(), existing.id)).toMatchObject({ name: 'Өөрчлөгдсөн' });
    });

    it('collects per-row validation errors with 1-based row numbers and keeps going', async () => {
      const items: ImportItem[] = [
        { row: 1, data: entryInput({ registerNo: 'УБ11111111' }) },
        { row: 2, data: entryInput({ customerType: 'ROBOT' }) },
        { row: 3, error: 'Row has more columns than the header' },
        { row: 4, data: entryInput({ registerNo: '---' }) },
        { row: 5, data: entryInput({ reasonCode: 'bad code' }) },
        { row: 6, data: 'not an object' },
        { row: 7, data: entryInput({ registerNo: 'УБ77777777' }) },
      ];

      const result = await service.importRows(adminCtx(), items);

      expect(result).toMatchObject({ created: 2, updated: 0, skipped: 0 });
      expect(result.errors.map((e) => e.row)).toEqual([2, 3, 4, 5, 6]);
      expect(result.errors[0].message).toContain('customerType');
      expect(result.errors[2].message).toContain('registerNo');
      expect(result.errors[1].message).toBe('Row has more columns than the header');
    });

    it('never puts a register number into an error message', async () => {
      const result = await service.importRows(adminCtx(), rows(entryInput({ registerNo: 'УБ99999999', customerType: 'ROBOT', name: '' })));
      expect(result.errors).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain('УБ99999999');
    });

    it('treats a repeated key inside one file as update then skip', async () => {
      const result = await service.importRows(adminCtx(), rows(entryInput(), entryInput(), entryInput({ name: 'Дахин' })));
      expect(result).toEqual({ created: 1, updated: 1, skipped: 1, errors: [] });
    });

    it('defaults a missing listType and normalizes an empty reasonText to null', async () => {
      const { registerNo, customerType, name, reasonCode } = entryInput();
      await service.importRows(adminCtx(), rows({ registerNo, customerType, name, reasonCode, reasonText: '' }));
      expect((await service.list(adminCtx(), query())).items[0]).toMatchObject({ listType: 'DELINQUENT', reasonText: null });
    });

    it('reports a row hit by a uniqueness race as a row error and continues', async () => {
      let calls = 0;
      const racing: BlacklistRepository = {
        list: (...a) => repo.list(...a), findById: (...a) => repo.findById(...a), findByKey: (...a) => repo.findByKey(...a),
        saveWithEvent: (row, event, expected) => {
          if (++calls === 1) throw new DuplicateBlacklistEntryError();
          return repo.saveWithEvent(row, event, expected);
        },
      };
      const result = await make(racing).importRows(adminCtx(), rows(entryInput({ registerNo: 'УБ11111111' }), entryInput({ registerNo: 'УБ22222222' })));
      expect(result).toMatchObject({ created: 1 });
      expect(result.errors).toEqual([{ row: 1, message: expect.stringContaining('already exists') }]);
    });

    // [32] Өмнөх хүлээлт (алдааг дээш шиднэ) нь алдаа байсан: өмнө commit хийсэн мөрүүд тайлангүй үлдэж, файл дундаа таслагддаг байв.
    it('reports an unexpected repository failure as a row error (no leak of the error text) and keeps importing', async () => {
      const failOn = 'УБ22222222';
      const flaky: BlacklistRepository = {
        list: (...a) => repo.list(...a), findById: (...a) => repo.findById(...a),
        findByKey: (orgId, hash, listType) => {
          if (hash === hashRegisterNo(failOn)) throw new Error('db down: invalid byte sequence for encoding "UTF8": 0x00 value=УБ22222222');
          return repo.findByKey(orgId, hash, listType);
        },
        saveWithEvent: (...a) => repo.saveWithEvent(...a),
      };

      const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const result = await make(flaky).importRows(adminCtx(), rows(
        entryInput({ registerNo: 'УБ11111111' }), entryInput({ registerNo: failOn }), entryInput({ registerNo: 'УБ33333333' }),
      ));

      expect(BlacklistImportResult.parse(result)).toEqual({ created: 2, updated: 0, skipped: 0, errors: [{ row: 2, message: expect.stringContaining('could not be saved') }] });
      expect(JSON.stringify(result)).not.toMatch(/db down|0x00|УБ22222222/);
      expect(repo.events).toHaveLength(2);
      // Лог: мөрийн дугаар + correlationId, алдааны текст/утга байхгүй.
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0][0])).toContain('row 2');
      expect(String(log.mock.calls[0][0])).toContain('corr-1');
      expect(String(log.mock.calls[0][0])).not.toMatch(/db down|0x00|УБ22222222/);
    });

    it('reports a row that lost an optimistic-lock race as a 409-style row error and continues', async () => {
      const first = await service.create(adminCtx(), input({ registerNo: 'УБ11111111' }));
      clock.advance(HOUR);
      // Мөр уншигдсаны дараа өөр хүсэлт засчихсан мэт: findByKey-ийн дараа updatedAt-ыг шилжүүлнэ.
      const racing: BlacklistRepository = {
        list: (...a) => repo.list(...a), findById: (...a) => repo.findById(...a),
        findByKey: async (...a) => {
          const found = await repo.findByKey(...a);
          if (found?.id === first.id) await make().update(adminCtx({ userId: 'other' }), first.id, patch({ reasonText: 'concurrent edit' }));
          return found;
        },
        saveWithEvent: (...a) => repo.saveWithEvent(...a),
      };

      const result = await make(racing).importRows(adminCtx(), rows(entryInput({ registerNo: 'УБ11111111', name: 'Import name' }), entryInput({ registerNo: 'УБ22222222' })));

      expect(result).toMatchObject({ created: 1, updated: 0, skipped: 0 });
      expect(result.errors).toEqual([{ row: 1, message: expect.stringContaining('modified concurrently') }]);
      expect(await service.get(adminCtx(), first.id)).toMatchObject({ name: 'Бат Болд', reasonText: 'concurrent edit' });
    });

    it('rejects more than the maximum number of rows with 413', async () => {
      const items = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i): ImportItem => ({ row: i + 1, data: entryInput({ registerNo: `УБ${String(i).padStart(8, '0')}` }) }));
      await expect(service.importRows(adminCtx(), items)).rejects.toBeInstanceOf(PayloadTooLargeException);
      expect(repo.events).toHaveLength(0);
    });

    it('accepts exactly the maximum number of rows', async () => {
      const items = Array.from({ length: MAX_IMPORT_ROWS }, (_, i): ImportItem => ({ row: i + 1, data: entryInput({ registerNo: `УБ${String(i).padStart(8, '0')}` }) }));
      expect(await service.importRows(adminCtx(), items)).toMatchObject({ created: MAX_IMPORT_ROWS, errors: [] });
    });
  });
});
