// End to end: web → gateway (real login, iam DB, JWT, proxy) → origination MerchantModule (real controllers/services, in-memory persistence,
// mock integrations — docs/05-merchant-pos.md §11). No header is hand-crafted: merchant/store scope comes ONLY from iam.user via the gateway.
import { type INestApplication } from '@nestjs/common';
import { SEED } from '@los/database';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/modules/auth/password';
import type { PrismaService } from '../src/prisma.service';
import { HAS_DB, PASSWORD, createGateway } from './app';
// Test-only import of the origination merchant test harness (same monorepo; no production coupling).
import { TestApp } from '../../origination/src/modules/merchant/testing/test-app';
import { leaseBody, seedFixtures, type Fixtures } from '../../origination/src/modules/merchant/testing/fixtures';
import { FIXED_OTP } from '../../origination/src/modules/merchant/testing/flow';

const MP = '/api/origination/merchant-portal';
const USERS = {
  cashierA1: { id: '00000000-0000-4000-8000-00000000a001', username: 'pos.cashier.a1', roles: ['MERCHANT_STAFF'] },
  cashierA2: { id: '00000000-0000-4000-8000-00000000a002', username: 'pos.cashier.a2', roles: ['MERCHANT_STAFF'] },
  ownerA: { id: '00000000-0000-4000-8000-00000000a003', username: 'pos.owner.a', roles: ['MERCHANT_ADMIN'] },
  ownerB: { id: '00000000-0000-4000-8000-00000000b003', username: 'pos.owner.b', roles: ['MERCHANT_ADMIN'] },
  broken: { id: '00000000-0000-4000-8000-00000000c001', username: 'pos.broken', roles: ['MERCHANT_STAFF'] }, // no store_id → no roles
} as const;
type Who = keyof typeof USERS | 'admin' | 'approver' | 'officer.a';

describe.skipIf(!HAS_DB)('Merchant POS end to end through the gateway (docs/05-merchant-pos.md §3, §8, §13)', () => {
  let origination: TestApp;
  let fx: Fixtures;
  let app: INestApplication;
  let prisma: PrismaService;
  const tokens = new Map<Who, string>();
  let seed = 500;
  let key = 0;

  const call = (who: Who, method: 'get' | 'post', path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = request(app.getHttpServer())[method](path).set({ authorization: `Bearer ${tokens.get(who)}`, ...headers });
    return body === undefined ? r : r.send(body as object);
  };
  const create = (who: Who, storeId: string, digit = 0, idem = `pos-e2e-${++key}`, s = ++seed) =>
    call(who, 'post', `${MP}/leases`, leaseBody(storeId, digit, {}, s), { 'idempotency-key': idem });
  const login = async (who: Who, username: string) => {
    const r = await request(app.getHttpServer()).post('/api/auth/login').send({ username, password: PASSWORD });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    tokens.set(who, r.body.accessToken);
    return r.body;
  };

  beforeAll(async () => {
    origination = await TestApp.create();
    fx = await seedFixtures(origination.services, SEED.org.id);
    await origination.app.listen(0, '127.0.0.1');
    process.env.ORIGINATION_URL = `http://127.0.0.1:${(origination.app.getHttpServer().address() as AddressInfo).port}`;
    ({ app, prisma } = await createGateway());

    const passwordHash = await hashPassword(PASSWORD);
    const scope: Record<keyof typeof USERS, { merchantId: string | null; storeId: string | null }> = {
      cashierA1: { merchantId: fx.merchantA.id, storeId: fx.storeA1.id },
      cashierA2: { merchantId: fx.merchantA.id, storeId: fx.storeA2.id },
      ownerA: { merchantId: fx.merchantA.id, storeId: null },
      ownerB: { merchantId: fx.merchantB.id, storeId: null },
      broken: { merchantId: fx.merchantA.id, storeId: null },
    };
    for (const [k, u] of Object.entries(USERS) as [keyof typeof USERS, (typeof USERS)[keyof typeof USERS]][]) {
      const data = { orgId: SEED.org.id, branchId: null, username: u.username, passwordHash, fullName: u.username, roles: [...u.roles], isActive: true, ...scope[k] };
      await prisma.user.upsert({ where: { username: u.username }, create: { id: u.id, ...data }, update: data });
      await login(k, u.username);
    }
    for (const who of ['admin', 'approver', 'officer.a'] as const) await login(who, who);
  });
  afterAll(async () => {
    await app?.close();
    await origination?.close();
  });

  it('login exposes the merchant scope in the session; the misconfigured merchant user gets no roles', async () => {
    const me = await call('cashierA1', 'get', '/api/auth/me');
    expect(me.body.user).toMatchObject({ roles: ['MERCHANT_STAFF'], merchantId: fx.merchantA.id, storeId: fx.storeA1.id });
    expect(me.body.permissions).toEqual([]);
    expect(me.body.menu).toEqual([]);
    const broken = await call('broken', 'get', '/api/auth/me');
    expect(broken.body.user).toMatchObject({ roles: [], merchantId: null, storeId: null });
    expect((await call('broken', 'get', `${MP}/me`)).status).toBe(403);
  });

  it('happy path: quote → create (idempotent) → consent OTP → APPROVE → accept OTP → deliver → back-office settle', async () => {
    const quote = await call('cashierA1', 'post', `${MP}/quotes`, { planCode: 'LAPTOP', goodsPrice: 3_000_000, downPayment: 600_000, termMonths: 12, goodsCategory: 'COMPUTER' });
    expect(quote.status).toBe(200);
    expect(quote.body).toMatchObject({ financedAmount: 2_400_000, merchantNetAmount: 2_328_000 });

    const idem = 'happy-path-key';
    const created = await create('cashierA1', fx.storeA1.id, 0, idem, 900);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id: string = created.body.lease.id;
    expect(created.body.lease).toMatchObject({ status: 'DRAFT', storeId: fx.storeA1.id, allowedActions: expect.arrayContaining(['SUBMIT', 'CANCEL']) });
    expect(JSON.stringify(created.body)).not.toContain(FIXED_OTP); // OTP is never returned
    const replay = await create('cashierA1', fx.storeA1.id, 0, idem, 900);
    expect(replay.status).toBe(200);
    expect(replay.body.lease.id).toBe(id);

    const decided = await call('cashierA1', 'post', `${MP}/leases/${id}/submit`, { otp: FIXED_OTP });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    expect(decided.body).toMatchObject({ status: 'APPROVED', allowedActions: expect.arrayContaining(['REQUEST_ACCEPT_OTP', 'ACCEPT']) });

    origination.clock.advanceSeconds(31); // POS_OTP_RESEND_SECONDS
    expect((await call('cashierA1', 'post', `${MP}/leases/${id}/otp/accept`)).status).toBe(200);
    const accepted = await call('cashierA1', 'post', `${MP}/leases/${id}/accept`, { otp: FIXED_OTP });
    expect(accepted.body).toMatchObject({ status: 'ACCEPTED', allowedActions: expect.arrayContaining(['DELIVER']) });

    const delivered = await call('cashierA1', 'post', `${MP}/leases/${id}/deliver`, {});
    expect(delivered.body).toMatchObject({ status: 'DELIVERED', allowedActions: [] });

    // merchant cannot settle itself; the lender ADMIN does (POS-FR-9)
    expect((await call('cashierA1', 'post', `/api/origination/pos-leases/${id}/settle`, { settlementRef: 'X' })).status).toBe(403);
    const settled = await call('admin', 'post', `/api/origination/pos-leases/${id}/settle`, { settlementRef: 'PAY-E2E-0001' });
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    expect(settled.body).toMatchObject({ status: 'SETTLED', review: { settlementRef: 'PAY-E2E-0001' } });

    // merchant sees the final state; owner sees it across stores
    expect((await call('cashierA1', 'get', `${MP}/leases/${id}`)).body.status).toBe('SETTLED');
    expect((await call('ownerA', 'get', `${MP}/leases/${id}`)).body.status).toBe('SETTLED');

    const events = origination.outbox.events.filter((e) => (e as { leaseId?: string }).leaseId === id).map((e) => e.type);
    expect(events).toEqual(['PosLeaseDecided', 'PosLeaseAccepted', 'PosLeaseDelivered', 'PosLeaseSettled']);
  });

  it('REFER path: blacklisted buyer → REFERRED → APPROVER approves at back-office → buyer accepts', async () => {
    const created = await create('cashierA1', fx.storeA1.id, 2);
    const id: string = created.body.lease.id;
    const referred = await call('cashierA1', 'post', `${MP}/leases/${id}/submit`, { otp: FIXED_OTP });
    expect(referred.body).toMatchObject({ status: 'REFERRED', decision: { result: 'REFER', publicReason: 'MANUAL_REVIEW' } });
    expect(JSON.stringify(referred.body)).not.toMatch(/BLACKLIST/i); // POS-BR-6

    expect((await call('cashierA1', 'post', `/api/origination/pos-leases/${id}/review`, { decision: 'APPROVE', comment: 'self' })).status).toBe(403);
    const reviewed = await call('approver', 'post', `/api/origination/pos-leases/${id}/review`, { decision: 'APPROVE', comment: 'Баримт шалгав' });
    expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
    expect(reviewed.body.status).toBe('APPROVED');

    origination.clock.advanceSeconds(31);
    await call('cashierA1', 'post', `${MP}/leases/${id}/otp/accept`);
    expect((await call('cashierA1', 'post', `${MP}/leases/${id}/accept`, { otp: FIXED_OTP })).body.status).toBe('ACCEPTED');
  });

  describe('tenant isolation (404, existence not disclosed)', () => {
    let leaseA1: string;
    beforeAll(async () => { leaseA1 = (await create('cashierA1', fx.storeA1.id)).body.lease.id; });

    it("another merchant's owner cannot read, act on, or list merchant A's lease", async () => {
      expect((await call('ownerB', 'get', `${MP}/leases/${leaseA1}`)).status).toBe(404);
      expect((await call('ownerB', 'post', `${MP}/leases/${leaseA1}/cancel`, { reason: 'x attempt' })).status).toBe(404);
      const list = await call('ownerB', 'get', `${MP}/leases`);
      expect(list.status).toBe(200);
      expect(list.body.items.map((l: { id: string }) => l.id)).not.toContain(leaseA1);
    });

    it('a cashier of another store of the same merchant gets 404', async () => {
      expect((await call('cashierA2', 'get', `${MP}/leases/${leaseA1}`)).status).toBe(404);
      expect((await call('cashierA2', 'post', `${MP}/leases/${leaseA1}/submit`, { otp: FIXED_OTP })).status).toBe(404);
    });

    it('spoofed X-Merchant-Id / X-Store-Id / X-Roles from the client are stripped by the gateway', async () => {
      const spoof = { 'x-merchant-id': fx.merchantA.id, 'x-store-id': fx.storeA1.id, 'x-roles': 'MERCHANT_ADMIN' };
      expect((await call('ownerB', 'get', `${MP}/leases/${leaseA1}`, undefined, spoof)).status).toBe(404);
      // a lender user cannot become a merchant by sending headers
      expect((await call('officer.a', 'get', `${MP}/leases/${leaseA1}`, undefined, spoof)).status).toBe(403);
    });

    it('merchant principals are confined to the merchant portal: lender APIs and gateway admin/directory are 403', async () => {
      for (const path of ['/api/origination/applications', '/api/origination/pos-leases', '/api/origination/merchants', '/api/kyc/inquiries', '/api/directory', '/api/admin/users']) {
        expect((await call('ownerA', 'get', path)).status, path).toBe(403);
      }
    });
  });

  describe('OTP and idempotency', () => {
    it('consent OTP brute force: 3 wrong codes lock the code; the right code no longer works', async () => {
      const id: string = (await create('cashierA1', fx.storeA1.id)).body.lease.id;
      for (let i = 0; i < 2; i++) expect((await call('cashierA1', 'post', `${MP}/leases/${id}/submit`, { otp: '000000' })).body.code).toBe('OTP_INVALID');
      expect((await call('cashierA1', 'post', `${MP}/leases/${id}/submit`, { otp: '000000' })).body.code).toBe('OTP_ATTEMPTS_EXCEEDED');
      const right = await call('cashierA1', 'post', `${MP}/leases/${id}/submit`, { otp: FIXED_OTP });
      expect(right.status).toBe(429);
      expect((await call('cashierA1', 'get', `${MP}/leases/${id}`)).body.status).toBe('DRAFT');
    });

    it('an expired consent OTP is rejected (POS_OTP_TTL_SECONDS)', async () => {
      const id: string = (await create('cashierA1', fx.storeA1.id)).body.lease.id;
      origination.clock.advanceSeconds(301);
      expect((await call('cashierA1', 'post', `${MP}/leases/${id}/submit`, { otp: FIXED_OTP })).body.code).toBe('OTP_EXPIRED');
    });

    it('same Idempotency-Key with a different body → 409 IDEMPOTENCY_CONFLICT; missing key → 400', async () => {
      const k = 'conflict-key';
      expect((await create('cashierA1', fx.storeA1.id, 0, k, 700)).status).toBe(201);
      const conflict = await create('cashierA1', fx.storeA1.id, 0, k, 701);
      expect(conflict.status).toBe(409);
      expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
      const noKey = await call('cashierA1', 'post', `${MP}/leases`, leaseBody(fx.storeA1.id, 0, {}, 702));
      expect(noKey.status).toBe(400);
    });

    it('deliver before a decision is an invalid transition (409)', async () => {
      const id: string = (await create('cashierA1', fx.storeA1.id)).body.lease.id;
      const res = await call('cashierA1', 'post', `${MP}/leases/${id}/deliver`, {});
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INVALID_TRANSITION');
    });
  });
});
