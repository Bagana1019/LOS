import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MerchantModule } from '../merchant.module';
import { seedFixtures } from './fixtures';
import { applyDemoIdentity, corsOrigins, demoRefusal, displayHost, hostPolicy, isLoopbackHost } from './demo-gateway';
import { personasFor } from './personas';
import { MerchantService } from '../services/merchant.service';
import { PlanService } from '../services/plan.service';

const FORGED = { 'x-user-id': 'evil', 'x-org-id': 'org-test', 'x-roles': 'ADMIN', 'x-branch-id': 'BR-HQ', 'x-merchant-id': 'm', 'x-store-id': 's' };

describe('applyDemoIdentity: the demo gateway never trusts client-supplied identity', () => {
  it('removes every gateway header (but keeps the correlation id) when there is no persona', () => {
    const req = { headers: { ...FORGED, 'x-correlation-id': 'corr-1', cookie: 'a=b', accept: 'application/json' } as Record<string, string> };
    applyDemoIdentity(req);
    expect(req.headers).toEqual({ 'x-correlation-id': 'corr-1', cookie: 'a=b', accept: 'application/json' });
  });
  it('replaces forged values with the persona headers', () => {
    const persona = personasFor('00000000-0000-4000-8000-0000000000a1').lenderAdmin('real-admin');
    const req = { headers: { ...FORGED } as Record<string, string> };
    applyDemoIdentity(req, persona);
    expect(req.headers['x-user-id']).toBe('real-admin');
    expect(req.headers['x-roles']).toBe('ADMIN');
    expect(req.headers['x-merchant-id']).toBeUndefined();
    expect(req.headers['x-store-id']).toBeUndefined();
  });
});

describe('demo gateway in front of the merchant API (path case must not bypass header stripping)', () => {
  let app: INestApplication;
  let cookie: string;
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [MerchantModule.register({ persistence: 'memory', integrationMode: 'mock' })] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    const fx = await seedFixtures({ merchants: app.get(MerchantService), plans: app.get(PlanService) });
    const lender = personasFor(fx.merchantA.id).lenderAdmin('lender-1');
    // скриптийн адил: express middleware-г app.init()-ээс ӨМНӨ нэмнэ
    (app.getHttpAdapter().getInstance() as { use(fn: (req: { headers: Record<string, string | undefined> }, res: unknown, next: () => void) => void): void }).use((req, _res, next) => {
      applyDemoIdentity(req as never, req.headers.cookie === 'demo_persona=lender-admin' ? lender : undefined);
      next();
    });
    await app.init();
    cookie = 'demo_persona=lender-admin';
  });
  afterAll(async () => { await app.close(); });

  const PATHS = ['/api/merchants', '/API/merchants', '/Api/Merchants', '/aPi/merchants/'];

  it('forged x-user-id / x-org-id / x-roles are ignored on /api and on every case variant (401, not the merchant list)', async () => {
    for (const path of PATHS) {
      const res = await request(app.getHttpServer()).get(path).set(FORGED);
      expect(res.status, path).toBe(401);
      expect(res.body.code, path).toBe('UNAUTHENTICATED');
    }
  });

  it('the persona cookie authenticates on every case variant, and a forged org header cannot override it', async () => {
    for (const path of PATHS) {
      const res = await request(app.getHttpServer()).get(path).set('cookie', cookie).set({ ...FORGED, 'x-org-id': 'org-other' });
      expect(res.status, path).toBe(200);
      expect(res.body.total, path).toBe(2); // persona-ийн org (org-test)-ийн 2 мерчант, org-other-ийнх БИШ
    }
  });
});

describe('demoRefusal: same normalisation as the config helpers', () => {
  it('refuses production in any spelling/case, and real or unknown integration modes', () => {
    for (const nodeEnv of ['production', 'Production', ' PRODUCTION ']) expect(demoRefusal({ NODE_ENV: nodeEnv }), nodeEnv).toMatch(/^REFUSED: .*NODE_ENV=production/);
    for (const mode of ['real', 'Real', ' REAL ']) expect(demoRefusal({ INTEGRATION_MODE: mode }), mode).toMatch(/unset INTEGRATION_MODE=real/);
    expect(demoRefusal({ INTEGRATION_MODE: 'live' })).toMatch(/^REFUSED: INTEGRATION_MODE must be/); // fail closed, intended message (no stack trace)
  });
  it('allows development / test / mock / unset', () => {
    for (const env of [{}, { NODE_ENV: 'development' }, { NODE_ENV: 'test', INTEGRATION_MODE: 'mock' }, { INTEGRATION_MODE: ' Mock ' }]) expect(demoRefusal(env)).toBeNull();
  });
});

describe('hostPolicy: non-loopback binding needs an explicit opt-in', () => {
  it('knows loopback addresses (0.0.0.0 and :: are NOT loopback)', () => {
    for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]']) expect(isLoopbackHost(h), h).toBe(true);
    for (const h of ['0.0.0.0', '::', '192.168.1.5', '10.0.0.1', 'demo.example.com', '127.0.0.1.evil.com']) expect(isLoopbackHost(h), h).toBe(false);
  });
  it('loopback: allowed silently', () => {
    expect(hostPolicy('127.0.0.1', {})).toEqual({ allowed: true, message: null });
  });
  it('non-loopback without DEMO_ALLOW_REMOTE=1 is refused', () => {
    for (const h of ['0.0.0.0', '192.168.1.5', '::']) {
      const p = hostPolicy(h, {});
      expect(p.allowed, h).toBe(false);
      expect(p.message).toMatch(/^REFUSED: .*DEMO_ALLOW_REMOTE=1/);
    }
    for (const v of ['true', '0', 'yes', '']) expect(hostPolicy('0.0.0.0', { DEMO_ALLOW_REMOTE: v }).allowed, v).toBe(false);
  });
  it('non-loopback with DEMO_ALLOW_REMOTE=1 is allowed with a loud warning', () => {
    const p = hostPolicy('0.0.0.0', { DEMO_ALLOW_REMOTE: '1' });
    expect(p.allowed).toBe(true);
    expect(p.message).toMatch(/WARNING.*exposes the unauthenticated demo/);
  });
});

describe('displayHost / corsOrigins: the cookie host matches the web API base', () => {
  it('prints localhost for a loopback bind (apps/web defaults to http://localhost:4000/api), 127.0.0.1 only when the web itself is on 127.0.0.1', () => {
    expect(displayHost('127.0.0.1', 'http://localhost:3000')).toBe('localhost');
    expect(displayHost('::1', 'http://localhost:3000')).toBe('localhost');
    expect(displayHost('127.0.0.1', 'http://127.0.0.1:3000')).toBe('127.0.0.1');
    expect(displayHost('127.0.0.1', 'https://web.example.com')).toBe('localhost');
    expect(displayHost('192.168.1.5', 'http://localhost:3000')).toBe('192.168.1.5');
    expect(displayHost('::', 'http://localhost:3000')).toBe('[::]');
  });
  it('allows the web origin and its loopback twin, nothing else', () => {
    expect(corsOrigins('http://localhost:3000')).toEqual(['http://localhost:3000', 'http://127.0.0.1:3000']);
    expect(corsOrigins('http://127.0.0.1:3000')).toEqual(['http://127.0.0.1:3000', 'http://localhost:3000']);
    expect(corsOrigins('https://web.example.com/app')).toEqual(['https://web.example.com']);
  });
});
