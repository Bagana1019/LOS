import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MerchantModule } from '../merchant.module';
import type { Fixtures } from '../testing/fixtures';
import { PosFlow } from '../testing/flow';
import { TestApp } from '../testing/test-app';

// PII-тэй хариу (худалдан авагчийн нэр, масклагдсан регистр/утас, шийдвэр, dashboard) хуваалцсан POS терминалын хөтөч/завсрын кэшэд үлдэх ёсгүй.
describe('merchant API responses are never cacheable', () => {
  let t: TestApp;
  let fx: Fixtures;
  let f: PosFlow;
  let leaseId: string;
  beforeAll(async () => {
    t = await TestApp.create();
    fx = await t.fixtures();
    f = new PosFlow(t, fx);
    leaseId = (await f.createOk({ seed: 1 })).id;
  });
  afterAll(async () => { await t.close(); });

  const expectNoStore = (res: { headers: Record<string, string> }, what: string) => {
    expect(res.headers['cache-control'], what).toBe('no-store');
    expect(res.headers['pragma'], what).toBe('no-cache');
  };

  it('sets Cache-Control: no-store and Pragma: no-cache on successful responses of all four controllers', async () => {
    const calls: Array<[string, () => Promise<{ status: number; headers: Record<string, string> }>]> = [
      ['GET /merchant-portal/me', () => t.getJson('/merchant-portal/me', f.staff1())],
      ['GET /merchant-portal/dashboard', () => t.getJson('/merchant-portal/dashboard', f.admin())],
      ['GET /merchant-portal/leases', () => t.getJson('/merchant-portal/leases', f.staff1())],
      ['GET /merchant-portal/leases/:id', () => t.getJson(`/merchant-portal/leases/${leaseId}`, f.staff1())],
      ['POST /merchant-portal/quotes', () => t.postJson('/merchant-portal/quotes', f.staff1(), { planCode: 'LAPTOP', goodsPrice: 3_000_000, downPayment: 600_000, termMonths: 12 })],
      ['GET /merchants', () => t.getJson('/merchants', f.lender())],
      ['GET /merchants/:id', () => t.getJson(`/merchants/${fx.merchantA.id}`, f.lender())],
      ['GET /merchants/:id/stores', () => t.getJson(`/merchants/${fx.merchantA.id}/stores`, f.lender())],
      ['GET /pos-plans', () => t.getJson('/pos-plans', f.lender())],
      ['GET /pos-leases', () => t.getJson('/pos-leases', f.lender())],
      ['GET /pos-leases/:id', () => t.getJson(`/pos-leases/${leaseId}`, f.lender())],
    ];
    for (const [what, call] of calls) {
      const res = await call(); // ӨӨРӨӨ дарааллаар (нэг server дээр зэрэг supertest listener нэмэхгүй)
      expect(res.status, what).toBe(200);
      expectNoStore(res, what);
    }
  });

  it('also on error responses (401 / 403 / 404 / 409 / 400) and on conditional requests', async () => {
    const unauth = await t.getJson('/merchant-portal/me', {});
    expect(unauth.status).toBe(401);
    expectNoStore(unauth, '401');
    const forbidden = await t.getJson('/merchants', f.staff1());
    expect(forbidden.status).toBe(403);
    expectNoStore(forbidden, '403');
    const missing = await t.getJson('/merchant-portal/leases/00000000-0000-4000-8000-0000000fffff', f.staff1());
    expect(missing.status).toBe(404);
    expectNoStore(missing, '404');
    const conflict = await t.postJson('/merchants', f.lender(), { code: fx.merchantA.code, name: 'Давхар', contactName: 'Б. Болд', phone: '99887766', branchId: 'BR-X', commissionRate: 0.02, maxTicketAmount: 5_000_000, settlement: { bankCode: 'KHAN', accountNo: '5099887766', holderName: 'Давхар ХХК' } });
    expect(conflict.status).toBe(409);
    expectNoStore(conflict, '409');
    const invalid = await t.postJson('/merchant-portal/quotes', f.staff1(), { planCode: 'LAPTOP' });
    expect(invalid.status).toBe(400);
    expectNoStore(invalid, '400');
    // ETag-тай ч If-None-Match-ээр 304 буцаах кэшийн урсгал no-store дор хэрэггүй: толгой нь хариу бүрт байна
    const first = await t.getJson(`/merchant-portal/leases/${leaseId}`, f.staff1());
    const cond = await t.http('get', `/merchant-portal/leases/${leaseId}`, f.staff1(), undefined, first.headers['etag'] ? { 'if-none-match': first.headers['etag'] } : {});
    expectNoStore(cond, 'conditional');
  });

  it('is scoped to the merchant module: other routes of the app are untouched', async () => {
    @Controller('other')
    class OtherController {
      @Get() ping() { return { ok: true }; }
    }
    const moduleRef = await Test.createTestingModule({ imports: [MerchantModule.register({ persistence: 'memory', integrationMode: 'mock' })], controllers: [OtherController] }).compile();
    const app: INestApplication = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    try {
      const other = await request(app.getHttpServer()).get('/api/other');
      expect(other.status).toBe(200);
      expect(other.headers['cache-control']).toBeUndefined();
      expect(other.headers['pragma']).toBeUndefined();
      const merchantApi = await request(app.getHttpServer()).get('/api/merchants');
      expect(merchantApi.headers['cache-control']).toBe('no-store');
    } finally {
      await app.close();
    }
  });
});
