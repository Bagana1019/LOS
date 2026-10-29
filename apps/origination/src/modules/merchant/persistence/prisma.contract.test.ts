import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { DomainEvent } from '@los/contracts';
import { Prisma } from './prisma/client';
import { DomainError } from '../domain/errors';
import { at, leaseCancelled, leaseDecided, makeLease, makeMerchant, makePlan, makeQuote, makeStore, makeTimeline, merchantStatusChanged, ORG } from './contract-fixtures';
import { MerchantRepository } from './repositories';
import { PrismaLeaseRepository } from './prisma/prisma-lease.repository';
import { PrismaMerchantRepository } from './prisma/prisma-merchant.repository';
import { PrismaOtpRepository } from './prisma/prisma-otp.repository';
import { prismaPersistenceProviders } from './prisma/prisma-persistence.providers';
import { PrismaPlanRepository } from './prisma/prisma-plan.repository';
import { PrismaModule, PrismaService } from '../../../prisma.service';
import { describeRepositoryContract } from './repository.contract';
import { dbTestGuard, TEST_OUTBOX_TYPES } from '../testing/db-test-guard';

// Бодит PostgreSQL дээрх contract. Санах ойн хэрэгжүүлэлттэй ИЖИЛ suite + транзакц/схемийн Postgres-д онцлог шалгалтууд.
//
// АЮУЛГҮЙ БАЙДАЛ: тест бүрийн өмнө merchant POS-ийн 6 хүснэгтийг TRUNCATE хийнэ (хуваалцсан `outbox`-ыг БИШ — зөвхөн POS event төрлийн мөрийг устгана). Тиймээс DATABASE_URL тавигдсан БА
// (өгөгдлийн сангийн нэр тусдаа `test` үгтэй ЭСВЭЛ хөгжүүлэгч ӨӨРӨӨ LOS_DB_TEST_ALLOW_TRUNCATE=1 тавьсан) үед л ажиллана. Module 0-ийн `pnpm test` (TEST_DATABASE_URL → DATABASE_URL) энэ
// флагийг өөрөө ТАВЬДАГГҮЙ. Бусад үед алгасна (dev DB-г санамсаргүй устгахаас сэргийлнэ). Логик: ../testing/db-test-guard.ts
const guard = dbTestGuard();
const enabled = guard.enabled;
if (guard.skipReason) console.warn(`[prisma.contract] skipped: ${guard.skipReason}`);

const TABLES = ['pos_lease_event', 'pos_lease_otp', 'pos_lease', 'pos_lease_plan', 'merchant_store', 'merchant'].map((t) => `origination.${t}`);
/** Outbox дахь энэ тестийн өөрийн мөрүүд (бусад модулийн event-д хүрэхгүй). */
const ownOutbox = { type: { in: [...TEST_OUTBOX_TYPES] } };

describe.skipIf(!enabled)('postgres (prisma)', () => {
  let prisma: PrismaService;
  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
  });
  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  const merchants = () => new PrismaMerchantRepository(prisma);
  const plans = () => new PrismaPlanRepository(prisma);
  const leases = () => new PrismaLeaseRepository(prisma);
  const otps = () => new PrismaOtpRepository(prisma);
  const readOutbox = async () => (await prisma.outbox.findMany({ where: ownOutbox, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).map((r) => r.payload as unknown as DomainEvent);
  const reset = async () => {
    await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
    await prisma.outbox.deleteMany({ where: ownOutbox }); // хуваалцсан outbox: бусад модулийн unpublished event-д хүрэхгүй
  };

  describeRepositoryContract('postgres', () => ({ merchants: merchants(), plans: plans(), leases: leases(), otps: otps(), readOutbox, reset }));

  // ───────────── Тестийн аюулгүй байдал, optimistic lock-ийн баганын CHECK ─────────────
  describe('harness safety and version columns', () => {
    it('reset() clears only the merchant POS outbox rows and leaves other modules\' events alone', async () => {
      const foreign = await prisma.outbox.create({ data: { type: 'ApplicationSubmitted', payload: { other: 'module' } } });
      const own = await prisma.outbox.create({ data: { type: 'PosLeaseDecided', payload: { mine: true } } });
      try {
        await reset();
        expect(await prisma.outbox.findUnique({ where: { id: foreign.id } })).not.toBeNull();
        expect(await prisma.outbox.findUnique({ where: { id: own.id } })).toBeNull();
      } finally {
        await prisma.outbox.deleteMany({ where: { id: foreign.id } });
      }
    });

    it('merchant, merchant_store and pos_lease_plan default to version 1 and reject version < 1 at the database', async () => {
      await reset();
      const m = await merchants().createMerchant(makeMerchant(), []);
      const s = await merchants().createStore(makeStore(m.id));
      const p = await plans().createPlan(makePlan());
      expect([m.version, s.version, p.version]).toEqual([1, 1, 1]);
      const bad = async (table: 'merchant' | 'merchant_store' | 'pos_lease_plan', id: string) =>
        prisma.$executeRawUnsafe(`UPDATE origination.${table} SET version = 0 WHERE id = $1::uuid`, id).then(() => undefined, (e: unknown) => String(e));
      expect(await bad('merchant', m.id)).toContain('merchant_version_check');
      expect(await bad('merchant_store', s.id)).toContain('merchant_store_version_check');
      expect(await bad('pos_lease_plan', p.id)).toContain('pos_lease_plan_version_check');
    });
  });

  // ───────────── Postgres-д онцлог: транзакц, схем ─────────────
  describe('transactionality (business row, timeline and outbox commit or roll back together)', () => {
    /** Outbox-д тухайн eventId аль хэдийн байгаа гэж дүр эсгэнэ → дараагийн outbox бичилт P2002-оор унана. */
    const occupyOutboxId = (eventId: string) => prisma.outbox.create({ data: { id: eventId, type: 'PRE_EXISTING', payload: { marker: true } } });
    const outboxIds = async () => (await prisma.outbox.findMany({ where: ownOutbox })).map((r) => r.id).sort();
    const isP2002 = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
    const reason = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);

    async function seedLeaseDeps() {
      await reset();
      const merchant = await merchants().createMerchant(makeMerchant(), []);
      const store = await merchants().createStore(makeStore(merchant.id));
      const plan = await plans().createPlan(makePlan());
      return { merchant, refs: { merchantId: merchant.id, storeId: store.id, planId: plan.id, branchId: merchant.branchId, planCode: plan.code } };
    }

    it('createMerchant: a failing outbox write rolls the merchant back', async () => {
      await reset();
      const m = makeMerchant();
      const ev = merchantStatusChanged(m.id);
      await occupyOutboxId(ev.eventId);
      const err = await reason(merchants().createMerchant(m, [ev]));
      expect(isP2002(err)).toBe(true);
      expect(err).not.toBeInstanceOf(DomainError); // outbox-ын давхар id нь DUPLICATE_CODE болж далдлагдахгүй
      expect(await merchants().findMerchant(ORG, m.id)).toBeNull();
      expect(await outboxIds()).toEqual([ev.eventId]);
    });

    it('saveMerchant: a failing outbox write leaves the merchant unchanged', async () => {
      await reset();
      const m = await merchants().createMerchant(makeMerchant(), []);
      const ev = merchantStatusChanged(m.id);
      await occupyOutboxId(ev.eventId);
      const err = await reason(merchants().saveMerchant({ ...m, name: 'changed', status: 'SUSPENDED', updatedAt: at(5) }, [ev]));
      expect(isP2002(err)).toBe(true);
      expect(await merchants().findMerchant(ORG, m.id)).toEqual(m);
    });

    it('insertLease: a failing outbox write rolls back the lease and its timeline entry', async () => {
      const { refs } = await seedLeaseDeps();
      const l = makeLease(refs);
      const ev = leaseDecided(l);
      await occupyOutboxId(ev.eventId);
      const err = await reason(leases().insertLease(l, makeTimeline(l.id), [ev]));
      expect(isP2002(err)).toBe(true);
      expect(await leases().findLease({ orgId: ORG }, l.id)).toBeNull();
      expect(await prisma.posLeaseEvent.count()).toBe(0);
      expect(await prisma.posLease.count()).toBe(0);
      expect(await outboxIds()).toEqual([ev.eventId]);
    });

    it('saveLease: a failing outbox write rolls back the update (version, columns) and the timeline entry', async () => {
      const { refs } = await seedLeaseDeps();
      const l = makeLease(refs, { version: 1 });
      await leases().insertLease(l, makeTimeline(l.id), []);
      const ev = leaseCancelled(l);
      await occupyOutboxId(ev.eventId);
      const err = await reason(leases().saveLease({ ...l, status: 'CANCELLED', cancelledAt: at(3), cancelReason: 'x', updatedAt: at(3) }, makeTimeline(l.id, { at: at(3), action: 'CANCELLED' }), [ev]));
      expect(isP2002(err)).toBe(true);
      expect(await leases().findLease({ orgId: ORG }, l.id)).toEqual(l); // version 1, status DRAFT
      expect((await leases().timeline(l.id)).map((e) => e.action)).toEqual(['CREATED']);
      expect(await outboxIds()).toEqual([ev.eventId]);
      // дараа нь outbox-ын асуудал арилвал ижил version-оор амжилттай хадгалагдана
      await prisma.outbox.deleteMany({ where: { id: ev.eventId, type: 'PRE_EXISTING' } }); // зөвхөн энэ тестийн marker (хуваалцсан outbox-ыг цэвэрлэхгүй)
      const ok = await leases().saveLease({ ...l, status: 'CANCELLED', cancelledAt: at(3), cancelReason: 'x', updatedAt: at(3) }, makeTimeline(l.id, { at: at(3), action: 'CANCELLED' }), [ev]);
      expect(ok.version).toBe(2);
    });

    it('rolls back when two events in one batch share an eventId', async () => {
      const { refs } = await seedLeaseDeps();
      const l = makeLease(refs);
      const ev = leaseDecided(l);
      const err = await reason(leases().insertLease(l, makeTimeline(l.id), [ev, { ...ev }]));
      expect(isP2002(err)).toBe(true);
      expect(await leases().findLease({ orgId: ORG }, l.id)).toBeNull();
      expect(await outboxIds()).toEqual([]);
    });

    it('rejects an event that violates the contracts schema before writing anything', async () => {
      const { refs } = await seedLeaseDeps();
      const l = makeLease(refs);
      const bad = { ...leaseDecided(l), decision: 'MAYBE' } as unknown as DomainEvent;
      const err = await reason(leases().insertLease(l, makeTimeline(l.id), [bad]));
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('PosLeaseDecided');
      expect((err as Error).message).not.toContain(l.buyerPhone);
      expect(await prisma.posLease.count()).toBe(0);
      expect(await outboxIds()).toEqual([]);
    });

    it('strips fields that are not part of the event contract before they reach the outbox (PII guard)', async () => {
      const { refs } = await seedLeaseDeps();
      const l = makeLease(refs);
      const polluted = { ...leaseDecided(l), buyerPhone: '99112233', registerNo: 'УЕ12345678' } as unknown as DomainEvent;
      await leases().insertLease(l, makeTimeline(l.id), [polluted]);
      const [row] = await prisma.outbox.findMany({ where: ownOutbox });
      expect(JSON.stringify(row!.payload)).not.toContain('99112233');
      expect(JSON.stringify(row!.payload)).not.toContain('УЕ12345678');
      expect(row!.id).toBe(polluted.eventId);
      expect(row!.type).toBe('PosLeaseDecided');
    });
  });

  describe('schema', () => {
    it('stores denormalised money columns from the quote and keeps quote_json as the snapshot', async () => {
      await reset();
      const merchant = await merchants().createMerchant(makeMerchant(), []);
      const store = await merchants().createStore(makeStore(merchant.id));
      const plan = await plans().createPlan(makePlan());
      const refs = { merchantId: merchant.id, storeId: store.id, planId: plan.id, branchId: merchant.branchId, planCode: plan.code };
      const quote = makeQuote({ downPayment: 400_000.25, financedAmount: 2_100_000.5, feeAmount: 21_000.01, principal: 2_121_000.51, termMonths: 9, annualRate: 0.2599, monthlyPayment: 270_000.99, merchantCommissionAmount: 63_000.02, merchantNetAmount: 2_037_000.48, effectiveAnnualRate: 0.3501 });
      const l = makeLease(refs, { quote, goodsPrice: 2_500_000.75 });
      await leases().insertLease(l, makeTimeline(l.id), []);

      type Row = Record<string, string | number | null>;
      const read = async () => (await prisma.$queryRaw<Row[]>`SELECT down_payment::text, financed_amount::text, fee_amount::text, principal::text, term_months, annual_rate::text, monthly_payment::text, merchant_commission_amount::text, merchant_net_amount::text, goods_price::text, quote_json FROM origination.pos_lease WHERE id = ${l.id}::uuid`)[0]!;
      expect(await read()).toMatchObject({
        down_payment: '400000.25', financed_amount: '2100000.50', fee_amount: '21000.01', principal: '2121000.51', term_months: 9, annual_rate: '0.2599', monthly_payment: '270000.99',
        merchant_commission_amount: '63000.02', merchant_net_amount: '2037000.48', goods_price: '2500000.75', quote_json: quote,
      });

      const requoted = makeQuote({ downPayment: 1, financedAmount: 2, feeAmount: 3, principal: 4, termMonths: 5, annualRate: 0.06, monthlyPayment: 7, merchantCommissionAmount: 8, merchantNetAmount: 9 });
      await leases().saveLease({ ...l, quote: requoted }, makeTimeline(l.id, { action: 'REQUOTED' }), []);
      expect(await read()).toMatchObject({ down_payment: '1.00', financed_amount: '2.00', fee_amount: '3.00', principal: '4.00', term_months: 5, annual_rate: '0.0600', monthly_payment: '7.00', merchant_commission_amount: '8.00', merchant_net_amount: '9.00', quote_json: requoted });
    });

    it('splits the timeline actor into actor_id and actor_label', async () => {
      await reset();
      const merchant = await merchants().createMerchant(makeMerchant(), []);
      const store = await merchants().createStore(makeStore(merchant.id));
      const plan = await plans().createPlan(makePlan());
      const l = makeLease({ merchantId: merchant.id, storeId: store.id, planId: plan.id }, { version: 1 });
      await leases().insertLease(l, makeTimeline(l.id, { at: at(1), action: 'A', actor: 'MERCHANT:user-7' }), []);
      let cur = l;
      for (const [i, actor] of ['SYSTEM', 'BUYER', 'LENDER:u-9'].entries()) cur = await leases().saveLease({ ...cur }, makeTimeline(l.id, { at: at(2 + i), action: `B${i}`, actor }), []);
      const rows = await prisma.posLeaseEvent.findMany({ orderBy: { at: 'asc' }, select: { actorId: true, actorLabel: true, orgId: true, leaseId: true } });
      expect(rows).toEqual([
        { actorId: 'user-7', actorLabel: 'MERCHANT:user-7', orgId: ORG, leaseId: l.id },
        { actorId: null, actorLabel: 'SYSTEM', orgId: ORG, leaseId: l.id },
        { actorId: null, actorLabel: 'BUYER', orgId: ORG, leaseId: l.id },
        { actorId: 'u-9', actorLabel: 'LENDER:u-9', orgId: ORG, leaseId: l.id },
      ]);
    });

    it('declares the docs/05 §7 indexes and unique constraints', async () => {
      const defs = (await prisma.$queryRaw<Array<{ indexdef: string }>>`SELECT indexdef FROM pg_indexes WHERE schemaname = 'origination'`).map((r) => r.indexdef.replace(/\s+/g, ' '));
      const expected = [
        'UNIQUE INDEX merchant_org_id_code_key ON origination.merchant USING btree (org_id, code)',
        'UNIQUE INDEX merchant_store_merchant_id_code_key ON origination.merchant_store USING btree (merchant_id, code)',
        'UNIQUE INDEX pos_lease_plan_org_id_code_key ON origination.pos_lease_plan USING btree (org_id, code)',
        'UNIQUE INDEX pos_lease_lease_no_key ON origination.pos_lease USING btree (lease_no)',
        'UNIQUE INDEX pos_lease_merchant_id_idempotency_key_key ON origination.pos_lease USING btree (merchant_id, idempotency_key)',
        'INDEX pos_lease_merchant_id_status_idx ON origination.pos_lease USING btree (merchant_id, status)',
        'INDEX pos_lease_merchant_id_created_at_idx ON origination.pos_lease USING btree (merchant_id, created_at)',
        'INDEX pos_lease_store_id_created_at_idx ON origination.pos_lease USING btree (store_id, created_at)',
        'INDEX pos_lease_branch_id_idx ON origination.pos_lease USING btree (branch_id)',
        'INDEX pos_lease_buyer_register_hash_idx ON origination.pos_lease USING btree (buyer_register_hash)',
        'INDEX pos_lease_status_expires_at_idx ON origination.pos_lease USING btree (status, expires_at)',
        'INDEX pos_lease_otp_lease_id_purpose_sent_at_idx ON origination.pos_lease_otp USING btree (lease_id, purpose, sent_at)',
        'INDEX pos_lease_event_lease_id_at_idx ON origination.pos_lease_event USING btree (lease_id, at)',
      ];
      for (const e of expected) expect(defs.some((d) => d.endsWith(e) || d.includes(e)), e).toBe(true);
    });

    it('has no foreign keys leaving the origination schema', async () => {
      const rows = await prisma.$queryRaw<Array<{ conname: string }>>`
        SELECT c.conname FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace tn ON tn.oid = t.relnamespace
        JOIN pg_class r ON r.oid = c.confrelid JOIN pg_namespace rn ON rn.oid = r.relnamespace
        WHERE c.contype = 'f' AND tn.nspname = 'origination' AND rn.nspname <> 'origination'`;
      expect(rows).toEqual([]);
    });
  });

  describe('nest wiring against a live database', () => {
    it('resolves working repositories from prismaPersistenceProviders (connects on init, disconnects on close)', async () => {
      vi.stubEnv('PII_HASH_KEY', 'integration-test-hmac-key');
      await reset();
      const moduleRef = await Test.createTestingModule({ imports: [PrismaModule], providers: prismaPersistenceProviders }).compile();
      await moduleRef.init();
      try {
        const repo = moduleRef.get(MerchantRepository);
        const m = makeMerchant();
        const ev = merchantStatusChanged(m.id);
        await repo.createMerchant(m, [ev]);
        expect(await repo.findMerchant(ORG, m.id)).toEqual(m);
        expect(await readOutbox()).toEqual([ev]);
      } finally {
        await moduleRef.close();
        vi.unstubAllEnvs();
      }
    });
  });

  describe('search on a UTF-8 database', () => {
    it('matches Cyrillic names regardless of letter case', async (ctx) => {
      const [{ server_encoding }] = await prisma.$queryRaw<Array<{ server_encoding: string }>>`SELECT current_setting('server_encoding') AS server_encoding`;
      if (server_encoding !== 'UTF8') return ctx.skip(); // SQL_ASCII/C өгөгдлийн сан Кирилл том жижиг үсгийг ялгахгүй (үйлдвэрлэлийн DB UTF8)
      await reset();
      const m = await merchants().createMerchant(makeMerchant({ name: 'Номин Электроникс', legalName: 'НОМИН ХОЛДИНГ ХХК' }), []);
      const r1 = await merchants().listMerchants(ORG, { q: 'номин' }, { page: 1, pageSize: 10 });
      const r2 = await merchants().listMerchants(ORG, { q: 'ЭЛЕКТРОНИКС' }, { page: 1, pageSize: 10 });
      expect(r1.items.map((x) => x.id)).toEqual([m.id]);
      expect(r2.items.map((x) => x.id)).toEqual([m.id]);
    });
  });

  describe('listing under concurrency of identifiers', () => {
    it('handles many parallel inserts with distinct keys', async () => {
      await reset();
      const merchant = await merchants().createMerchant(makeMerchant(), []);
      const store = await merchants().createStore(makeStore(merchant.id));
      const plan = await plans().createPlan(makePlan());
      const refs = { merchantId: merchant.id, storeId: store.id, planId: plan.id };
      const ls = Array.from({ length: 12 }, (_, i) => makeLease(refs, { createdAt: at(i), idempotencyKey: `par-${i}-${randomUUID()}` }));
      await Promise.all(ls.map((l) => leases().insertLease(l, makeTimeline(l.id, { at: l.createdAt }), [leaseDecided(l)])));
      const r = await leases().listLeases({ orgId: ORG }, {}, { page: 1, pageSize: 50 });
      expect(r.total).toBe(12);
      expect(r.items.map((l) => l.id)).toEqual([...ls].reverse().map((l) => l.id));
      expect((await readOutbox()).length).toBe(12);
    });
  });
});
