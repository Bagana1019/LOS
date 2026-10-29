import { PosLeaseView } from '@los/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PricingProvider } from '../ports';
import { parseWith } from '../testing/expect-schema';
import { buyerPhone, buyerRegister, leaseBody, type Fixtures } from '../testing/fixtures';
import { FIXED_OTP, PosFlow } from '../testing/flow';
import type { HeaderMap } from '../testing/personas';
import { TestApp } from '../testing/test-app';

const NOPE = '00000000-0000-4000-8000-0000000fffff';

describe('tenant isolation (docs/05 §13)', () => {
  let t: TestApp;
  let fx: Fixtures;
  let f: PosFlow;
  let leaseA1: PosLeaseView; // мерчант A, дэлгүүр 1, DRAFT
  let referredA1: PosLeaseView; // REFERRED (салбар BR-X)
  beforeAll(async () => {
    t = await TestApp.create();
    fx = await t.fixtures();
    f = new PosFlow(t, fx);
    leaseA1 = await f.createOk({ seed: 1 });
    referredA1 = await f.toDecided({ digit: 2, seed: 2 });
  });
  afterAll(async () => { await t.close(); });

  const bm = (branchId: string) => f.p.branchManager(branchId);

  it("merchant B cannot read or act on merchant A's lease (404, existence is not disclosed)", async () => {
    const b = f.adminB();
    expect((await t.getJson(`/merchant-portal/leases/${leaseA1.id}`, b)).status).toBe(404);
    const actions: Array<[string, object | undefined]> = [
      ['submit', { otp: FIXED_OTP }], ['otp/consent', undefined], ['otp/accept', undefined], ['accept', { otp: FIXED_OTP }], ['deliver', {}], ['cancel', { reason: 'Тест цуцлалт' }],
    ];
    for (const [action, body] of actions) {
      const res = await t.postJson(`/merchant-portal/leases/${leaseA1.id}/${action}`, b, body);
      expect(res.status, action).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    }
    expect(parseWith(PosLeaseView, (await f.get(leaseA1.id)).body).status).toBe('DRAFT'); // ямар ч өөрчлөлтгүй
    const list = await t.getJson('/merchant-portal/leases', b);
    expect(list.body.items.some((i: { id: string }) => i.id === leaseA1.id)).toBe(false);
    expect((await t.getJson('/merchant-portal/leases?q=' + leaseA1.leaseNo, b)).body.total).toBe(0);
    expect((await t.getJson(`/merchant-portal/leases?q=${encodeURIComponent(buyerRegister(0, 1))}`, b)).body.total).toBe(0); // регистрээр хайлт ч хүрээнээс гарахгүй
  });

  it("merchant B cannot use or see merchant A's store", async () => {
    const res = await t.postJson('/merchant-portal/leases', f.adminB(), leaseBody(fx.storeA1.id, 0, {}, 3), { 'idempotency-key': 'idem-cross-store1' });
    expect(res.status).toBe(404);
    expect((await t.getJson(`/merchant-portal/dashboard?storeId=${fx.storeA1.id}`, f.adminB())).status).toBe(404);
    const me = await t.getJson('/merchant-portal/me', f.adminB());
    expect(me.body.stores.map((s: { id: string }) => s.id)).toEqual([fx.storeB1.id]);
    expect((await t.getJson('/merchant-portal/dashboard', f.adminB())).body.totals.requests).toBe(0);
  });

  it('a STAFF header with the wrong merchant for the store still cannot reach the lease (service re-checks scope)', async () => {
    const forged = t.personas(fx.merchantB.id).staff(fx.storeA1.id, 'forged');
    expect((await t.getJson(`/merchant-portal/leases/${leaseA1.id}`, forged)).status).toBe(404);
  });

  it('a cashier of store 2 cannot see or act on a store 1 lease (404)', async () => {
    const s2 = f.staff2();
    expect((await t.getJson(`/merchant-portal/leases/${leaseA1.id}`, s2)).status).toBe(404);
    for (const action of ['submit', 'cancel', 'accept', 'deliver', 'otp/consent', 'otp/accept']) {
      const res = await t.postJson(`/merchant-portal/leases/${leaseA1.id}/${action}`, s2, action === 'cancel' ? { reason: 'Тест цуцлалт' } : { otp: FIXED_OTP });
      expect(res.status, action).toBe(404);
    }
    const list = await t.getJson(`/merchant-portal/leases?storeId=${fx.storeA1.id}`, s2); // шүүлт албадан өөрийн дэлгүүр
    expect(list.status).toBe(200);
    expect(list.body.items.every((i: { storeId: string }) => i.storeId === fx.storeA2.id)).toBe(true);
    expect(list.body.total).toBe(0);
    expect((await t.getJson('/merchant-portal/leases', s2)).body.total).toBe(0);
    expect((await t.getJson(`/merchant-portal/dashboard?storeId=${fx.storeA1.id}`, s2)).body.totals.requests).toBe(0);
    // харин мерчантын админ хоёуланг нь харна
    expect((await t.getJson(`/merchant-portal/leases/${leaseA1.id}`, f.admin())).status).toBe(200);
    expect((await t.getJson(`/merchant-portal/leases/${leaseA1.id}`, f.staff1())).status).toBe(200);
  });

  it('a cashier cannot create a lease for another store (STORE_SCOPE_VIOLATION); the admin must pick a store when there are several', async () => {
    const res = await t.postJson('/merchant-portal/leases', f.staff2(), leaseBody(fx.storeA1.id, 0, {}, 4), { 'idempotency-key': 'idem-scope-0001' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('STORE_SCOPE_VIOLATION');
    const noStore = await t.postJson('/merchant-portal/leases', f.admin(), leaseBody(undefined, 0, {}, 5), { 'idempotency-key': 'idem-scope-0002' });
    expect(noStore.status).toBe(400);
    expect(noStore.body).toMatchObject({ code: 'VALIDATION_FAILED', message: 'storeId required' });
    // нэг л идэвхтэй дэлгүүртэй мерчант (B) — автоматаар сонгогдоно
    const single = await t.postJson('/merchant-portal/leases', f.adminB(), leaseBody(undefined, 0, {}, 6), { 'idempotency-key': 'idem-scope-0003' });
    expect(single.status).toBe(201);
    expect(single.body.lease.storeId).toBe(fx.storeB1.id);
    // cashier-ийн storeId-г албадан толгойгоос авна
    const implicit = await t.postJson('/merchant-portal/leases', f.staff2(), leaseBody(undefined, 0, {}, 7), { 'idempotency-key': 'idem-scope-0004' });
    expect(implicit.body.lease.storeId).toBe(fx.storeA2.id);
  });

  it('BRANCH_MANAGER of another branch sees no merchant or lease of branch X (404)', async () => {
    const y = bm('BR-Y');
    expect((await t.getJson(`/merchants/${fx.merchantA.id}`, y)).status).toBe(404);
    expect((await t.getJson(`/merchants/${fx.merchantA.id}/stores`, y)).status).toBe(404);
    const merchants = await t.getJson('/merchants', y);
    expect(merchants.body.items.map((m: { code: string }) => m.code)).toEqual(['ALTAN-GER']);
    expect(merchants.body.total).toBe(1);
    expect((await t.getJson(`/pos-leases/${leaseA1.id}`, y)).status).toBe(404);
    expect((await t.getJson(`/pos-leases/${referredA1.id}`, y)).status).toBe(404);
    const leases = await t.getJson('/pos-leases', y);
    expect(leases.body.items.every((i: { storeId: string }) => i.storeId === fx.storeB1.id)).toBe(true);
    expect((await f.review(referredA1.id, 'APPROVE', 'Салбарын захирал батлав', y)).status).toBe(404);
    expect((await t.getJson(`/pos-leases?merchantId=${fx.merchantA.id}`, y)).body.total).toBe(0);
    // өөр салбарын мерчантын хөтөлбөр харагдахгүй, нийтийнх харагдана
    const plans = (await t.getJson('/pos-plans', y)).body as Array<{ merchantId: string | null }>;
    expect(plans.every((p) => p.merchantId === null || p.merchantId === fx.merchantB.id)).toBe(true);
    expect((await t.getJson(`/pos-plans?merchantId=${fx.merchantA.id}`, y)).status).toBe(404);
  });

  it('BRANCH_MANAGER of branch X sees and reviews its own merchant and leases', async () => {
    const x = bm('BR-X');
    expect((await t.getJson(`/merchants/${fx.merchantA.id}`, x)).status).toBe(200);
    expect((await t.getJson('/merchants', x)).body.items.map((m: { code: string }) => m.code)).toEqual(['TEMUULEL']);
    expect((await t.getJson(`/pos-leases/${referredA1.id}`, x)).status).toBe(200);
    const list = await t.getJson('/pos-leases', x);
    expect(list.body.items.some((i: { id: string }) => i.id === referredA1.id)).toBe(true);
    expect((await t.getJson('/pos-leases?merchantId=' + fx.merchantB.id, x)).body.total).toBe(0);
    const review = await f.review(referredA1.id, 'APPROVE', 'Салбарын захирал батлав', x);
    expect(review.status).toBe(200);
    expect(review.body.status).toBe('APPROVED');
    expect(review.body.timeline.at(-1).actor).toBe('LENDER:branch-manager-1');
  });

  it('a BRANCH_MANAGER without a branch header is rejected; ADMIN/APPROVER are not restricted', async () => {
    const headless: HeaderMap = { ...bm('BR-X') };
    delete headless['x-branch-id'];
    expect((await t.getJson('/merchants', headless)).status).toBe(403);
    expect((await t.getJson('/pos-leases', headless)).status).toBe(403);
    expect((await t.getJson('/merchants', f.lender())).body.total).toBe(2);
    expect((await t.getJson('/merchants', f.approver())).body.total).toBe(2);
  });

  it('another organisation sees nothing (org is part of every lookup)', async () => {
    const other = { ...f.lender(), 'x-org-id': 'other-org' };
    expect((await t.getJson('/merchants', other)).body.total).toBe(0);
    expect((await t.getJson(`/merchants/${fx.merchantA.id}`, other)).status).toBe(404);
    expect((await t.getJson(`/pos-leases/${leaseA1.id}`, other)).status).toBe(404);
    const merchantInOtherOrg = { ...f.admin(), 'x-org-id': 'other-org' };
    expect((await t.getJson('/merchant-portal/me', merchantInOtherOrg)).status).toBe(404);
    expect((await t.getJson(`/merchant-portal/leases/${leaseA1.id}`, merchantInOtherOrg)).status).toBe(404);
    expect((await t.patchJson(`/merchants/${fx.merchantA.id}`, other, { name: 'Халдлага' })).status).toBe(404);
    expect((await t.postJson(`/merchants/${fx.merchantA.id}/status`, other, { status: 'SUSPENDED', reason: 'Халдлага' })).status).toBe(404);
  });

  it("a merchant cannot change its own limits, plans or status (no such route)", async () => {
    for (const [method, path] of [['patch', `/merchants/${fx.merchantA.id}`], ['post', `/merchants/${fx.merchantA.id}/status`], ['post', '/pos-plans'], ['patch', `/pos-plans/${fx.laptop.id}`]] as const) {
      for (const h of [f.admin(), f.staff1()]) expect((await t.http(method, path, h, { name: 'xx', status: 'ACTIVE', reason: 'abc' })).status, `${method} ${path}`).toBe(403);
    }
  });
});

describe('role matrix and authentication', () => {
  let t: TestApp;
  let fx: Fixtures;
  let f: PosFlow;
  let victim: string; // шалгалтын мерчант (төлөв өөрчлөгдөж болно)
  beforeAll(async () => {
    t = await TestApp.create();
    fx = await t.fixtures();
    f = new PosFlow(t, fx);
    const m = await t.postJson('/merchants', f.lender(), { code: 'VICTIM', name: 'Туршилтын мерчант', contactName: 'Т. Тест', phone: '99001122', branchId: 'BR-X', commissionRate: 0.02, maxTicketAmount: 1_000_000, settlement: { bankCode: 'KHAN', accountNo: '5011223344', holderName: 'Тест' } });
    victim = m.body.id;
  });
  afterAll(async () => { await t.close(); });

  type Kind = 'MERCHANT' | 'READ' | 'ADMIN';
  interface Route { method: 'get' | 'post' | 'patch'; path: string; body?: object; kind: Kind }
  const routes = (): Route[] => [
    { method: 'get', path: '/merchant-portal/me', kind: 'MERCHANT' },
    { method: 'get', path: '/merchant-portal/dashboard', kind: 'MERCHANT' },
    { method: 'post', path: '/merchant-portal/quotes', body: { planCode: 'LAPTOP', goodsPrice: 3_000_000, downPayment: 600_000, termMonths: 12 }, kind: 'MERCHANT' },
    { method: 'post', path: '/merchant-portal/leases', body: leaseBody(undefined, 0, {}, 800), kind: 'MERCHANT' },
    { method: 'get', path: '/merchant-portal/leases', kind: 'MERCHANT' },
    { method: 'get', path: `/merchant-portal/leases/${NOPE}`, kind: 'MERCHANT' },
    { method: 'post', path: `/merchant-portal/leases/${NOPE}/otp/consent`, kind: 'MERCHANT' },
    { method: 'post', path: `/merchant-portal/leases/${NOPE}/submit`, body: { otp: FIXED_OTP }, kind: 'MERCHANT' },
    { method: 'post', path: `/merchant-portal/leases/${NOPE}/otp/accept`, kind: 'MERCHANT' },
    { method: 'post', path: `/merchant-portal/leases/${NOPE}/accept`, body: { otp: FIXED_OTP }, kind: 'MERCHANT' },
    { method: 'post', path: `/merchant-portal/leases/${NOPE}/deliver`, body: {}, kind: 'MERCHANT' },
    { method: 'post', path: `/merchant-portal/leases/${NOPE}/cancel`, body: { reason: 'Тест цуцлалт' }, kind: 'MERCHANT' },
    { method: 'post', path: '/merchants', body: { code: 'MATRIX', name: 'Матриц', contactName: 'Т. Тест', phone: '99001122', branchId: 'BR-X', commissionRate: 0.02, maxTicketAmount: 1_000_000, settlement: { bankCode: 'KHAN', accountNo: '5011223399', holderName: 'Тест' } }, kind: 'ADMIN' },
    { method: 'get', path: '/merchants', kind: 'READ' },
    { method: 'get', path: `/merchants/${victim}`, kind: 'READ' },
    { method: 'patch', path: `/merchants/${victim}`, body: { name: 'Шинэ нэр' }, kind: 'ADMIN' },
    { method: 'post', path: `/merchants/${victim}/status`, body: { status: 'ACTIVE', reason: 'Матриц тест' }, kind: 'ADMIN' },
    { method: 'post', path: `/merchants/${victim}/stores`, body: { code: 'MATRIX-S', name: 'Матриц дэлгүүр', address: { detail: 'Хаяг 1' } }, kind: 'ADMIN' },
    { method: 'get', path: `/merchants/${victim}/stores`, kind: 'READ' },
    { method: 'patch', path: `/merchants/${victim}/stores/${NOPE}`, body: { name: 'Шинэ нэр' }, kind: 'ADMIN' },
    { method: 'post', path: '/pos-plans', body: { code: 'MATRIX-P', name: 'Матриц', goodsCategories: ['COMPUTER'], minAmount: 100_000, maxAmount: 1_000_000, termOptions: [6], annualRate: 0.2 }, kind: 'ADMIN' },
    { method: 'get', path: '/pos-plans', kind: 'READ' },
    { method: 'patch', path: `/pos-plans/${NOPE}`, body: { name: 'Шинэ нэр' }, kind: 'ADMIN' },
    { method: 'get', path: '/pos-leases', kind: 'READ' },
    { method: 'get', path: `/pos-leases/${NOPE}`, kind: 'READ' },
    { method: 'post', path: `/pos-leases/${NOPE}/review`, body: { decision: 'APPROVE', comment: 'Тест тайлбар' }, kind: 'READ' },
    { method: 'post', path: `/pos-leases/${NOPE}/settle`, body: { settlementRef: 'PAY-0001' }, kind: 'ADMIN' },
  ];

  const personaSets: Array<{ name: string; headers: () => HeaderMap; allowed: Kind[] }> = [
    { name: 'MERCHANT_STAFF', headers: () => f.staff1(), allowed: ['MERCHANT'] },
    { name: 'MERCHANT_ADMIN', headers: () => f.admin(), allowed: ['MERCHANT'] },
    { name: 'ADMIN', headers: () => f.lender(), allowed: ['READ', 'ADMIN'] },
    { name: 'APPROVER', headers: () => f.approver(), allowed: ['READ'] },
    { name: 'BRANCH_MANAGER', headers: () => f.p.branchManager('BR-X'), allowed: ['READ'] },
    { name: 'OFFICER (unlisted lender role)', headers: () => ({ ...f.lender(), 'x-roles': 'OFFICER' }), allowed: [] },
    { name: 'no roles', headers: () => ({ ...f.lender(), 'x-roles': '' }), allowed: [] },
    { name: 'merchant + lender mixed', headers: () => ({ ...f.staff1(), 'x-roles': 'MERCHANT_STAFF,ADMIN' }), allowed: [] },
  ];

  for (const persona of personaSets) {
    it(`${persona.name}: allowed ${persona.allowed.join('/') || 'nothing'}, 403 elsewhere`, async () => {
      let n = 0;
      for (const r of routes()) {
        const extra: HeaderMap = r.path === '/merchant-portal/leases' && r.method === 'post' ? { 'idempotency-key': `idem-matrix-${persona.name.replace(/\W/g, '')}-${n++}`.slice(0, 60) } : {};
        const res = await t.http(r.method, r.path, persona.headers(), r.body, extra);
        const label = `${persona.name} ${r.method.toUpperCase()} ${r.path}`;
        if (persona.allowed.includes(r.kind)) expect([401, 403], `${label} -> ${res.status} ${JSON.stringify(res.body)}`).not.toContain(res.status);
        else {
          expect(res.status, label).toBe(403);
          expect(res.body.code).toBe('FORBIDDEN');
        }
      }
    });
  }

  it('401 UNAUTHENTICATED without x-user-id or x-org-id on every route', async () => {
    for (const drop of ['x-user-id', 'x-org-id']) {
      for (const r of routes()) {
        const headers: HeaderMap = { ...f.lender() };
        delete headers[drop];
        const res = await t.http(r.method, r.path, headers, r.body);
        expect(res.status, `${drop} ${r.method} ${r.path}`).toBe(401);
        expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED' });
        expect(res.headers['x-correlation-id']).toBeTruthy();
      }
    }
    expect((await t.getJson('/merchant-portal/me', {})).status).toBe(401);
    expect((await t.getJson('/merchants', { 'x-user-id': '  ', 'x-org-id': 'org-test', 'x-roles': 'ADMIN' })).status).toBe(401);
  });

  it('merchant principals need x-merchant-id (and x-store-id for cashiers)', async () => {
    const noMerchant = { ...f.admin() };
    delete noMerchant['x-merchant-id'];
    let n = 0;
    for (const r of routes().filter((x) => x.kind === 'MERCHANT')) {
      const extra: HeaderMap = r.path === '/merchant-portal/leases' && r.method === 'post' ? { 'idempotency-key': `idem-nomerchant-${n++}-0001` } : {};
      expect((await t.http(r.method, r.path, noMerchant, r.body, extra)).status, r.path).toBe(403);
    }
    const noStore = { ...f.staff1() };
    delete noStore['x-store-id'];
    const res = await t.getJson('/merchant-portal/leases', noStore);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect((await t.getJson('/merchant-portal/me', { ...f.admin(), 'x-merchant-id': NOPE })).status).toBe(404); // мерчант олдохгүй
  });

  it('the correlation id is echoed, validated and generated', async () => {
    const echoed = await t.getJson('/merchant-portal/me', { ...f.staff1(), 'x-correlation-id': 'trace-abc_123.4' });
    expect(echoed.headers['x-correlation-id']).toBe('trace-abc_123.4');
    const bad = await t.getJson('/merchant-portal/me', { ...f.staff1(), 'x-correlation-id': 'bad id with spaces' });
    expect(bad.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
    const generated = await t.getJson('/merchant-portal/me', f.staff1());
    expect(generated.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
    const events = await (async () => {
      const lease = await f.createOk({ seed: 810 });
      await t.postJson(`/merchant-portal/leases/${lease.id}/submit`, { ...f.staff1(), 'x-correlation-id': 'corr-for-event' }, { otp: FIXED_OTP });
      return t.outbox.events.filter((e) => (e as { leaseId?: string }).leaseId === lease.id);
    })();
    expect(events[0]).toMatchObject({ type: 'PosLeaseDecided', correlationId: 'corr-for-event' });
    expect(t.screening.calls.length).toBeGreaterThan(0);
  });
});

describe('validation errors are 400 VALIDATION_FAILED with issues', () => {
  let t: TestApp;
  let fx: Fixtures;
  let f: PosFlow;
  beforeAll(async () => {
    t = await TestApp.create();
    fx = await t.fixtures();
    f = new PosFlow(t, fx);
  });
  afterAll(async () => { await t.close(); });

  const issues = (res: { body: { details?: { issues?: Array<{ path: string; message: string }> } } }) => res.body.details?.issues ?? [];

  it('lease creation: bad register and phone, with static messages that do not echo the input', async () => {
    const body = leaseBody(fx.storeA1.id, 0, { buyer: { registerNo: 'XX1234', phone: '12345678' } });
    const res = await t.postJson('/merchant-portal/leases', f.staff1(), body, { 'idempotency-key': 'idem-validation-1' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED', message: 'Validation failed' });
    expect(issues(res).map((i) => i.path).sort()).toEqual(['buyer.phone', 'buyer.registerNo']);
    expect(res.text).not.toContain('XX1234');
    expect(res.text).not.toContain('12345678');
  });
  it.each([
    ['empty body', {}, ['planCode', 'goods', 'downPayment', 'termMonths', 'buyer']],
    ['negative price', { goods: { category: 'COMPUTER', name: 'Бараа', price: -5 } }, ['goods.price']],
    ['price with sub-tögrög precision', { goods: { category: 'COMPUTER', name: 'Бараа', price: 1000.123 } }, ['goods.price']],
    ['unknown category', { goods: { category: 'WEAPONS', name: 'Бараа', price: 1000 } }, ['goods.category']],
    ['term out of range', { termMonths: 0 }, ['termMonths']],
    ['term not an integer', { termMonths: 6.5 }, ['termMonths']],
    ['bad plan code', { planCode: 'bad code!' }, ['planCode']],
    ['bad store id', { storeId: 'not-a-uuid' }, ['storeId']],
  ])('lease creation: %s', async (_name, over, paths) => {
    const base = leaseBody(fx.storeA1.id, 0, {}, 820);
    const body = Object.keys(over).length === 0 ? {} : { ...base, ...over };
    const res = await t.postJson('/merchant-portal/leases', f.staff1(), body, { 'idempotency-key': 'idem-validation-2' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(issues(res).map((i) => i.path)).toEqual(expect.arrayContaining(paths));
  });
  it('non-object bodies are rejected', async () => {
    const { default: request } = await import('supertest');
    for (const raw of ['[]', '"text"', '42', 'null', '[{"planCode":"LAPTOP"}]']) {
      const res = await request(t.app.getHttpServer()).post('/api/merchant-portal/quotes').set({ ...f.staff1(), 'content-type': 'application/json' }).send(raw);
      expect(res.status, raw).toBe(400);
    }
  });
  it('malformed JSON is a 400 (body parser)', async () => {
    const { default: request } = await import('supertest');
    const res = await request(t.app.getHttpServer()).post('/api/merchant-portal/quotes').set({ ...f.staff1(), 'content-type': 'application/json' }).send('{"planCode": ');
    expect(res.status).toBe(400);
  });
  it('quote: missing and invalid fields', async () => {
    const res = await t.postJson('/merchant-portal/quotes', f.staff1(), { goodsPrice: 'abc', downPayment: -1, termMonths: 'x' });
    expect(res.status).toBe(400);
    expect(issues(res).map((i) => i.path).sort()).toEqual(['downPayment', 'goodsPrice', 'planCode', 'termMonths']);
  });
  it('query strings: pagination, status, dates and ids', async () => {
    for (const q of ['page=0', 'pageSize=101', 'pageSize=abc', 'status=BOGUS', 'from=yesterday', 'storeId=nope']) {
      const res = await t.getJson(`/merchant-portal/leases?${q}`, f.staff1());
      expect(res.status, q).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    }
    for (const q of ['page=0', 'status=BOGUS', 'merchantId=nope']) expect((await t.getJson(`/pos-leases?${q}`, f.lender())).status, q).toBe(400);
    expect((await t.getJson('/merchants?status=NOPE', f.lender())).status).toBe(400);
    expect((await t.getJson('/merchant-portal/dashboard?from=bad', f.staff1())).status).toBe(400);
    expect((await t.getJson('/merchant-portal/dashboard?storeId=bad', f.staff1())).status).toBe(400);
  });
  it('actions: otp format, cancel reason, review and settle bodies', async () => {
    const lease = await f.createOk({ seed: 821 });
    expect((await t.postJson(`/merchant-portal/leases/${lease.id}/submit`, f.staff1(), { otp: '12345' })).status).toBe(400);
    expect((await t.postJson(`/merchant-portal/leases/${lease.id}/submit`, f.staff1(), { otp: 'abcdef' })).status).toBe(400);
    expect((await t.postJson(`/merchant-portal/leases/${lease.id}/accept`, f.staff1(), {})).status).toBe(400);
    expect((await t.postJson(`/merchant-portal/leases/${lease.id}/cancel`, f.staff1(), { reason: 'ab' })).status).toBe(400);
    expect((await t.postJson(`/merchant-portal/leases/${lease.id}/deliver`, f.staff1(), { serialNo: '' })).status).toBe(400);
    expect((await t.postJson(`/pos-leases/${lease.id}/review`, f.lender(), { decision: 'APPROVE' })).status).toBe(400);
    expect((await t.postJson(`/pos-leases/${lease.id}/settle`, f.lender(), {})).status).toBe(400);
  });
  it('merchant, store and plan bodies', async () => {
    const m = await t.postJson('/merchants', f.lender(), { code: 'x', name: 'a', commissionRate: 0.9, settlement: { bankCode: 'K', accountNo: 'abc', holderName: '' } });
    expect(m.status).toBe(400);
    expect(issues(m).map((i) => i.path)).toEqual(expect.arrayContaining(['code', 'name', 'commissionRate', 'settlement.accountNo', 'branchId', 'maxTicketAmount']));
    expect((await t.postJson(`/merchants/${fx.merchantA.id}/stores`, f.lender(), { code: 'S', name: 'x' })).status).toBe(400);
    expect((await t.postJson('/pos-plans', f.lender(), { code: 'P', name: 'p', goodsCategories: [], minAmount: 1, maxAmount: 2, termOptions: [], annualRate: 2 })).status).toBe(400);
    expect((await t.postJson(`/merchants/${fx.merchantA.id}/status`, f.lender(), { status: 'ACTIVE' })).status).toBe(400);
  });
  it('path ids that are not UUIDs are 404, not 400 or 500', async () => {
    for (const path of ['/merchant-portal/leases/abc', '/pos-leases/abc', '/merchants/abc', '/merchants/abc/stores']) {
      expect((await t.getJson(path, path.startsWith('/merchant-portal') ? f.staff1() : f.lender())).status, path).toBe(404);
    }
  });
});

describe('PII never leaks (POS-BR-7)', () => {
  const REGISTER = buyerRegister(0, 5);
  const PHONE = buyerPhone(5);
  const SECRET_DIGITS = REGISTER.slice(2); // регистрийн цифрүүд

  it('raw register number and full phone never appear in any response, log line or outbox event', async () => {
    const t = await TestApp.create();
    const t500 = await TestApp.create({ overrides: [{ provide: PricingProvider, useValue: { resolve: () => { throw new Error(`pricing exploded for ${REGISTER} / ${PHONE}`); } } }] });
    try {
      const fx = await t.fixtures();
      const f = new PosFlow(t, fx);
      const over = { buyer: { registerNo: REGISTER, phone: PHONE } };
      // 1) бүтэн урсгал: үүсгэх → OTP алдаа → submit → accept → deliver → settle
      const lease = await f.createOk({ seed: 5, over });
      await f.submit(lease.id, '000000');
      await f.submit(lease.id);
      t.clock.advanceSeconds(31);
      await f.acceptOtp(lease.id);
      await f.accept(lease.id);
      await f.deliver(lease.id);
      await f.settle(lease.id);
      // 2) шийдвэрүүд: татгалзсан, REFER+review, цуцлалтын шалтгаанд PII бичсэн
      const declined = await f.toDecided({ digit: 3, seed: 5 + 28, over: { buyer: { registerNo: buyerRegister(3, 5), phone: PHONE } } });
      const referred = await f.createOk({ seed: 6, digit: 2 });
      await f.submit(referred.id);
      await f.review(referred.id, 'APPROVE', `Хянасан ${REGISTER} ${PHONE}`);
      await f.cancel(referred.id, `Худалдан авагч ${REGISTER} утас ${PHONE} татгалзсан`);
      // 3) бүх унших замууд (хайлт, жагсаалт, dashboard, back-office)
      await t.getJson(`/merchant-portal/leases?q=${encodeURIComponent(REGISTER)}`, f.admin());
      await t.getJson(`/merchant-portal/leases?q=${PHONE}`, f.admin());
      await t.getJson('/merchant-portal/leases', f.staff1());
      await t.getJson('/merchant-portal/dashboard', f.admin());
      await t.getJson(`/pos-leases?q=${encodeURIComponent(REGISTER)}`, f.lender());
      await t.getJson(`/pos-leases/${lease.id}`, f.lender());
      await t.getJson(`/pos-leases/${declined.id}`, f.lender());
      await t.getJson('/merchants', f.lender());
      // 4) алдаатай хүсэлтүүд
      await t.postJson('/merchant-portal/leases', f.staff1(), leaseBody(fx.storeA1.id, 0, { buyer: { registerNo: `${REGISTER}9`, phone: PHONE } }), { 'idempotency-key': 'idem-pii-0001' });
      await t.postJson('/merchant-portal/leases', f.staff1(), leaseBody(fx.storeA1.id, 0, { buyer: { registerNo: REGISTER, phone: '1234567' } }), { 'idempotency-key': 'idem-pii-0002' });
      // 5) гэнэтийн (500) алдаа: мессежэд PII агуулсан
      const fx500 = await t500.fixtures();
      const res500 = await t500.postJson('/merchant-portal/quotes', new PosFlow(t500, fx500).staff1(), { planCode: 'LAPTOP', goodsPrice: 3_000_000, downPayment: 600_000, termMonths: 12 }, { 'x-correlation-id': 'corr-500' });
      expect(res500.status).toBe(500);
      expect(res500.body).toEqual({ code: 'INTERNAL', message: 'Internal error' });
      expect(res500.headers['x-correlation-id']).toBe('corr-500');
      expect(t500.logger.text).toContain('corr-500');
      expect(t500.logger.text).toMatch(/unhandled Error/);

      const haystacks: Array<[string, string]> = [
        ['responses', t.bodies.join('\n')],
        ['logs', t.logger.text],
        ['events', JSON.stringify(t.outbox.events)],
        ['500 responses', t500.bodies.join('\n')],
        ['500 logs', t500.logger.text],
        ['500 events', JSON.stringify(t500.outbox.events)],
      ];
      expect(t.bodies.length).toBeGreaterThan(20);
      expect(t.logger.lines.length).toBeGreaterThan(5);
      expect(t.outbox.events.length).toBeGreaterThan(5);
      for (const [name, text] of haystacks) {
        expect(text, `${name} contains the raw register`).not.toContain(REGISTER);
        expect(text, `${name} contains the register digits`).not.toContain(SECRET_DIGITS);
        expect(text, `${name} contains the full phone`).not.toContain(PHONE);
        expect(text, `${name} contains the register of the declined buyer`).not.toContain(buyerRegister(3, 5));
      }
      // харин маскалсан хэлбэр байна
      expect(haystacks[0][1]).toContain(`УЕ******${REGISTER.slice(-2)}`);
      expect(haystacks[0][1]).toContain(`${PHONE.slice(0, 2)}****${PHONE.slice(-2)}`);
      expect(haystacks[4][1]).toContain('УЕ******'); // 500 лог: scrub хийгдсэн
      // цуцлалтын шалтгаан scrub хийгдсэн
      const view = parseWith(PosLeaseView, (await f.get(referred.id, f.admin())).body);
      expect(view.cancelReason).toBe(`Худалдан авагч ${`УЕ******${REGISTER.slice(-2)}`} утас ${`${PHONE.slice(0, 2)}****${PHONE.slice(-2)}`} татгалзсан`);
      // SMS-ийн зорилтот дугаар л бодит (тестийн mock)
      expect(t.sms.sent.every((m) => m.to === PHONE || m.to.startsWith('9911'))).toBe(true);
    } finally {
      await t.close();
      await t500.close();
    }
  });

  it('the stored register is encrypted and only a hash is searchable', async () => {
    const t = await TestApp.create();
    try {
      const fx = await t.fixtures();
      const f = new PosFlow(t, fx);
      const lease = await f.createOk({ seed: 40 });
      const repo = (t.services.leases as unknown as { leases: { findLease(s: object, id: string): Promise<Record<string, unknown> | null> } }).leases;
      const rec = (await repo.findLease({ orgId: 'org-test' }, lease.id))!;
      expect(rec.buyerRegisterEncrypted).not.toContain(buyerRegister(0, 40));
      expect(rec.buyerRegisterHash).toMatch(/^[0-9a-f]{64}$/);
      expect(rec.buyerRegisterMasked).toBe(`УЕ******${buyerRegister(0, 40).slice(-2)}`);
      expect(rec.requestHash).toMatch(/^[0-9a-f]{64}$/);
      expect(String(rec.requestHash)).not.toBe(rec.buyerRegisterHash);
    } finally {
      await t.close();
    }
  });
});
