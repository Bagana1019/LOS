import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DomainEvent } from '@los/contracts';
import { DomainError, LeaseKeyConflict } from '../domain/errors';
import type { LeaseDashboardRow, LeaseRecord } from '../domain/records';
import type { LeaseRepository, MerchantRepository, OtpRepository, PlanRepository, LeaseScope } from './repositories';
import {
  ORG, OTHER_ORG, at, leaseCancelled, leaseDecided, makeFullLease, makeLease, makeMerchant, makeOtp, makePlan, makeQuote, makeStore, makeTimeline, merchantStatusChanged,
  type LeaseRefs,
} from './contract-fixtures';

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Repository contract suite: санах ойн болон Prisma/Postgres хэрэгжүүлэлт ЯГ ИЖИЛ семантиктай байх ёстой (persistence/repositories.ts-ийн баримтжуулалт).
//
//   describeRepositoryContract('memory', () => ({ merchants, plans, leases, otps, readOutbox, reset }))
//
// Тест бүрийн өмнө `factory()` дуудагдаж (шинэ harness), дараа нь `reset()` (жишээ нь Postgres хүснэгтийг TRUNCATE). `close?.()` тест бүрийн дараа.
// `readOutbox()` нь бизнес бичлэгтэй хамт "commit" болсон event-үүдийг буцаана; харьцуулалт нь эрэмбэгүй (ижил tx доторх event-ийн дараалал баталгаагүй).
// ───────────────────────────────────────────────────────────────────────────────────────────────

export interface RepositoryHarness {
  merchants: MerchantRepository;
  plans: PlanRepository;
  leases: LeaseRepository;
  otps: OtpRepository;
  readOutbox(): Promise<DomainEvent[]>;
  reset(): Promise<void>;
  close?(): Promise<void>;
}
export type HarnessFactory = () => RepositoryHarness | Promise<RepositoryHarness>;

const byEventId = (a: DomainEvent, b: DomainEvent) => a.eventId.localeCompare(b.eventId);
const sortedEvents = (events: DomainEvent[]) => [...events].sort(byEventId);
const byId = <T extends { id: string }>(a: T, b: T) => a.id.localeCompare(b.id);
const codes = (xs: Array<{ code: string }>) => xs.map((x) => x.code);

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(() => undefined, (e: unknown) => e ?? new Error('rejected with empty reason'));
}
async function expectDomainError(p: Promise<unknown>, code: string) {
  const err = await rejection(p);
  expect(err, `expected DomainError(${code})`).toBeInstanceOf(DomainError);
  expect((err as DomainError).code).toBe(code);
}
async function expectKeyConflict(p: Promise<unknown>, kind: 'IDEMPOTENCY' | 'LEASE_NO') {
  const err = await rejection(p);
  expect(err, `expected LeaseKeyConflict(${kind})`).toBeInstanceOf(LeaseKeyConflict);
  expect((err as LeaseKeyConflict).kind).toBe(kind);
}

const dashboardRowOf = (l: LeaseRecord): LeaseDashboardRow => ({
  id: l.id, status: l.status, storeId: l.storeId, planCode: l.planCode, decision: l.decision, createdAt: l.createdAt, decidedAt: l.decidedAt, decidedBy: l.decidedBy, expiresAt: l.expiresAt,
  acceptedAt: l.acceptedAt, deliveredAt: l.deliveredAt, settledAt: l.settledAt, goodsPrice: l.goodsPrice, financedAmount: l.quote.financedAmount,
  merchantCommissionAmount: l.quote.merchantCommissionAmount, merchantNetAmount: l.quote.merchantNetAmount,
});
const round2 = (n: number) => Math.round(n * 100) / 100;
const quoteOf = (financed: number) => makeQuote({ financedAmount: financed, merchantCommissionAmount: round2(financed * 0.03), merchantNetAmount: round2(financed * 0.97) });

export function describeRepositoryContract(name: string, factory: HarnessFactory): void {
  describe(`${name}: repository contract`, () => {
    let h: RepositoryHarness;
    beforeEach(async () => {
      h = await factory();
      await h.reset();
    });
    afterEach(async () => {
      await h.close?.();
    });

    // ───────────── fixtures that need the harness ─────────────
    /** Мерчант + дэлгүүр + (бүх мерчантад нийтлэг) хөтөлбөр. */
    async function seed(over: { orgId?: string; branchId?: string } = {}) {
      const orgId = over.orgId ?? ORG;
      const merchant = await h.merchants.createMerchant(makeMerchant({ orgId, ...(over.branchId ? { branchId: over.branchId } : {}) }), []);
      const store = await h.merchants.createStore(makeStore(merchant.id, { orgId }));
      const plan = await h.plans.createPlan(makePlan({ orgId }));
      const refs: LeaseRefs = { orgId, merchantId: merchant.id, storeId: store.id, planId: plan.id, branchId: merchant.branchId, planCode: plan.code };
      return { merchant, store, plan, refs };
    }
    async function addStore(merchantId: string, orgId = ORG) {
      return h.merchants.createStore(makeStore(merchantId, { orgId }));
    }
    async function insertLease(refs: LeaseRefs, over: Partial<LeaseRecord> = {}, events: DomainEvent[] = []) {
      const l = makeLease(refs, over);
      await h.leases.insertLease(l, makeTimeline(l.id, { at: l.createdAt }), events);
      return l;
    }
    const scope = (over: Partial<LeaseScope> = {}): LeaseScope => ({ orgId: ORG, ...over });

    // ═════════════════════════════════ MerchantRepository ═════════════════════════════════
    describe('MerchantRepository: merchants', () => {
      it('creates a merchant and reads it back with every field intact (all nullables set)', async () => {
        const m = makeMerchant();
        expect(await h.merchants.createMerchant(m, [])).toEqual(m);
        expect(await h.merchants.findMerchant(ORG, m.id)).toEqual(m);
      });

      it('round-trips nulls, decimals, unicode and special characters', async () => {
        const m = makeMerchant({
          name: 'Номин "Электроникс" ХХК 🙂 100%_off \\ back\nslash', legalName: null, companyRegisterNo: null, category: null, email: null, dailyLimitAmount: null, contractNo: null,
          contractSignedAt: null, statusReason: 'Шалтгаан: гэрээ дууссан', updatedBy: 'user-9', commissionRate: 0.0725, maxTicketAmount: 12_345_678.9,
          createdAt: at(0, 999), updatedAt: at(5, 1),
        });
        await h.merchants.createMerchant(m, []);
        expect(await h.merchants.findMerchant(ORG, m.id)).toEqual(m);
      });

      it('writes the events to the outbox together with the merchant', async () => {
        const m = makeMerchant();
        const events = [merchantStatusChanged(m.id), merchantStatusChanged(m.id, { from: 'ACTIVE', to: 'SUSPENDED', reason: 'Шалгалт' })];
        await h.merchants.createMerchant(m, events);
        expect(sortedEvents(await h.readOutbox())).toEqual(sortedEvents(events));
      });

      it('rejects a duplicate (orgId, code) with DUPLICATE_CODE and writes neither the row nor its events', async () => {
        const first = makeMerchant({ code: 'DUP1' });
        await h.merchants.createMerchant(first, [merchantStatusChanged(first.id)]);
        const second = makeMerchant({ code: 'DUP1' });
        const ev = merchantStatusChanged(second.id);
        await expectDomainError(h.merchants.createMerchant(second, [ev]), 'DUPLICATE_CODE');
        expect(await h.merchants.findMerchant(ORG, second.id)).toBeNull();
        expect((await h.readOutbox()).map((e) => e.eventId)).not.toContain(ev.eventId);
        expect((await h.merchants.listMerchants(ORG, {}, { page: 1, pageSize: 10 })).total).toBe(1);
      });

      it('allows the same code in another org', async () => {
        await h.merchants.createMerchant(makeMerchant({ code: 'SAME' }), []);
        const other = await h.merchants.createMerchant(makeMerchant({ code: 'SAME', orgId: OTHER_ORG }), []);
        expect(await h.merchants.findMerchant(OTHER_ORG, other.id)).toEqual(other);
      });

      it('findMerchant is org-scoped and returns null for unknown or malformed ids', async () => {
        const m = await h.merchants.createMerchant(makeMerchant(), []);
        expect(await h.merchants.findMerchant(OTHER_ORG, m.id)).toBeNull();
        expect(await h.merchants.findMerchant(ORG, randomUUID())).toBeNull();
        expect(await h.merchants.findMerchant(ORG, 'not-a-uuid')).toBeNull();
      });

      it('saveMerchant replaces mutable fields, keeps created stamps and writes events', async () => {
        const m = await h.merchants.createMerchant(makeMerchant(), []);
        const updated = {
          ...m, name: 'Шинэ нэр', status: 'SUSPENDED' as const, statusReason: 'Эрсдэл', commissionRate: 0.05, dailyLimitAmount: null, contractNo: null, branchId: 'branch-9',
          updatedAt: at(10, 5), updatedBy: 'user-2',
        };
        const ev = merchantStatusChanged(m.id, { from: 'ACTIVE', to: 'SUSPENDED', reason: 'Эрсдэл' });
        const saved = { ...updated, version: m.version + 1 }; // optimistic lock: амжилттай save бүр version + 1
        expect(await h.merchants.saveMerchant(updated, [ev])).toEqual(saved);
        expect(await h.merchants.findMerchant(ORG, m.id)).toEqual(saved);
        expect(await h.readOutbox()).toEqual([ev]);
      });

      it('saveMerchant of an unknown merchant fails with NOT_FOUND and writes no events', async () => {
        const ghost = makeMerchant();
        const ev = merchantStatusChanged(ghost.id);
        await expectDomainError(h.merchants.saveMerchant(ghost, [ev]), 'NOT_FOUND');
        expect(await h.readOutbox()).toEqual([]);
        expect(await h.merchants.findMerchant(ORG, ghost.id)).toBeNull();
      });

      it('saveMerchant never touches another org\'s merchant (NOT_FOUND, no events)', async () => {
        const m = await h.merchants.createMerchant(makeMerchant(), []);
        const ev = merchantStatusChanged(m.id);
        await expectDomainError(h.merchants.saveMerchant({ ...m, orgId: OTHER_ORG, name: 'hijacked' }, [ev]), 'NOT_FOUND');
        expect(await h.merchants.findMerchant(ORG, m.id)).toEqual(m);
        expect(await h.readOutbox()).toEqual([]);
      });

      it('saveMerchant onto another merchant\'s code fails with DUPLICATE_CODE, leaving the record and outbox untouched', async () => {
        await h.merchants.createMerchant(makeMerchant({ code: 'TAKEN' }), []);
        const m = await h.merchants.createMerchant(makeMerchant({ code: 'MINE' }), []);
        const ev = merchantStatusChanged(m.id);
        await expectDomainError(h.merchants.saveMerchant({ ...m, code: 'TAKEN', name: 'changed' }, [ev]), 'DUPLICATE_CODE');
        expect(await h.merchants.findMerchant(ORG, m.id)).toEqual(m);
        expect(await h.readOutbox()).toEqual([]);
      });

      describe('optimistic lock (version)', () => {
        it('inserts at version 1 whatever the record says, and bumps the version by one per save (the returned record carries it)', async () => {
          const m = await h.merchants.createMerchant({ ...makeMerchant(), version: 9 }, []);
          expect(m.version).toBe(1);
          expect((await h.merchants.findMerchant(ORG, m.id))!.version).toBe(1);
          const v2 = await h.merchants.saveMerchant({ ...m, name: 'v2' }, []);
          const v3 = await h.merchants.saveMerchant({ ...v2, name: 'v3' }, []);
          expect([v2.version, v3.version]).toEqual([2, 3]);
          expect(await h.merchants.findMerchant(ORG, m.id)).toEqual(v3);
        });

        it('a stale save is rejected with CONCURRENT_UPDATE: it cannot revert a status change or the payout account, and writes no events', async () => {
          const m = await h.merchants.createMerchant(makeMerchant({ status: 'ACTIVE', settlementBankCode: 'KHAN', settlementAccountLast4: '1234' }), []);
          // Админ A: PATCH-д зориулж уншсан (ACTIVE, v1). Админ B: зогсоох + дансаа солих (v2).
          const suspendedEv = merchantStatusChanged(m.id, { from: 'ACTIVE', to: 'SUSPENDED', reason: 'Эрсдэл' });
          const winner = await h.merchants.saveMerchant({ ...m, status: 'SUSPENDED', statusReason: 'Эрсдэл', settlementBankCode: 'TDB', settlementAccountLast4: '9999', updatedAt: at(5) }, [suspendedEv]);
          const staleEv = merchantStatusChanged(m.id, { from: 'ACTIVE', to: 'TERMINATED', reason: 'stale' });
          await expectDomainError(h.merchants.saveMerchant({ ...m, name: 'stale patch', status: 'TERMINATED', statusReason: 'stale', updatedAt: at(6) }, [staleEv]), 'CONCURRENT_UPDATE');
          expect(await h.merchants.findMerchant(ORG, m.id)).toEqual(winner); // SUSPENDED, TDB/9999, v2 хэвээр
          expect(await h.readOutbox()).toEqual([suspendedEv]); // зөрчилдсөн хүсэлтийн event outbox-д ороогүй
        });

        it('a terminal status cannot be overwritten by a save that was loaded before it', async () => {
          const m = await h.merchants.createMerchant(makeMerchant({ status: 'ACTIVE' }), []);
          const terminated = await h.merchants.saveMerchant({ ...m, status: 'TERMINATED', statusReason: 'Гэрээ цуцалсан' }, []);
          await expectDomainError(h.merchants.saveMerchant({ ...m, status: 'SUSPENDED', statusReason: 'stale' }, []), 'CONCURRENT_UPDATE');
          expect((await h.merchants.findMerchant(ORG, m.id))!.status).toBe('TERMINATED');
          expect((await h.merchants.findMerchant(ORG, m.id))!.version).toBe(terminated.version);
        });

        it('reports NOT_FOUND (not CONCURRENT_UPDATE) for an unknown merchant or another org, even with a stale version', async () => {
          const m = await h.merchants.createMerchant(makeMerchant(), []);
          await h.merchants.saveMerchant({ ...m, name: 'bump' }, []);
          await expectDomainError(h.merchants.saveMerchant({ ...m, orgId: OTHER_ORG, version: 1 }, []), 'NOT_FOUND');
          await expectDomainError(h.merchants.saveMerchant({ ...makeMerchant(), version: 5 }, []), 'NOT_FOUND');
        });

        it('a failed save (DUPLICATE_CODE) does not bump the version, so the same record can be saved again', async () => {
          await h.merchants.createMerchant(makeMerchant({ code: 'TAKEN' }), []);
          const m = await h.merchants.createMerchant(makeMerchant({ code: 'MINE' }), []);
          await expectDomainError(h.merchants.saveMerchant({ ...m, code: 'TAKEN' }, []), 'DUPLICATE_CODE');
          expect((await h.merchants.findMerchant(ORG, m.id))!.version).toBe(1);
          expect((await h.merchants.saveMerchant({ ...m, name: 'ok' }, [])).version).toBe(2);
        });

        it('parallel saves from the same version: exactly one wins, the rest get CONCURRENT_UPDATE, and only the winner\'s events are written', async () => {
          const m = await h.merchants.createMerchant(makeMerchant(), []);
          const attempts = Array.from({ length: 8 }, (_, i) => ({ rec: { ...m, name: `writer-${i}`, updatedBy: `u${i}` }, ev: merchantStatusChanged(m.id, { from: 'ACTIVE', to: 'SUSPENDED', reason: `writer-${i}` }) }));
          const results = await Promise.allSettled(attempts.map((a) => h.merchants.saveMerchant(a.rec, [a.ev])));
          const won = results.flatMap((r, i) => (r.status === 'fulfilled' ? [i] : []));
          expect(won).toHaveLength(1);
          for (const r of results) if (r.status === 'rejected') {
            expect(r.reason).toBeInstanceOf(DomainError);
            expect((r.reason as DomainError).code).toBe('CONCURRENT_UPDATE');
          }
          const stored = (await h.merchants.findMerchant(ORG, m.id))!;
          expect(stored.name).toBe(attempts[won[0]!]!.rec.name);
          expect(stored.version).toBe(2);
          expect(await h.readOutbox()).toEqual([attempts[won[0]!]!.ev]);
        });
      });

      describe('listMerchants', () => {
        let alpha: ReturnType<typeof makeMerchant>;
        let bravo: ReturnType<typeof makeMerchant>;
        let charlie: ReturnType<typeof makeMerchant>;
        beforeEach(async () => {
          alpha = makeMerchant({ code: 'ALPHA', name: 'Номин Электроникс', legalName: 'Nomin Holding LLC', status: 'ACTIVE', branchId: 'b1', createdAt: at(1) });
          bravo = makeMerchant({ code: 'BRAVO', name: 'Tech Store', legalName: null, status: 'PENDING', branchId: 'b2', createdAt: at(2) });
          charlie = makeMerchant({ code: 'CHARLIE', name: '100%_Off Shop', legalName: 'Retail LLC', status: 'ACTIVE', branchId: 'b1', createdAt: at(3) });
          for (const m of [bravo, alpha, charlie]) await h.merchants.createMerchant(m, []);
          await h.merchants.createMerchant(makeMerchant({ orgId: OTHER_ORG, code: 'ALPHA', name: 'Alpha elsewhere', createdAt: at(4) }), []);
        });
        const list = (filter: { status?: 'ACTIVE' | 'PENDING'; q?: string; branchId?: string }, page = { page: 1, pageSize: 50 }) => h.merchants.listMerchants(ORG, filter, page);

        it('lists the org\'s merchants newest first, never another org\'s', async () => {
          const r = await list({});
          expect(codes(r.items)).toEqual(['CHARLIE', 'BRAVO', 'ALPHA']);
          expect(r.total).toBe(3);
        });

        it('filters by status and by branch', async () => {
          expect(codes((await list({ status: 'ACTIVE' })).items)).toEqual(['CHARLIE', 'ALPHA']);
          expect(codes((await list({ branchId: 'b1' })).items)).toEqual(['CHARLIE', 'ALPHA']);
          expect(codes((await list({ status: 'PENDING', branchId: 'b1' })).items)).toEqual([]);
        });

        it('searches code, name and legal name case-insensitively (ASCII), trimmed', async () => {
          expect(codes((await list({ q: 'alp' })).items)).toEqual(['ALPHA']);
          expect(codes((await list({ q: '  TECH ' })).items)).toEqual(['BRAVO']);
          expect(codes((await list({ q: 'NOMIN' })).items)).toEqual(['ALPHA']); // legalName
          expect(codes((await list({ q: 'retail' })).items)).toEqual(['CHARLIE']); // legalName
          expect(codes((await list({ q: 'shop' })).items)).toEqual(['CHARLIE']); // name
          expect(codes((await list({ q: '   ' })).items)).toEqual(['CHARLIE', 'BRAVO', 'ALPHA']);
          expect((await list({ q: 'zzz' })).total).toBe(0);
        });

        it('searches non-ASCII text by substring', async () => {
          expect(codes((await list({ q: 'Номин' })).items)).toEqual(['ALPHA']);
        });

        it('treats % and _ in the search text literally', async () => {
          expect(codes((await list({ q: '%' })).items)).toEqual(['CHARLIE']);
          expect(codes((await list({ q: '_' })).items)).toEqual(['CHARLIE']);
          expect(codes((await list({ q: '0%_O' })).items)).toEqual(['CHARLIE']);
          expect((await list({ q: '\\' })).total).toBe(0);
        });

        it('combines filters', async () => {
          expect(codes((await list({ status: 'ACTIVE', q: 'a' })).items)).toEqual(['CHARLIE', 'ALPHA']);
          expect(codes((await list({ status: 'ACTIVE', branchId: 'b1', q: 'nomin' })).items)).toEqual(['ALPHA']);
        });

        it('paginates with a stable total', async () => {
          const p1 = await list({}, { page: 1, pageSize: 2 });
          const p2 = await list({}, { page: 2, pageSize: 2 });
          const p3 = await list({}, { page: 3, pageSize: 2 });
          expect(codes(p1.items)).toEqual(['CHARLIE', 'BRAVO']);
          expect(codes(p2.items)).toEqual(['ALPHA']);
          expect(p3.items).toEqual([]);
          expect([p1.total, p2.total, p3.total]).toEqual([3, 3, 3]);
        });
      });
    });

    describe('MerchantRepository: stores', () => {
      it('creates a store and reads it back with nested address JSON and nulls', async () => {
        const m = await h.merchants.createMerchant(makeMerchant(), []);
        const s = makeStore(m.id, { phone: null, address: { detail: 'Сүхбаатар дүүрэг, 1-р хороо' }, isActive: false, updatedBy: 'u2', updatedAt: at(2, 3) });
        expect(await h.merchants.createStore(s)).toEqual(s);
        expect(await h.merchants.findStore(m.id, s.id)).toEqual(s);
        const full = makeStore(m.id);
        await h.merchants.createStore(full);
        expect(await h.merchants.findStore(m.id, full.id)).toEqual(full);
      });

      it('rejects a duplicate code within the merchant but allows it for another merchant', async () => {
        const m1 = await h.merchants.createMerchant(makeMerchant(), []);
        const m2 = await h.merchants.createMerchant(makeMerchant(), []);
        await h.merchants.createStore(makeStore(m1.id, { code: 'MAIN' }));
        await expectDomainError(h.merchants.createStore(makeStore(m1.id, { code: 'MAIN' })), 'DUPLICATE_CODE');
        const other = await h.merchants.createStore(makeStore(m2.id, { code: 'MAIN' }));
        expect(await h.merchants.findStore(m2.id, other.id)).toEqual(other);
        expect(await h.merchants.listStores(m1.id)).toHaveLength(1);
      });

      it('findStore requires the owning merchant and tolerates unknown or malformed ids', async () => {
        const m1 = await h.merchants.createMerchant(makeMerchant(), []);
        const m2 = await h.merchants.createMerchant(makeMerchant(), []);
        const s = await h.merchants.createStore(makeStore(m1.id));
        expect(await h.merchants.findStore(m2.id, s.id)).toBeNull();
        expect(await h.merchants.findStore(m1.id, randomUUID())).toBeNull();
        expect(await h.merchants.findStore(m1.id, 'nope')).toBeNull();
        expect(await h.merchants.findStore('nope', s.id)).toBeNull();
      });

      it('lists only the merchant\'s stores, ordered by code', async () => {
        const m1 = await h.merchants.createMerchant(makeMerchant(), []);
        const m2 = await h.merchants.createMerchant(makeMerchant(), []);
        for (const code of ['C3', 'A1', 'B2']) await h.merchants.createStore(makeStore(m1.id, { code }));
        await h.merchants.createStore(makeStore(m2.id, { code: 'Z9' }));
        expect(codes(await h.merchants.listStores(m1.id))).toEqual(['A1', 'B2', 'C3']);
        expect(await h.merchants.listStores(randomUUID())).toEqual([]);
        expect(await h.merchants.listStores('nope')).toEqual([]);
      });

      it('saveStore updates mutable fields and keeps created stamps', async () => {
        const m = await h.merchants.createMerchant(makeMerchant(), []);
        const s = await h.merchants.createStore(makeStore(m.id));
        const updated = { ...s, name: 'Шинэ нэр', isActive: false, phone: null, address: { city: 'Дархан', detail: 'Төв талбай' }, updatedAt: at(9), updatedBy: 'u3' };
        const saved = { ...updated, version: s.version + 1 };
        expect(await h.merchants.saveStore(updated)).toEqual(saved);
        expect(await h.merchants.findStore(m.id, s.id)).toEqual(saved);
      });

      it('saveStore never touches a store of another merchant', async () => {
        const m1 = await h.merchants.createMerchant(makeMerchant(), []);
        const m2 = await h.merchants.createMerchant(makeMerchant(), []);
        const s = await h.merchants.createStore(makeStore(m1.id));
        await expectDomainError(h.merchants.saveStore({ ...s, merchantId: m2.id, name: 'hijacked' }), 'NOT_FOUND');
        expect(await h.merchants.findStore(m1.id, s.id)).toEqual(s);
      });

      it('saveStore fails with NOT_FOUND for an unknown store and DUPLICATE_CODE for a colliding code', async () => {
        const m = await h.merchants.createMerchant(makeMerchant(), []);
        await h.merchants.createStore(makeStore(m.id, { code: 'TAKEN' }));
        const s = await h.merchants.createStore(makeStore(m.id, { code: 'MINE' }));
        await expectDomainError(h.merchants.saveStore(makeStore(m.id)), 'NOT_FOUND');
        await expectDomainError(h.merchants.saveStore({ ...s, code: 'TAKEN' }), 'DUPLICATE_CODE');
        expect(await h.merchants.findStore(m.id, s.id)).toEqual(s);
      });

      describe('optimistic lock (version)', () => {
        it('inserts at version 1 whatever the record says and bumps it by one per save', async () => {
          const m = await h.merchants.createMerchant(makeMerchant(), []);
          const s = await h.merchants.createStore({ ...makeStore(m.id), version: 7 });
          expect(s.version).toBe(1);
          const v2 = await h.merchants.saveStore({ ...s, name: 'v2' });
          const v3 = await h.merchants.saveStore({ ...v2, name: 'v3' });
          expect([v2.version, v3.version]).toEqual([2, 3]);
          expect(await h.merchants.findStore(m.id, s.id)).toEqual(v3);
        });

        it('a stale save is rejected with CONCURRENT_UPDATE and cannot revert isActive', async () => {
          const m = await h.merchants.createMerchant(makeMerchant(), []);
          const s = await h.merchants.createStore(makeStore(m.id, { isActive: true }));
          const closed = await h.merchants.saveStore({ ...s, isActive: false, updatedAt: at(4) });
          await expectDomainError(h.merchants.saveStore({ ...s, name: 'stale rename' }), 'CONCURRENT_UPDATE');
          expect(await h.merchants.findStore(m.id, s.id)).toEqual(closed);
        });

        it('reports NOT_FOUND for another org\'s store even with a stale version', async () => {
          const m = await h.merchants.createMerchant(makeMerchant(), []);
          const s = await h.merchants.createStore(makeStore(m.id));
          await h.merchants.saveStore({ ...s, name: 'bump' });
          await expectDomainError(h.merchants.saveStore({ ...s, orgId: OTHER_ORG }), 'NOT_FOUND');
        });

        it('parallel saves from the same version: exactly one wins', async () => {
          const m = await h.merchants.createMerchant(makeMerchant(), []);
          const s = await h.merchants.createStore(makeStore(m.id));
          const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => h.merchants.saveStore({ ...s, name: `writer-${i}` })));
          const won = results.flatMap((r, i) => (r.status === 'fulfilled' ? [i] : []));
          expect(won).toHaveLength(1);
          for (const r of results) if (r.status === 'rejected') expect((r.reason as DomainError).code).toBe('CONCURRENT_UPDATE');
          const stored = (await h.merchants.findStore(m.id, s.id))!;
          expect(stored.name).toBe(`writer-${won[0]}`);
          expect(stored.version).toBe(2);
        });
      });
    });

    // ═════════════════════════════════ PlanRepository ═════════════════════════════════
    describe('PlanRepository', () => {
      it('creates a plan and reads it back by id and by code with every field intact', async () => {
        const m = await h.merchants.createMerchant(makeMerchant(), []);
        const p = makePlan({
          merchantId: m.id, productId: 'product-77', code: 'LAPTOP12', name: 'Зөөврийн компьютер "12" сар', goodsCategories: ['COMPUTER', 'GAMES', 'OTHER'], termOptions: [3, 6, 9, 12],
          minAmount: 300_000.5, maxAmount: 10_000_000, annualRate: 0.2399, feeRate: 0.0125, minDownPaymentRate: 0.1, commissionRate: 0.0275,
          policy: { maxDti: 0.5, autoDeclineEnabled: false, offerTtlMinutes: 45 }, validFrom: at(0, 1), validTo: at(60 * 24 * 30, 999), isActive: false, updatedBy: 'u2', updatedAt: at(3),
        });
        expect(await h.plans.createPlan(p)).toEqual(p);
        expect(await h.plans.findPlan(ORG, p.id)).toEqual(p);
        expect(await h.plans.findPlanByCode(ORG, 'LAPTOP12')).toEqual(p);
      });

      it('round-trips a plan with every nullable null', async () => {
        const p = makePlan({ merchantId: null, productId: null, commissionRate: null, policy: {}, validFrom: null, validTo: null, feeRate: 0, minDownPaymentRate: 0 });
        await h.plans.createPlan(p);
        expect(await h.plans.findPlan(ORG, p.id)).toEqual(p);
      });

      it('rejects a duplicate (orgId, code) but allows the code in another org', async () => {
        await h.plans.createPlan(makePlan({ code: 'DUP' }));
        await expectDomainError(h.plans.createPlan(makePlan({ code: 'DUP' })), 'DUPLICATE_CODE');
        const other = await h.plans.createPlan(makePlan({ code: 'DUP', orgId: OTHER_ORG }));
        expect(await h.plans.findPlanByCode(OTHER_ORG, 'DUP')).toEqual(other);
        expect(await h.plans.listPlans(ORG, {})).toHaveLength(1);
      });

      it('find methods are org-scoped and tolerate unknown or malformed ids', async () => {
        const p = await h.plans.createPlan(makePlan({ code: 'ONE' }));
        expect(await h.plans.findPlan(OTHER_ORG, p.id)).toBeNull();
        expect(await h.plans.findPlan(ORG, randomUUID())).toBeNull();
        expect(await h.plans.findPlan(ORG, 'nope')).toBeNull();
        expect(await h.plans.findPlanByCode(OTHER_ORG, 'ONE')).toBeNull();
        expect(await h.plans.findPlanByCode(ORG, 'NOPE')).toBeNull();
      });

      it('savePlan replaces mutable fields (including clearing nullables) and keeps created stamps', async () => {
        const m = await h.merchants.createMerchant(makeMerchant(), []);
        const p = await h.plans.createPlan(makePlan({ merchantId: m.id, commissionRate: 0.02, validFrom: at(1), validTo: at(100), productId: 'prod' }));
        const updated = {
          ...p, name: 'Шинэ', merchantId: null, productId: null, commissionRate: null, validFrom: null, validTo: null, termOptions: [24], goodsCategories: ['FURNITURE' as const],
          policy: { referDti: 0.7 }, annualRate: 0.3, isActive: false, updatedAt: at(8), updatedBy: 'u5',
        };
        const saved = { ...updated, version: p.version + 1 };
        expect(await h.plans.savePlan(updated)).toEqual(saved);
        expect(await h.plans.findPlan(ORG, p.id)).toEqual(saved);
      });

      it('savePlan never touches another org\'s plan', async () => {
        const p = await h.plans.createPlan(makePlan());
        await expectDomainError(h.plans.savePlan({ ...p, orgId: OTHER_ORG, name: 'hijacked' }), 'NOT_FOUND');
        expect(await h.plans.findPlan(ORG, p.id)).toEqual(p);
      });

      it('savePlan fails with NOT_FOUND for an unknown plan and DUPLICATE_CODE for a colliding code', async () => {
        await h.plans.createPlan(makePlan({ code: 'TAKEN' }));
        const p = await h.plans.createPlan(makePlan({ code: 'MINE' }));
        await expectDomainError(h.plans.savePlan(makePlan()), 'NOT_FOUND');
        await expectDomainError(h.plans.savePlan({ ...p, code: 'TAKEN' }), 'DUPLICATE_CODE');
        expect(await h.plans.findPlan(ORG, p.id)).toEqual(p);
      });

      describe('optimistic lock (version)', () => {
        it('inserts at version 1 whatever the record says and bumps it by one per save', async () => {
          const p = await h.plans.createPlan({ ...makePlan(), version: 4 });
          expect(p.version).toBe(1);
          const v2 = await h.plans.savePlan({ ...p, name: 'v2' });
          const v3 = await h.plans.savePlan({ ...v2, name: 'v3' });
          expect([v2.version, v3.version]).toEqual([2, 3]);
          expect(await h.plans.findPlan(ORG, p.id)).toEqual(v3);
        });

        it('a stale save is rejected with CONCURRENT_UPDATE and cannot revert isActive, the policy or the merchant link', async () => {
          const m = await h.merchants.createMerchant(makeMerchant(), []);
          const p = await h.plans.createPlan(makePlan({ merchantId: m.id, isActive: true, policy: {} }));
          const off = await h.plans.savePlan({ ...p, isActive: false, policy: { maxDti: 0.4 }, merchantId: null, updatedAt: at(4) });
          await expectDomainError(h.plans.savePlan({ ...p, name: 'stale rename' }), 'CONCURRENT_UPDATE');
          expect(await h.plans.findPlan(ORG, p.id)).toEqual(off);
        });

        it('reports NOT_FOUND for another org\'s plan even with a stale version', async () => {
          const p = await h.plans.createPlan(makePlan());
          await h.plans.savePlan({ ...p, name: 'bump' });
          await expectDomainError(h.plans.savePlan({ ...p, orgId: OTHER_ORG }), 'NOT_FOUND');
        });

        it('parallel saves from the same version: exactly one wins', async () => {
          const p = await h.plans.createPlan(makePlan());
          const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => h.plans.savePlan({ ...p, name: `writer-${i}` })));
          const won = results.flatMap((r, i) => (r.status === 'fulfilled' ? [i] : []));
          expect(won).toHaveLength(1);
          for (const r of results) if (r.status === 'rejected') expect((r.reason as DomainError).code).toBe('CONCURRENT_UPDATE');
          const stored = (await h.plans.findPlan(ORG, p.id))!;
          expect(stored.name).toBe(`writer-${won[0]}`);
          expect(stored.version).toBe(2);
        });
      });

      describe('listing', () => {
        let m1: Awaited<ReturnType<MerchantRepository['createMerchant']>>;
        let m2: Awaited<ReturnType<MerchantRepository['createMerchant']>>;
        beforeEach(async () => {
          m1 = await h.merchants.createMerchant(makeMerchant(), []);
          m2 = await h.merchants.createMerchant(makeMerchant(), []);
          await h.plans.createPlan(makePlan({ code: 'C-GLOBAL', merchantId: null, isActive: true }));
          await h.plans.createPlan(makePlan({ code: 'A-M1', merchantId: m1.id, isActive: true }));
          await h.plans.createPlan(makePlan({ code: 'B-M1-OFF', merchantId: m1.id, isActive: false }));
          await h.plans.createPlan(makePlan({ code: 'D-M2', merchantId: m2.id, isActive: true }));
          await h.plans.createPlan(makePlan({ code: 'E-EXPIRED', merchantId: null, isActive: true, validFrom: at(-200), validTo: at(-100) }));
          await h.plans.createPlan(makePlan({ code: 'A-M1', merchantId: m1.id, orgId: OTHER_ORG }));
        });

        it('listPlans returns the org\'s plans ordered by code', async () => {
          expect(codes(await h.plans.listPlans(ORG, {}))).toEqual(['A-M1', 'B-M1-OFF', 'C-GLOBAL', 'D-M2', 'E-EXPIRED']);
        });

        it('listPlans filters by merchantId (exact match, excludes shared plans) and by isActive', async () => {
          expect(codes(await h.plans.listPlans(ORG, { merchantId: m1.id }))).toEqual(['A-M1', 'B-M1-OFF']);
          expect(codes(await h.plans.listPlans(ORG, { isActive: false }))).toEqual(['B-M1-OFF']);
          expect(codes(await h.plans.listPlans(ORG, { isActive: true, merchantId: m1.id }))).toEqual(['A-M1']);
          expect(await h.plans.listPlans(ORG, { merchantId: randomUUID() })).toEqual([]);
          expect(await h.plans.listPlans(ORG, { merchantId: 'nope' })).toEqual([]);
        });

        it('listPlansForMerchant returns shared and the merchant\'s own plans, including inactive and expired ones', async () => {
          expect(codes(await h.plans.listPlansForMerchant(ORG, m1.id))).toEqual(['A-M1', 'B-M1-OFF', 'C-GLOBAL', 'E-EXPIRED']);
          expect(codes(await h.plans.listPlansForMerchant(ORG, m2.id))).toEqual(['C-GLOBAL', 'D-M2', 'E-EXPIRED']);
          expect(codes(await h.plans.listPlansForMerchant(OTHER_ORG, m2.id))).toEqual([]);
          expect(codes(await h.plans.listPlansForMerchant(ORG, randomUUID()))).toEqual(['C-GLOBAL', 'E-EXPIRED']);
        });
      });
    });

    // ═════════════════════════════════ LeaseRepository ═════════════════════════════════
    describe('LeaseRepository: insert', () => {
      it('inserts a lease with its first timeline entry and events, and reads it back unchanged', async () => {
        const { refs } = await seed();
        const l = makeFullLease(refs);
        const ev = leaseDecided(l);
        const t = makeTimeline(l.id, { at: at(1, 250), action: 'CREATED', actor: 'MERCHANT:user-cashier', data: { source: 'POS', n: 1 } });
        expect(await h.leases.insertLease(l, t, [ev])).toEqual(l);
        expect(await h.leases.findLease(scope(), l.id)).toEqual(l);
        expect(await h.leases.timeline(l.id)).toEqual([{ id: expect.any(String), leaseId: l.id, at: at(1, 250), action: 'CREATED', fromStatus: null, toStatus: 'DRAFT', actor: 'MERCHANT:user-cashier', data: { source: 'POS', n: 1 } }]);
        expect(await h.readOutbox()).toEqual([ev]);
      });

      it('round-trips a sparse lease (all nullable columns null, empty arrays)', async () => {
        const { refs } = await seed();
        const l = makeLease(refs);
        await h.leases.insertLease(l, makeTimeline(l.id), []);
        expect(await h.leases.findLease(scope(), l.id)).toEqual(l);
      });

      it('keeps the quote snapshot as the source of truth: derived money columns follow quote, goods price stays separate', async () => {
        const { refs } = await seed();
        const l = makeLease(refs, {
          goodsPrice: 1_500_000, status: 'APPROVED',
          quote: makeQuote({ goodsPrice: 1_500_000, downPayment: 265_432.11, financedAmount: 1_234_567.89, merchantCommissionAmount: 37_037.04, merchantNetAmount: 1_197_530.85, feeAmount: 12_345.68, principal: 1_246_913.57 }),
        });
        await h.leases.insertLease(l, makeTimeline(l.id), []);
        expect((await h.leases.findLease(scope(), l.id))!.quote).toEqual(l.quote);
        const [row] = await h.leases.dashboardRows(scope(), at(0), at(60));
        expect(row).toMatchObject({ goodsPrice: 1_500_000, financedAmount: 1_234_567.89, merchantCommissionAmount: 37_037.04, merchantNetAmount: 1_197_530.85 });
      });

      it('enforces one idempotency key per merchant and writes nothing on conflict', async () => {
        const { refs } = await seed();
        const first = await insertLease(refs, { idempotencyKey: 'KEY-1' });
        const dup = makeLease(refs, { idempotencyKey: 'KEY-1' });
        const ev = leaseDecided(dup);
        await expectKeyConflict(h.leases.insertLease(dup, makeTimeline(dup.id), [ev]), 'IDEMPOTENCY');
        expect(await h.leases.findLease(scope(), dup.id)).toBeNull();
        expect(await h.leases.timeline(dup.id)).toEqual([]);
        expect((await h.readOutbox()).map((e) => e.eventId)).not.toContain(ev.eventId);
        expect((await h.leases.listLeases(scope(), {}, { page: 1, pageSize: 10 })).total).toBe(1);
        expect((await h.leases.findByIdempotencyKey(refs.merchantId, 'KEY-1'))!.id).toBe(first.id);
      });

      it('allows the same idempotency key for another merchant', async () => {
        const a = await seed();
        const b = await seed();
        const la = await insertLease(a.refs, { idempotencyKey: 'SHARED' });
        const lb = await insertLease(b.refs, { idempotencyKey: 'SHARED' });
        expect((await h.leases.findByIdempotencyKey(a.merchant.id, 'SHARED'))!.id).toBe(la.id);
        expect((await h.leases.findByIdempotencyKey(b.merchant.id, 'SHARED'))!.id).toBe(lb.id);
      });

      it('enforces a globally unique lease_no and writes nothing on conflict', async () => {
        const a = await seed();
        const b = await seed();
        const first = await insertLease(a.refs, { leaseNo: 'POS-2610-DUP001' });
        const dup = makeLease(b.refs, { leaseNo: 'POS-2610-DUP001' });
        const ev = leaseDecided(dup);
        await expectKeyConflict(h.leases.insertLease(dup, makeTimeline(dup.id), [ev]), 'LEASE_NO');
        expect(await h.leases.findLease(scope(), dup.id)).toBeNull();
        expect(await h.leases.timeline(dup.id)).toEqual([]);
        expect((await h.readOutbox()).map((e) => e.eventId)).not.toContain(ev.eventId);
        expect((await h.leases.findLease(scope(), first.id))!.leaseNo).toBe('POS-2610-DUP001');
      });

      it('reports IDEMPOTENCY when both the key and the lease_no collide', async () => {
        const { refs } = await seed();
        const first = await insertLease(refs, { idempotencyKey: 'K', leaseNo: 'POS-2610-BOTH01' });
        const dup = makeLease(refs, { idempotencyKey: first.idempotencyKey, leaseNo: first.leaseNo });
        await expectKeyConflict(h.leases.insertLease(dup, makeTimeline(dup.id), []), 'IDEMPOTENCY');
      });

      // pos_lease_version_check (version >= 1): service-ийн version 0 алдаа (n=0) Postgres дээр л илрэхээс сэргийлж санах ой ч үүнийг хүлээн авахгүй.
      it.each([0, -1, 1.5, Number.NaN])('rejects version %s (version must be an integer >= 1) and writes nothing, burning neither the key nor the lease number', async (version) => {
        const { refs } = await seed();
        const l = makeLease(refs, { version, idempotencyKey: 'VER-KEY', leaseNo: 'POS-2610-VERSN1' });
        const err = await rejection(h.leases.insertLease(l, makeTimeline(l.id), [leaseDecided(l)]));
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toMatch(/version/i);
        expect(await h.leases.findLease(scope(), l.id)).toBeNull();
        expect(await h.leases.findByIdempotencyKey(l.merchantId, 'VER-KEY')).toBeNull();
        expect(await h.leases.timeline(l.id)).toEqual([]);
        expect(await h.readOutbox()).toEqual([]);
        expect(await h.leases.insertLease({ ...l, version: 1 }, makeTimeline(l.id), [])).toEqual({ ...l, version: 1 }); // зөв version-оор ижил түлхүүр/дугаар орно
      });

      it('findByIdempotencyKey returns null for another merchant, an unknown key or a malformed merchant id', async () => {
        const a = await seed();
        const b = await seed();
        await insertLease(a.refs, { idempotencyKey: 'ONLY-A' });
        expect(await h.leases.findByIdempotencyKey(b.merchant.id, 'ONLY-A')).toBeNull();
        expect(await h.leases.findByIdempotencyKey(a.merchant.id, 'OTHER')).toBeNull();
        expect(await h.leases.findByIdempotencyKey('nope', 'ONLY-A')).toBeNull();
      });
    });

    describe('LeaseRepository: saveLease (optimistic locking)', () => {
      it('bumps the version, persists the changes, appends the timeline entry and writes the events', async () => {
        const { refs } = await seed();
        const l = await insertLease(refs, { version: 1 });
        const ev = leaseDecided(l);
        const changed: LeaseRecord = {
          ...l, status: 'REFERRED', decision: 'REFER', decisionReasons: [{ code: 'BLACKLISTED', severity: 'REFER' }], dtiRatio: 0.6012,
          affordability: { maxMonthlyPayment: 100_000, maxFinancedAmount: 900_000.5, suggestedMinDownPayment: null }, screeningSummary: { blacklistHit: true, ficoScore: 480 },
          decidedAt: at(3, 7), decidedBy: 'SYSTEM', consentVerifiedAt: at(2), consentTextVersion: 'v1', expiresAt: at(60 * 72), buyerLastName: 'Бат', buyerFirstName: 'Болд',
          goodsSerialNo: 'SN-1', quote: quoteOf(1_750_000.25), updatedAt: at(3, 7), updatedBy: 'SYSTEM',
        };
        const t = makeTimeline(l.id, { at: at(3, 7), action: 'SUBMITTED', fromStatus: 'DRAFT', toStatus: 'REFERRED', actor: 'SYSTEM', data: { reasons: ['BLACKLISTED'] } });
        const saved = await h.leases.saveLease(changed, t, [ev]);
        expect(saved).toEqual({ ...changed, version: 2 });
        expect(await h.leases.findLease(scope(), l.id)).toEqual({ ...changed, version: 2 });
        const tl = await h.leases.timeline(l.id);
        expect(tl.map((e) => e.action)).toEqual(['CREATED', 'SUBMITTED']);
        expect(tl[1]).toMatchObject({ fromStatus: 'DRAFT', toStatus: 'REFERRED', actor: 'SYSTEM', data: { reasons: ['BLACKLISTED'] } });
        expect(await h.readOutbox()).toEqual([ev]);
      });

      it('clears nullable columns when they are saved as null', async () => {
        const { refs } = await seed();
        const full = makeFullLease(refs, { status: 'APPROVED', version: 1 });
        await h.leases.insertLease(full, makeTimeline(full.id), []);
        const cleared: LeaseRecord = {
          ...full, decision: null, decisionReasons: [], dtiRatio: null, affordability: null, screeningSummary: null, decidedAt: null, decidedBy: null, decisionComment: null,
          consentVerifiedAt: null, consentTextVersion: null, expiresAt: null, acceptedAt: null, deliveredAt: null, deliveredBy: null, settledAt: null, settlementRef: null,
          cancelledAt: null, cancelReason: null, applicationId: null, buyerLastName: null, buyerFirstName: null, goodsSerialNo: null, updatedBy: null, updatedAt: at(9),
        };
        expect(await h.leases.saveLease(cleared, makeTimeline(full.id, { action: 'RESET' }), [])).toEqual({ ...cleared, version: 2 });
        expect(await h.leases.findLease(scope(), full.id)).toEqual({ ...cleared, version: 2 });
      });

      it('chained saves work with the returned version', async () => {
        const { refs } = await seed();
        const l = await insertLease(refs, { version: 1 });
        const v2 = await h.leases.saveLease({ ...l, status: 'APPROVED', updatedAt: at(2) }, makeTimeline(l.id, { at: at(2), action: 'DECIDED' }), []);
        const v3 = await h.leases.saveLease({ ...v2, status: 'ACCEPTED', acceptedAt: at(3), updatedAt: at(3) }, makeTimeline(l.id, { at: at(3), action: 'ACCEPTED' }), []);
        expect([v2.version, v3.version]).toEqual([2, 3]);
        expect((await h.leases.findLease(scope(), l.id))!).toMatchObject({ version: 3, status: 'ACCEPTED', acceptedAt: at(3) });
        expect((await h.leases.timeline(l.id)).map((e) => e.action)).toEqual(['CREATED', 'DECIDED', 'ACCEPTED']);
      });

      it('rejects a stale version with CONCURRENT_UPDATE and writes no timeline entry, no events and no row change', async () => {
        const { refs } = await seed();
        const l = await insertLease(refs, { version: 1 });
        const winner = await h.leases.saveLease({ ...l, status: 'APPROVED', updatedAt: at(2) }, makeTimeline(l.id, { at: at(2), action: 'WINNER' }), [leaseDecided(l)]);
        const staleEvent = leaseCancelled(l);
        const stale = h.leases.saveLease({ ...l, status: 'CANCELLED', cancelledAt: at(3), cancelReason: 'late', updatedAt: at(3) }, makeTimeline(l.id, { at: at(3), action: 'STALE' }), [staleEvent]);
        await expectDomainError(stale, 'CONCURRENT_UPDATE');
        expect(await h.leases.findLease(scope(), l.id)).toEqual(winner);
        expect((await h.leases.timeline(l.id)).map((e) => e.action)).toEqual(['CREATED', 'WINNER']);
        const outboxIds = (await h.readOutbox()).map((e) => e.eventId);
        expect(outboxIds).toHaveLength(1);
        expect(outboxIds).not.toContain(staleEvent.eventId);
      });

      it('rejects a version that is ahead of the stored one', async () => {
        const { refs } = await seed();
        const l = await insertLease(refs, { version: 1 });
        await expectDomainError(h.leases.saveLease({ ...l, version: 5, status: 'APPROVED' }, makeTimeline(l.id, { action: 'AHEAD' }), []), 'CONCURRENT_UPDATE');
        expect(await h.leases.findLease(scope(), l.id)).toEqual(l);
        expect(await h.leases.timeline(l.id)).toHaveLength(1);
      });

      it('fails with NOT_FOUND for an unknown lease and writes nothing', async () => {
        const { refs } = await seed();
        const ghost = makeLease(refs);
        await expectDomainError(h.leases.saveLease(ghost, makeTimeline(ghost.id), [leaseDecided(ghost)]), 'NOT_FOUND');
        expect(await h.readOutbox()).toEqual([]);
        expect(await h.leases.timeline(ghost.id)).toEqual([]);
      });

      it('never touches another org\'s lease: NOT_FOUND and nothing written', async () => {
        const { refs } = await seed();
        const l = await insertLease(refs, { version: 1 });
        const ev = leaseDecided(l);
        await expectDomainError(h.leases.saveLease({ ...l, orgId: OTHER_ORG, status: 'CANCELLED' }, makeTimeline(l.id, { action: 'HIJACK' }), [ev]), 'NOT_FOUND');
        expect(await h.leases.findLease(scope(), l.id)).toEqual(l);
        expect((await h.leases.timeline(l.id)).map((e) => e.action)).toEqual(['CREATED']);
        expect(await h.readOutbox()).toEqual([]);
      });

      it('lets exactly one of two concurrent saves with the same version win', async () => {
        const { refs } = await seed();
        const l = await insertLease(refs, { version: 1 });
        const evA = leaseDecided(l);
        const evB = leaseCancelled(l);
        const results = await Promise.allSettled([
          h.leases.saveLease({ ...l, status: 'REFERRED', updatedAt: at(2) }, makeTimeline(l.id, { at: at(2), action: 'A' }), [evA]),
          h.leases.saveLease({ ...l, status: 'CANCELLED', cancelledAt: at(2), updatedAt: at(2) }, makeTimeline(l.id, { at: at(2), action: 'B' }), [evB]),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const loser = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!;
        expect(loser.reason).toBeInstanceOf(DomainError);
        expect((loser.reason as DomainError).code).toBe('CONCURRENT_UPDATE');
        const final = (await h.leases.findLease(scope(), l.id))!;
        expect(final.version).toBe(2);
        const winnerIsA = final.status === 'REFERRED';
        expect((await h.leases.timeline(l.id)).map((e) => e.action)).toEqual(['CREATED', winnerIsA ? 'A' : 'B']);
        expect((await h.readOutbox()).map((e) => e.eventId)).toEqual([winnerIsA ? evA.eventId : evB.eventId]);
      });
    });

    describe('LeaseRepository: scope (tenant boundary)', () => {
      it('applies org, merchant, store and branch scope on findLease', async () => {
        const a = await seed({ branchId: 'b1' });
        const store2 = await addStore(a.merchant.id);
        const b = await seed({ branchId: 'b2' });
        const other = await seed({ orgId: OTHER_ORG, branchId: 'b1' });
        const l1 = await insertLease(a.refs);
        const l2 = await insertLease({ ...a.refs, storeId: store2.id });
        const l3 = await insertLease(b.refs);
        const l4 = await insertLease(other.refs);

        expect((await h.leases.findLease(scope(), l1.id))!.id).toBe(l1.id);
        expect(await h.leases.findLease(scope({ orgId: OTHER_ORG }), l1.id)).toBeNull();
        expect((await h.leases.findLease(scope({ orgId: OTHER_ORG }), l4.id))!.id).toBe(l4.id);
        expect(await h.leases.findLease(scope(), l4.id)).toBeNull();

        expect((await h.leases.findLease(scope({ merchantId: a.merchant.id }), l1.id))!.id).toBe(l1.id);
        expect(await h.leases.findLease(scope({ merchantId: b.merchant.id }), l1.id)).toBeNull();

        expect((await h.leases.findLease(scope({ merchantId: a.merchant.id, storeId: a.store.id }), l1.id))!.id).toBe(l1.id);
        expect(await h.leases.findLease(scope({ merchantId: a.merchant.id, storeId: store2.id }), l1.id)).toBeNull();
        expect((await h.leases.findLease(scope({ merchantId: a.merchant.id, storeId: store2.id }), l2.id))!.id).toBe(l2.id);

        expect((await h.leases.findLease(scope({ branchId: 'b1' }), l1.id))!.id).toBe(l1.id);
        expect(await h.leases.findLease(scope({ branchId: 'b2' }), l1.id)).toBeNull();
        expect((await h.leases.findLease(scope({ branchId: 'b2' }), l3.id))!.id).toBe(l3.id);
      });

      it('returns null / empty for unknown or malformed ids and scope ids', async () => {
        const a = await seed();
        const l = await insertLease(a.refs);
        expect(await h.leases.findLease(scope(), randomUUID())).toBeNull();
        expect(await h.leases.findLease(scope(), 'not-a-uuid')).toBeNull();
        expect(await h.leases.findLease(scope({ merchantId: 'not-a-uuid' }), l.id)).toBeNull();
        expect(await h.leases.findLease(scope({ storeId: 'not-a-uuid' }), l.id)).toBeNull();
        expect(await h.leases.listLeases(scope({ merchantId: 'not-a-uuid' }), {}, { page: 1, pageSize: 10 })).toEqual({ items: [], total: 0 });
        expect(await h.leases.dashboardRows(scope({ storeId: 'not-a-uuid' }), at(0), at(100))).toEqual([]);
        expect(await h.leases.timeline('not-a-uuid')).toEqual([]);
        expect(await h.leases.sumAcceptedFinanced('not-a-uuid', at(0), at(100))).toBe(0);
      });

      it('applies the scope to listLeases and dashboardRows', async () => {
        const a = await seed({ branchId: 'b1' });
        const store2 = await addStore(a.merchant.id);
        const b = await seed({ branchId: 'b2' });
        const other = await seed({ orgId: OTHER_ORG, branchId: 'b1' });
        const l1 = await insertLease(a.refs, { createdAt: at(1) });
        const l2 = await insertLease({ ...a.refs, storeId: store2.id }, { createdAt: at(2) });
        const l3 = await insertLease(b.refs, { createdAt: at(3) });
        await insertLease(other.refs, { createdAt: at(4) });
        const page = { page: 1, pageSize: 50 };
        const ids = async (s: LeaseScope) => (await h.leases.listLeases(s, {}, page)).items.map((l) => l.id);
        const rowIds = async (s: LeaseScope) => (await h.leases.dashboardRows(s, at(0), at(60))).map((r) => r.id).sort();

        expect(await ids(scope())).toEqual([l3.id, l2.id, l1.id]);
        expect(await ids(scope({ merchantId: a.merchant.id }))).toEqual([l2.id, l1.id]);
        expect(await ids(scope({ merchantId: a.merchant.id, storeId: store2.id }))).toEqual([l2.id]);
        expect(await ids(scope({ branchId: 'b2' }))).toEqual([l3.id]);
        expect(await ids(scope({ merchantId: b.merchant.id, branchId: 'b1' }))).toEqual([]);
        expect((await h.leases.listLeases(scope({ merchantId: a.merchant.id }), {}, page)).total).toBe(2);

        expect(await rowIds(scope())).toEqual([l1.id, l2.id, l3.id].sort());
        expect(await rowIds(scope({ merchantId: a.merchant.id, storeId: a.store.id }))).toEqual([l1.id]);
        expect(await rowIds(scope({ orgId: OTHER_ORG }))).toHaveLength(1);
      });

      // docs/05 §2, §8: BRANCH_MANAGER-ийн хүрээ = мерчантын ОДООГИЙН салбар (merchant.branch_id). pos_lease.branch_id нь үүсгэх үеийн түүхэн хуулбар (POS-BR-13).
      it("BRANCH scope follows the merchant's CURRENT branch on find, list and dashboard rows; the lease snapshot column is untouched", async () => {
        const a = await seed({ branchId: 'b1' });
        const store2 = await addStore(a.merchant.id);
        const b = await seed({ branchId: 'b2' });
        const la1 = await insertLease(a.refs, { createdAt: at(1) });
        const la2 = await insertLease({ ...a.refs, storeId: store2.id }, { createdAt: at(2) });
        const lb = await insertLease(b.refs, { createdAt: at(3) });
        const page = { page: 1, pageSize: 50 };
        const ids = async (s: LeaseScope) => (await h.leases.listLeases(s, {}, page)).items.map((l) => l.id);
        const rowIds = async (s: LeaseScope) => (await h.leases.dashboardRows(s, at(0), at(60))).map((r) => r.id).sort();
        expect(await ids(scope({ branchId: 'b1' }))).toEqual([la2.id, la1.id]);

        // Мерчант A b1 → b2 руу шилжинэ
        await h.merchants.saveMerchant({ ...a.merchant, branchId: 'b2' }, []);

        expect(await h.leases.findLease(scope({ branchId: 'b1' }), la1.id)).toBeNull();
        expect((await h.leases.findLease(scope({ branchId: 'b2' }), la1.id))!.id).toBe(la1.id);
        expect((await h.leases.findLease(scope({ branchId: 'b2' }), la2.id))!.id).toBe(la2.id);
        expect(await ids(scope({ branchId: 'b1' }))).toEqual([]);
        expect((await h.leases.listLeases(scope({ branchId: 'b1' }), {}, page)).total).toBe(0);
        expect(await ids(scope({ branchId: 'b2' }))).toEqual([lb.id, la2.id, la1.id]);
        expect((await h.leases.listLeases(scope({ branchId: 'b2' }), {}, { page: 1, pageSize: 2 })).total).toBe(3);
        expect(await rowIds(scope({ branchId: 'b1' }))).toEqual([]);
        expect(await rowIds(scope({ branchId: 'b2' }))).toEqual([la1.id, la2.id, lb.id].sort());
        // merchant-ийн scope-той хавсарсан үед ч мерчантын одоогийн салбараар шүүнэ
        expect(await ids(scope({ merchantId: a.merchant.id, branchId: 'b1' }))).toEqual([]);
        expect(await ids(scope({ merchantId: a.merchant.id, branchId: 'b2' }))).toEqual([la2.id, la1.id]);

        // түүхэн хуулбар өөрчлөгдөөгүй
        expect((await h.leases.findLease(scope(), la1.id))!.branchId).toBe('b1');
        expect((await h.leases.findLease(scope(), la2.id))!.branchId).toBe('b1');
      });
    });

    describe('LeaseRepository: listLeases', () => {
      let refs: LeaseRefs;
      let draft: LeaseRecord;
      let approved: LeaseRecord;
      let accepted: LeaseRecord;
      let cancelled: LeaseRecord;
      beforeEach(async () => {
        ({ refs } = await seed());
        draft = await insertLease(refs, { status: 'DRAFT', createdAt: at(0), leaseNo: 'POS-2610-ABC123', buyerPhone: '99112233', buyerRegisterHash: 'hash-1' });
        approved = await insertLease(refs, { status: 'APPROVED', createdAt: at(10), leaseNo: 'POS-2610-XYZ789', buyerPhone: '88112299', buyerRegisterHash: 'hash-2' });
        accepted = await insertLease(refs, { status: 'ACCEPTED', createdAt: at(20), leaseNo: 'POS-2610-ABD456', buyerPhone: '95550033', buyerRegisterHash: 'hash-1' });
        cancelled = await insertLease(refs, { status: 'CANCELLED', createdAt: at(30), leaseNo: 'POS-2610-QQQ000', buyerPhone: '99990033', buyerRegisterHash: 'hash-3' });
      });
      const ids = async (filter: Parameters<LeaseRepository['listLeases']>[1], page = { page: 1, pageSize: 50 }) => (await h.leases.listLeases(scope(), filter, page)).items.map((l) => l.id);

      it('orders by createdAt descending and returns full records', async () => {
        const r = await h.leases.listLeases(scope(), {}, { page: 1, pageSize: 50 });
        expect(r.items.map((l) => l.id)).toEqual([cancelled.id, accepted.id, approved.id, draft.id]);
        expect(r.items[3]).toEqual(draft);
        expect(r.total).toBe(4);
      });

      it('filters by one or more statuses (empty list means no filter)', async () => {
        expect(await ids({ statuses: ['APPROVED'] })).toEqual([approved.id]);
        expect(await ids({ statuses: ['DRAFT', 'ACCEPTED'] })).toEqual([accepted.id, draft.id]);
        expect(await ids({ statuses: [] })).toHaveLength(4);
        expect(await ids({ statuses: ['SETTLED'] })).toEqual([]);
      });

      it('filters createdAt within [from, to)', async () => {
        expect(await ids({ from: at(10) })).toEqual([cancelled.id, accepted.id, approved.id]); // from inclusive
        expect(await ids({ to: at(20) })).toEqual([approved.id, draft.id]); // to exclusive
        expect(await ids({ from: at(10), to: at(30) })).toEqual([accepted.id, approved.id]);
        expect(await ids({ from: at(10, 1), to: at(20, -1) })).toEqual([]);
      });

      it('searches the lease number case-insensitively by substring', async () => {
        expect(await ids({ leaseNoLike: 'abc' })).toEqual([draft.id]);
        expect(await ids({ leaseNoLike: 'POS-2610-AB' })).toEqual([accepted.id, draft.id]);
        expect(await ids({ leaseNoLike: 'xyz789' })).toEqual([approved.id]);
        expect(await ids({ leaseNoLike: 'nothing' })).toEqual([]);
        expect(await ids({ leaseNoLike: '%' })).toEqual([]);
        expect(await ids({ leaseNoLike: '_' })).toEqual([]);
        expect(await ids({ leaseNoLike: 'A_C' })).toEqual([]);
      });

      it('filters by the buyer phone suffix', async () => {
        expect(await ids({ buyerPhoneSuffix: '0033' })).toEqual([cancelled.id, accepted.id]);
        expect(await ids({ buyerPhoneSuffix: '2233' })).toEqual([draft.id]);
        expect(await ids({ buyerPhoneSuffix: '99' })).toEqual([approved.id]);
        expect(await ids({ buyerPhoneSuffix: '1122' })).toEqual([]); // suffix, not substring
        expect(await ids({ buyerPhoneSuffix: '%' })).toEqual([]);
      });

      it('filters by the exact buyer register hash', async () => {
        expect(await ids({ buyerRegisterHash: 'hash-1' })).toEqual([accepted.id, draft.id]);
        expect(await ids({ buyerRegisterHash: 'hash-3' })).toEqual([cancelled.id]);
        expect(await ids({ buyerRegisterHash: 'hash' })).toEqual([]);
      });

      it('combines filters', async () => {
        expect(await ids({ statuses: ['DRAFT', 'ACCEPTED'], buyerRegisterHash: 'hash-1', from: at(5) })).toEqual([accepted.id]);
        expect(await ids({ leaseNoLike: 'ab', buyerPhoneSuffix: '33', to: at(15) })).toEqual([draft.id]);
      });

      it('paginates with a stable total', async () => {
        const p1 = await h.leases.listLeases(scope(), {}, { page: 1, pageSize: 3 });
        const p2 = await h.leases.listLeases(scope(), {}, { page: 2, pageSize: 3 });
        const p3 = await h.leases.listLeases(scope(), {}, { page: 3, pageSize: 3 });
        expect(p1.items.map((l) => l.id)).toEqual([cancelled.id, accepted.id, approved.id]);
        expect(p2.items.map((l) => l.id)).toEqual([draft.id]);
        expect(p3.items).toEqual([]);
        expect([p1.total, p2.total, p3.total]).toEqual([4, 4, 4]);
        const filtered = await h.leases.listLeases(scope(), { statuses: ['DRAFT', 'ACCEPTED', 'CANCELLED'] }, { page: 2, pageSize: 2 });
        expect(filtered.items.map((l) => l.id)).toEqual([draft.id]);
        expect(filtered.total).toBe(3);
      });
    });

    describe('LeaseRepository: timeline', () => {
      it('orders entries by (at, id): by time first, insertion order for equal times', async () => {
        const { refs } = await seed();
        const l = await insertLease(refs, { createdAt: at(5) }); // timeline #1 at t+5
        let cur = l;
        const steps: Array<[string, Date]> = [['EARLIER', at(1)], ['TIE_A', at(5)], ['LATER', at(9)], ['TIE_B', at(5)], ['TIE_C', at(5)]];
        for (const [action, when] of steps) cur = await h.leases.saveLease({ ...cur, updatedAt: when }, makeTimeline(l.id, { at: when, action }), []);
        expect((await h.leases.timeline(l.id)).map((e) => e.action)).toEqual(['EARLIER', 'CREATED', 'TIE_A', 'TIE_B', 'TIE_C', 'LATER']);
      });

      it('returns actor, statuses and JSON data intact, with unique ids, and only for that lease', async () => {
        const { refs } = await seed();
        const l = await insertLease(refs);
        const other = await insertLease(refs);
        const actors = ['SYSTEM', 'BUYER', 'MERCHANT:user-cashier-7', 'LENDER:5f1d3a2b-0000-4000-8000-000000000001'];
        let cur = l;
        for (const [i, actor] of actors.entries()) {
          cur = await h.leases.saveLease(
            { ...cur, updatedAt: at(10 + i) },
            makeTimeline(l.id, { at: at(10 + i, i), action: `ACT_${i}`, fromStatus: 'DRAFT', toStatus: 'APPROVED', actor, data: i % 2 ? null : { nested: { list: [1, 'a', null, true], text: 'Сайн байна уу 🙂' }, n: 12.5 } }),
            [],
          );
        }
        const tl = await h.leases.timeline(l.id);
        expect(tl.slice(1).map((e) => e.actor)).toEqual(actors);
        expect(tl.slice(1).map((e) => e.data)).toEqual([{ nested: { list: [1, 'a', null, true], text: 'Сайн байна уу 🙂' }, n: 12.5 }, null, { nested: { list: [1, 'a', null, true], text: 'Сайн байна уу 🙂' }, n: 12.5 }, null]);
        expect(tl[1]).toMatchObject({ leaseId: l.id, at: at(10), fromStatus: 'DRAFT', toStatus: 'APPROVED' });
        expect(new Set(tl.map((e) => e.id)).size).toBe(tl.length);
        expect(tl.every((e) => e.leaseId === l.id)).toBe(true);
        expect(await h.leases.timeline(other.id)).toHaveLength(1);
        expect(await h.leases.timeline(randomUUID())).toEqual([]);
      });
    });

    describe('LeaseRepository: dashboardRows', () => {
      it('returns lightweight rows for createdAt in [from, to) with money from the quote', async () => {
        const { refs } = await seed();
        const from = at(100);
        const to = at(200);
        const before = await insertLease(refs, { createdAt: at(100, -1) });
        const atFrom = await insertLease(refs, { createdAt: from, status: 'APPROVED', decision: 'APPROVE', decidedAt: at(100, 900), decidedBy: 'SYSTEM', expiresAt: at(140), quote: quoteOf(1_234_567.89) });
        const inside = await insertLease(refs, {
          createdAt: at(150), status: 'SETTLED', decision: 'REFER', decidedAt: at(151), decidedBy: 'REVIEWER', acceptedAt: at(152), deliveredAt: at(153), settledAt: at(154),
          goodsPrice: 987_654.32, quote: quoteOf(500_000.01),
        });
        const lastMs = await insertLease(refs, { createdAt: at(200, -1) });
        const atTo = await insertLease(refs, { createdAt: to });
        void before; void atTo;
        const rows = (await h.leases.dashboardRows(scope(), from, to)).sort(byId);
        expect(rows).toEqual([atFrom, inside, lastMs].map(dashboardRowOf).sort(byId));
        const insideRow = rows.find((r) => r.id === inside.id)!;
        expect(insideRow).toEqual({
          id: inside.id, status: 'SETTLED', storeId: refs.storeId, planCode: refs.planCode, decision: 'REFER', createdAt: at(150), decidedAt: at(151), decidedBy: 'REVIEWER', expiresAt: null,
          acceptedAt: at(152), deliveredAt: at(153), settledAt: at(154), goodsPrice: 987_654.32, financedAmount: 500_000.01, merchantCommissionAmount: 15_000, merchantNetAmount: 485_000.01,
        });
        expect(Object.keys(insideRow)).not.toContain('buyerPhone'); // PII-гүй
      });

      it('returns an empty list for an empty window', async () => {
        const { refs } = await seed();
        await insertLease(refs, { createdAt: at(10) });
        expect(await h.leases.dashboardRows(scope(), at(10), at(10))).toEqual([]);
        expect(await h.leases.dashboardRows(scope(), at(11), at(20))).toEqual([]);
      });
    });

    describe('LeaseRepository: sumAcceptedFinanced', () => {
      const from = at(100);
      const to = at(200);
      it('sums financed amounts of ACCEPTED/DELIVERED/SETTLED leases accepted within [from, to)', async () => {
        const { refs, merchant } = await seed();
        const other = await seed();
        const lease = (status: LeaseRecord['status'], acceptedAt: Date | null, financed: number, r: LeaseRefs = refs) => insertLease(r, { status, acceptedAt, quote: quoteOf(financed) });
        await lease('ACCEPTED', from, 100_000.1); // counted: from inclusive
        await lease('DELIVERED', at(150), 200_000.2); // counted
        await lease('SETTLED', at(200, -1), 300_000.3); // counted: last ms
        await lease('ACCEPTED', to, 1_000_000); // excluded: to exclusive
        await lease('ACCEPTED', at(100, -1), 1_000_000); // excluded: before
        await lease('CANCELLED', at(150), 1_000_000); // excluded: cancelled after accept
        await lease('APPROVED', at(150), 1_000_000); // excluded: status
        await lease('EXPIRED', at(150), 1_000_000);
        await lease('DRAFT', null, 1_000_000);
        await lease('ACCEPTED', at(150), 1_000_000, other.refs); // excluded: other merchant
        expect(await h.leases.sumAcceptedFinanced(merchant.id, from, to)).toBe(600_000.6); // exact decimal sum (not 600000.6000000001)
        expect(await h.leases.sumAcceptedFinanced(other.merchant.id, from, to)).toBe(1_000_000);
      });

      it('returns 0 when nothing matches', async () => {
        const { refs, merchant } = await seed();
        expect(await h.leases.sumAcceptedFinanced(merchant.id, from, to)).toBe(0);
        await insertLease(refs, { status: 'ACCEPTED', acceptedAt: at(500), quote: quoteOf(10) });
        expect(await h.leases.sumAcceptedFinanced(merchant.id, from, to)).toBe(0);
        expect(await h.leases.sumAcceptedFinanced(randomUUID(), from, to)).toBe(0);
      });
    });

    describe('LeaseRepository: listExpirable', () => {
      it('returns only DRAFT/REFERRED/APPROVED leases whose expiresAt is strictly before now, oldest first, limited', async () => {
        const a = await seed();
        const b = await seed();
        const now = at(1000);
        const mk = (status: LeaseRecord['status'], expiresAt: Date | null, r: LeaseRefs = a.refs) => insertLease(r, { status, expiresAt });
        const d3 = await mk('DRAFT', at(900));
        const r1 = await mk('REFERRED', at(700), b.refs);
        const a2 = await mk('APPROVED', at(800));
        const d4 = await mk('DRAFT', at(999, 999));
        await mk('DRAFT', now); // boundary: not < now
        await mk('DRAFT', at(1001)); // future
        await mk('DRAFT', null); // no expiry
        for (const s of ['DECLINED', 'ACCEPTED', 'DELIVERED', 'SETTLED', 'CANCELLED', 'EXPIRED'] as const) await mk(s, at(500));

        const all = await h.leases.listExpirable(now, 100);
        expect(all.map((l) => l.id)).toEqual([r1.id, a2.id, d3.id, d4.id]);
        expect(all[0]).toEqual(r1);
        expect((await h.leases.listExpirable(now, 2)).map((l) => l.id)).toEqual([r1.id, a2.id]);
        expect(await h.leases.listExpirable(now, 0)).toEqual([]);
        expect(await h.leases.listExpirable(at(100), 10)).toEqual([]);
      });
    });

    // ═════════════════════════════════ OtpRepository ═════════════════════════════════
    describe('OtpRepository', () => {
      it('inserts an OTP and reads it back via latestOtp with every field intact', async () => {
        const { refs } = await seed();
        const l = await insertLease(refs);
        const o = makeOtp(l.id, { purpose: 'ACCEPT', attempts: 2, verifiedAt: at(3, 5), sentAt: at(1, 123), expiresAt: at(6, 123) });
        expect(await h.otps.insertOtp(o)).toEqual(o);
        expect(await h.otps.latestOtp(l.id, 'ACCEPT')).toEqual(o);
        const sparse = makeOtp(l.id, { purpose: 'CONSENT', verifiedAt: null });
        await h.otps.insertOtp(sparse);
        expect(await h.otps.latestOtp(l.id, 'CONSENT')).toEqual(sparse);
      });

      it('latestOtp returns the most recently sent OTP of that purpose only', async () => {
        const { refs } = await seed();
        const l = await insertLease(refs);
        const other = await insertLease(refs);
        const first = makeOtp(l.id, { purpose: 'CONSENT', sentAt: at(1) });
        const latest = makeOtp(l.id, { purpose: 'CONSENT', sentAt: at(5) });
        const middle = makeOtp(l.id, { purpose: 'CONSENT', sentAt: at(3) });
        for (const o of [first, latest, middle]) await h.otps.insertOtp(o); // not inserted in sentAt order
        await h.otps.insertOtp(makeOtp(l.id, { purpose: 'ACCEPT', sentAt: at(9) }));
        await h.otps.insertOtp(makeOtp(other.id, { purpose: 'CONSENT', sentAt: at(20) }));
        expect((await h.otps.latestOtp(l.id, 'CONSENT'))!.id).toBe(latest.id);
        expect((await h.otps.latestOtp(l.id, 'ACCEPT'))!.sentAt).toEqual(at(9));
      });

      it('latestOtp returns null when there is none (or for unknown / malformed leases)', async () => {
        const { refs } = await seed();
        const l = await insertLease(refs);
        expect(await h.otps.latestOtp(l.id, 'CONSENT')).toBeNull();
        await h.otps.insertOtp(makeOtp(l.id, { purpose: 'CONSENT' }));
        expect(await h.otps.latestOtp(l.id, 'ACCEPT')).toBeNull();
        expect(await h.otps.latestOtp(randomUUID(), 'CONSENT')).toBeNull();
        expect(await h.otps.latestOtp('not-a-uuid', 'CONSENT')).toBeNull();
      });

      it('countOtps counts every purpose of that lease only', async () => {
        const { refs } = await seed();
        const l = await insertLease(refs);
        const other = await insertLease(refs);
        expect(await h.otps.countOtps(l.id)).toBe(0);
        await h.otps.insertOtp(makeOtp(l.id, { purpose: 'CONSENT' }));
        await h.otps.insertOtp(makeOtp(l.id, { purpose: 'CONSENT', sentAt: at(2) }));
        await h.otps.insertOtp(makeOtp(l.id, { purpose: 'ACCEPT', sentAt: at(3) }));
        await h.otps.insertOtp(makeOtp(other.id));
        expect(await h.otps.countOtps(l.id)).toBe(3);
        expect(await h.otps.countOtps(other.id)).toBe(1);
        expect(await h.otps.countOtps(randomUUID())).toBe(0);
        expect(await h.otps.countOtps('not-a-uuid')).toBe(0);
      });

      it('saveOtp persists attempts and verification, and fails with NOT_FOUND for an unknown OTP', async () => {
        const { refs } = await seed();
        const l = await insertLease(refs);
        const o = await h.otps.insertOtp(makeOtp(l.id));
        const updated = { ...o, attempts: 3, verifiedAt: at(4, 9), codeHash: 'd'.repeat(64), expiresAt: at(7) };
        expect(await h.otps.saveOtp(updated)).toEqual(updated);
        expect(await h.otps.latestOtp(l.id, 'CONSENT')).toEqual(updated);
        expect(await h.otps.countOtps(l.id)).toBe(1);
        await expectDomainError(h.otps.saveOtp(makeOtp(l.id)), 'NOT_FOUND');
        await expectDomainError(h.otps.saveOtp({ ...updated, id: 'not-a-uuid' }), 'NOT_FOUND');
        await expectDomainError(h.otps.saveOtp({ ...updated, orgId: OTHER_ORG, attempts: 99 }), 'NOT_FOUND'); // өөр байгууллагын OTP-г өөрчлөхгүй
        expect(await h.otps.latestOtp(l.id, 'CONSENT')).toEqual(updated);
      });

      it('registerOtpAttempt counts atomically up to the limit and never beyond (parallel brute force)', async () => {
        const { refs } = await seed();
        const l = await insertLease(refs);
        const o = await h.otps.insertOtp(makeOtp(l.id, { attempts: 0 }));
        const results = await Promise.all(Array.from({ length: 12 }, () => h.otps.registerOtpAttempt(o, 3)));
        expect(results.filter((r) => r !== null).sort()).toEqual([1, 2, 3]);
        expect(results.filter((r) => r === null)).toHaveLength(9);
        expect((await h.otps.latestOtp(l.id, 'CONSENT'))!.attempts).toBe(3);
        expect(await h.otps.registerOtpAttempt(o, 3)).toBeNull();
      });

      it('registerOtpAttempt refuses a verified, unknown, malformed or foreign-org OTP', async () => {
        const { refs } = await seed();
        const l = await insertLease(refs);
        const o = await h.otps.insertOtp(makeOtp(l.id));
        expect(await h.otps.registerOtpAttempt({ id: randomUUID(), orgId: ORG }, 3)).toBeNull();
        expect(await h.otps.registerOtpAttempt({ id: 'not-a-uuid', orgId: ORG }, 3)).toBeNull();
        expect(await h.otps.registerOtpAttempt({ id: o.id, orgId: OTHER_ORG }, 3)).toBeNull();
        expect(await h.otps.markOtpVerified(o, at(2))).toBe(true);
        expect(await h.otps.registerOtpAttempt(o, 3)).toBeNull();
        expect((await h.otps.latestOtp(l.id, 'CONSENT'))!.attempts).toBe(0);
      });

      it('markOtpVerified succeeds exactly once, even in parallel, and only for the owning org', async () => {
        const { refs } = await seed();
        const l = await insertLease(refs);
        const o = await h.otps.insertOtp(makeOtp(l.id));
        expect(await h.otps.markOtpVerified({ id: o.id, orgId: OTHER_ORG }, at(2))).toBe(false);
        expect(await h.otps.markOtpVerified({ id: 'not-a-uuid', orgId: ORG }, at(2))).toBe(false);
        const results = await Promise.all(Array.from({ length: 5 }, () => h.otps.markOtpVerified(o, at(2))));
        expect(results.filter(Boolean)).toHaveLength(1);
        expect((await h.otps.latestOtp(l.id, 'CONSENT'))!.verifiedAt).toEqual(at(2));
        expect(await h.otps.markOtpVerified(o, at(9))).toBe(false);
        expect((await h.otps.latestOtp(l.id, 'CONSENT'))!.verifiedAt).toEqual(at(2));
      });
    });
  });
}
