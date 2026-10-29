import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  makeAdminLease, makeDashboard, makeLease, makeLeaseWithOtp, makeMerchantView, makeOtp, makePlanView, makeProfile, makeQuote, makeStoreView, paged, toListItem,
} from '../../e2e/fixtures';
import {
  ORIGINATION_API as API, acceptLease, ApiError, buildQuery, cancelLease, changeMerchantStatus, createIdempotencyKeeper, createLease, createMerchant, createPlan, createQuote, createStore, deliverLease, getAdminLease,
  getDashboard, getLease, getMerchant, getProfile, isApiError, listAdminLeases, listLeases, listMerchants, listPlans, listStores, newId, request, requestAcceptOtp, resendConsentOtp, reviewLease,
  settleLease, submitLease, toApiError, updateMerchant, updatePlan, updateStore,
} from './merchant-api';
import { z } from 'zod';

const jsonResponse = (status: number, body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Seen { url: string; init: RequestInit & { headers: Record<string, string> } }
let seen: Seen[] = [];
function mockFetch(handler: (url: string, init: Seen['init']) => Response | Promise<Response>) {
  seen = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const rec = { url: String(input), init: init as Seen['init'] };
    seen.push(rec);
    return handler(rec.url, rec.init);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => { seen = []; });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('request(): success path', () => {
  it('calls the gateway with credentials, correlation id and no content-type on GET', async () => {
    const profile = makeProfile({ role: 'MERCHANT_ADMIN' });
    mockFetch(() => jsonResponse(200, profile));
    const res = await getProfile();
    expect(res.merchant.code).toBe('TECHMALL');
    expect(res.role).toBe('MERCHANT_ADMIN');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`${API}/merchant-portal/me`);
    expect(seen[0]!.init.method).toBe('GET');
    expect(seen[0]!.init.credentials).toBe('include');
    expect(seen[0]!.init.body).toBeUndefined();
    expect(seen[0]!.init.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen[0]!.init.headers['content-type']).toBeUndefined();
    expect(seen[0]!.init.headers.accept).toBe('application/json');
  });

  it('sends JSON bodies with content-type and the Idempotency-Key header', async () => {
    const lease = makeLease({ status: 'DRAFT' });
    mockFetch(() => jsonResponse(201, makeLeaseWithOtp(lease)));
    const payload = { planCode: 'LAPTOP', goods: { category: 'COMPUTER' as const, name: 'Lenovo', price: 1_500_000 }, downPayment: 300_000, termMonths: 12, buyer: { registerNo: 'УБ12345678', phone: '99112233' } };
    const res = await createLease(payload, 'idem-key-123');
    expect(res.lease.id).toBe(lease.id);
    expect(res.otp.purpose).toBe('CONSENT');
    expect(seen[0]!.url).toBe(`${API}/merchant-portal/leases`);
    expect(seen[0]!.init.method).toBe('POST');
    expect(seen[0]!.init.headers['idempotency-key']).toBe('idem-key-123');
    expect(seen[0]!.init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(seen[0]!.init.body as string)).toEqual(payload);
  });

  it('every call gets a fresh correlation id', async () => {
    mockFetch(() => jsonResponse(200, makeProfile()));
    await getProfile();
    await getProfile();
    expect(seen[0]!.init.headers['x-correlation-id']).not.toBe(seen[1]!.init.headers['x-correlation-id']);
  });

  it('serialises query params (arrays comma-joined, empties dropped)', async () => {
    mockFetch(() => jsonResponse(200, paged([toListItem(makeLease())])));
    await listLeases({ status: ['APPROVED', 'REFERRED'], q: 'iphone', storeId: undefined, page: 2, pageSize: 20, from: '2026-10-01T00:00:00+08:00' });
    const url = new URL(seen[0]!.url);
    expect(url.pathname.endsWith('/merchant-portal/leases')).toBe(true);
    expect(url.searchParams.get('status')).toBe('APPROVED,REFERRED');
    expect(url.searchParams.get('q')).toBe('iphone');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('from')).toBe('2026-10-01T00:00:00+08:00');
    expect(url.searchParams.has('storeId')).toBe(false);
  });

  it('encodes path ids', async () => {
    mockFetch(() => jsonResponse(404, { code: 'NOT_FOUND', message: 'x' }));
    await expect(getLease('a/b?c')).rejects.toBeInstanceOf(ApiError);
    expect(seen[0]!.url).toBe(`${API}/merchant-portal/leases/a%2Fb%3Fc`);
  });
});

describe('request(): errors', () => {
  it('maps the contract error body to ApiError with details and correlation id', async () => {
    mockFetch(() => jsonResponse(422, { code: 'OTP_INVALID', message: 'Invalid code', details: { attemptsLeft: 2 } }));
    const e = await submitLease('l1', { otp: '123456' }).catch((x: unknown) => x);
    expect(isApiError(e)).toBe(true);
    const err = e as ApiError;
    expect(err.status).toBe(422);
    expect(err.code).toBe('OTP_INVALID');
    expect(err.details).toEqual({ attemptsLeft: 2 });
    expect(err.correlationId).toBe(seen[0]!.init.headers['x-correlation-id']);
  });

  it.each([
    [401, 'UNAUTHENTICATED'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND'], [500, 'INTERNAL'], [502, 'INTERNAL'], [503, 'INTERNAL'], [400, 'UNKNOWN'], [418, 'UNKNOWN'],
  ])('HTTP %i without a contract body -> %s', async (status, code) => {
    mockFetch(() => new Response('<html>gateway error</html>', { status }));
    const err = (await getDashboard({}).catch((x: unknown) => x)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
  });

  it('keeps a 500 with a JSON body that is not the contract as INTERNAL', async () => {
    mockFetch(() => jsonResponse(500, { statusCode: 500, error: 'Internal Server Error' }));
    const err = (await getProfile().catch((x: unknown) => x)) as ApiError;
    expect(err.code).toBe('INTERNAL');
  });

  it('network failure -> NETWORK_ERROR (status 0)', async () => {
    mockFetch(() => { throw new TypeError('Failed to fetch'); });
    const err = (await getProfile().catch((x: unknown) => x)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.status).toBe(0);
  });

  it('abort errors are rethrown untouched (not turned into NETWORK_ERROR)', async () => {
    mockFetch(() => { throw new DOMException('aborted', 'AbortError'); });
    const err = await getProfile().catch((x: unknown) => x);
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('AbortError');
  });

  it('a 200 response that violates the contract -> INVALID_RESPONSE with issue paths only (no values)', async () => {
    const bad = { ...makeProfile(), role: 'SUPER_ADMIN', merchant: { id: 'not-a-uuid', secretRegister: 'УБ12345678' } };
    mockFetch(() => jsonResponse(200, bad));
    const err = (await getProfile().catch((x: unknown) => x)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('INVALID_RESPONSE');
    expect(err.status).toBe(200);
    const issues = (err.details as { issues: Array<{ path: string; message: string }> }).issues;
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.map((i) => i.path)).toContain('role');
    // Хариуны утга (PII байж болзошгүй) алдаанд ОРОХГҮЙ
    expect(JSON.stringify(err.details)).not.toContain('УБ12345678');
  });

  it('an empty or non-JSON 200 body -> INVALID_RESPONSE', async () => {
    mockFetch(() => new Response('', { status: 200 }));
    expect(((await getProfile().catch((x: unknown) => x)) as ApiError).code).toBe('INVALID_RESPONSE');
    mockFetch(() => new Response('<html>', { status: 200 }));
    expect(((await getProfile().catch((x: unknown) => x)) as ApiError).code).toBe('INVALID_RESPONSE');
  });

  it('request() validates with any zod schema and returns parsed (stripped) data', async () => {
    mockFetch(() => jsonResponse(200, { a: 1, extra: 'x' }));
    expect(await request('/x', { schema: z.object({ a: z.number() }) })).toEqual({ a: 1 });
  });
});

describe('toApiError', () => {
  it('uses the contract body when valid', () => {
    const e = toApiError(409, { code: 'DUPLICATE_CODE', message: 'dup' }, 'cid');
    expect(e.code).toBe('DUPLICATE_CODE');
    expect(e.correlationId).toBe('cid');
  });
  it('handles undefined / non-object bodies', () => {
    expect(toApiError(500, undefined).code).toBe('INTERNAL');
    expect(toApiError(422, 'text').code).toBe('UNKNOWN');
    expect(toApiError(422, { code: 'NOT_IN_ENUM', message: 'x' }).code).toBe('UNKNOWN');
  });
});

describe('Idempotency-Key keeper (POS-BR-12)', () => {
  it('same payload -> same key; changed payload -> new key; reset -> new key', () => {
    let n = 0;
    const keeper = createIdempotencyKeeper(() => `key-${++n}`);
    const a = { price: 1, name: 'x' };
    const k1 = keeper.keyFor(a);
    expect(keeper.keyFor({ ...a })).toBe(k1);
    expect(keeper.keyFor({ ...a })).toBe(k1);
    const k2 = keeper.keyFor({ price: 2, name: 'x' });
    expect(k2).not.toBe(k1);
    expect(keeper.keyFor({ price: 2, name: 'x' })).toBe(k2);
    keeper.reset();
    expect(keeper.keyFor({ price: 2, name: 'x' })).not.toBe(k2);
  });
  it('newId returns UUID v4 and has a fallback without crypto.randomUUID', () => {
    expect(newId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    vi.stubGlobal('crypto', undefined);
    expect(newId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => { a.fill(7); return a; } });
    expect(newId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('buildQuery', () => {
  it('returns an empty string for nothing', () => {
    expect(buildQuery()).toBe('');
    expect(buildQuery({ a: undefined, b: null, c: '', d: [] })).toBe('');
  });
  it('encodes values', () => {
    expect(buildQuery({ q: 'а б&c', n: 0, ok: false })).toBe('?q=%D0%B0+%D0%B1%26c&n=0&ok=false');
  });
});

describe('endpoint table: method + path + schema', () => {
  const lease = makeLease({ id: '44444444-4444-4444-8444-444444444441' });
  const admin = makeAdminLease({ id: lease.id });
  const merchant = makeMerchantView();
  const store = makeStoreView();
  const plan = makePlanView();
  const quote = makeQuote({ goodsPrice: 1_500_000, downPayment: 300_000, termMonths: 12 });
  const quoteReq = { planCode: 'LAPTOP', goodsPrice: 1_500_000, downPayment: 300_000, termMonths: 12 };
  const id = lease.id;
  const mid = merchant.id;

  const table: Array<[string, () => Promise<unknown>, string, string, unknown]> = [
    ['getDashboard', () => getDashboard({ from: '2026-10-22T00:00:00+08:00' }), 'GET', '/merchant-portal/dashboard', makeDashboard()],
    ['createQuote', () => createQuote(quoteReq), 'POST', '/merchant-portal/quotes', quote],
    ['listLeases', () => listLeases({}), 'GET', '/merchant-portal/leases', paged([toListItem(lease)])],
    ['getLease', () => getLease(id), 'GET', `/merchant-portal/leases/${id}`, lease],
    ['resendConsentOtp', () => resendConsentOtp(id), 'POST', `/merchant-portal/leases/${id}/otp/consent`, makeOtp('CONSENT')],
    ['submitLease', () => submitLease(id, { otp: '123456' }), 'POST', `/merchant-portal/leases/${id}/submit`, lease],
    ['requestAcceptOtp', () => requestAcceptOtp(id), 'POST', `/merchant-portal/leases/${id}/otp/accept`, makeOtp('ACCEPT')],
    ['acceptLease', () => acceptLease(id, { otp: '123456' }), 'POST', `/merchant-portal/leases/${id}/accept`, lease],
    ['deliverLease', () => deliverLease(id, { serialNo: 'SN1' }), 'POST', `/merchant-portal/leases/${id}/deliver`, lease],
    ['cancelLease', () => cancelLease(id, { reason: 'Татгалзсан' }), 'POST', `/merchant-portal/leases/${id}/cancel`, lease],
    ['listMerchants', () => listMerchants({ status: 'ACTIVE' }), 'GET', '/merchants', paged([merchant])],
    ['createMerchant', () => createMerchant({ code: 'X1', name: 'Нэр', contactName: 'Нэр', phone: '99112233', branchId: 'B1', commissionRate: 0.02, maxTicketAmount: 1_000_000, dailyLimitAmount: null, settlement: { bankCode: 'KHAN', accountNo: '123456', holderName: 'Нэр' } }), 'POST', '/merchants', merchant],
    ['getMerchant', () => getMerchant(mid), 'GET', `/merchants/${mid}`, merchant],
    ['updateMerchant', () => updateMerchant(mid, { name: 'Шинэ' }), 'PATCH', `/merchants/${mid}`, merchant],
    ['changeMerchantStatus', () => changeMerchantStatus(mid, { status: 'SUSPENDED', reason: 'Шалтгаан' }), 'POST', `/merchants/${mid}/status`, merchant],
    ['listStores', () => listStores(mid), 'GET', `/merchants/${mid}/stores`, [store]],
    ['createStore', () => createStore(mid, { code: 'UB-9', name: 'Нэр', address: { detail: 'Хаяг' } }), 'POST', `/merchants/${mid}/stores`, store],
    ['updateStore', () => updateStore(mid, store.id, { name: 'Шинэ' }), 'PATCH', `/merchants/${mid}/stores/${store.id}`, store],
    ['listPlans', () => listPlans({}), 'GET', '/pos-plans', [plan]],
    ['createPlan', () => createPlan({ code: 'P1', merchantId: null, name: 'Нэр', productId: null, goodsCategories: ['OTHER'], minAmount: 1, maxAmount: 2, termOptions: [6], annualRate: 0.2, feeRate: 0, minDownPaymentRate: 0, commissionRate: null, policy: {}, validFrom: null, validTo: null, isActive: true }), 'POST', '/pos-plans', plan],
    ['updatePlan', () => updatePlan(plan.id, { name: 'Шинэ' }), 'PATCH', `/pos-plans/${plan.id}`, plan],
    ['listAdminLeases', () => listAdminLeases({ merchantId: mid }), 'GET', '/pos-leases', paged([toListItem(lease)])],
    ['getAdminLease', () => getAdminLease(id), 'GET', `/pos-leases/${id}`, admin],
    ['reviewLease', () => reviewLease(id, { decision: 'APPROVE', comment: 'Шалгасан' }), 'POST', `/pos-leases/${id}/review`, admin],
    ['settleLease', () => settleLease(id, { settlementRef: 'TRF-1' }), 'POST', `/pos-leases/${id}/settle`, admin],
  ];

  it.each(table)('%s', async (_name, call, method, path, response) => {
    mockFetch(() => jsonResponse(200, response));
    await call();
    const u = new URL(seen[0]!.url);
    expect(seen[0]!.init.method).toBe(method);
    expect(u.pathname).toBe(new URL(`${API}${path}`).pathname);
  });

  it.each(table)('%s rejects a response that does not match the contract', async (_name, call) => {
    mockFetch(() => jsonResponse(200, { unexpected: true }));
    const err = (await call().catch((x: unknown) => x)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('INVALID_RESPONSE');
  });
});
