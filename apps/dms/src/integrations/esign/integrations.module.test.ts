import { createHmac } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { RealMonpassProvider } from '../monpass/monpass.real';
import { MockMonpassProvider } from '../monpass/monpass.mock';
import { RealTridumProvider } from '../tridum/tridum.real';
import { MockTridumProvider } from '../tridum/tridum.mock';
import { DevMockEsignController } from './dev-mock.controller';
import { CLOCK, ESIGN_PROVIDERS, ESignProviderError, type Clock, type CreateProviderSessionInput, type ESignProviderPort } from './esign-provider.port';
import { IntegrationsConfigError } from './integrations.config';
import { IntegrationsModule, systemClock } from './integrations.module';
import { ProviderRegistry } from './provider.registry';

const DIGEST = 'b'.repeat(64);
const START_MS = Date.UTC(2026, 9, 28, 3, 0, 0);

function input(registerNo = 'УА12345678'): CreateProviderSessionInput {
  return {
    signingRequestId: 'sr-1',
    document: { name: 'c.pdf', digest: { algorithm: 'SHA-256', hex: DIGEST } },
    signer: { fullName: 'Болд Бат', registerNo, phone: '99112233' },
    callbackUrl: null,
    ttlSeconds: 300,
    correlationId: 'corr-1',
  };
}

const apps: INestApplication[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function compile(env: Record<string, string | undefined>, clock?: Clock): Promise<TestingModule> {
  return Test.createTestingModule({ imports: [IntegrationsModule.register({ env, clock })] }).compile();
}

async function listen(env: Record<string, string | undefined>, clock?: Clock): Promise<{ moduleRef: TestingModule; base: string }> {
  const moduleRef = await compile(env, clock);
  const app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  apps.push(app);
  return { moduleRef, base: await app.getUrl() };
}

describe('IntegrationsModule.register — тохиргооны хамгаалалт', () => {
  it('NODE_ENV=production + mock (тодорхой эсвэл default) → эхлэхэд алдаа', () => {
    expect(() => IntegrationsModule.register({ env: { NODE_ENV: 'production', INTEGRATION_MODE: 'mock' } })).toThrow(IntegrationsConfigError);
    expect(() => IntegrationsModule.register({ env: { NODE_ENV: 'production' } })).toThrow(/NODE_ENV=production/);
  });

  it('буруу INTEGRATION_MODE → эхлэхэд алдаа', () => {
    expect(() => IntegrationsModule.register({ env: { INTEGRATION_MODE: 'sandbox' } })).toThrow(/Invalid INTEGRATION_MODE/);
  });

  it('NODE_ENV=production + real → зөвшөөрнө, dev controller бүртгэгдэхгүй', () => {
    const mod = IntegrationsModule.register({ env: { NODE_ENV: 'production', INTEGRATION_MODE: 'real' } });
    expect(mod.controllers).toEqual([]);
  });

  it('DevMockEsignController зөвхөн mock + production биш үед бүртгэгдэнэ', () => {
    expect(IntegrationsModule.register({ env: {} }).controllers).toEqual([DevMockEsignController]);
    expect(IntegrationsModule.register({ env: { INTEGRATION_MODE: 'mock', NODE_ENV: 'development' } }).controllers).toEqual([DevMockEsignController]);
    expect(IntegrationsModule.register({ env: { INTEGRATION_MODE: 'real' } }).controllers).toEqual([]);
  });

  it('ESIGN_PROVIDERS, CLOCK, ProviderRegistry-г export хийнэ', () => {
    const mod = IntegrationsModule.register({ env: {} });
    expect(mod.exports).toEqual([ESIGN_PROVIDERS, CLOCK, ProviderRegistry]);
  });
});

describe('IntegrationsModule — provider-ууд', () => {
  it('default (mock): хоёр mock provider, registry-ээр code-оор олдоно', async () => {
    const moduleRef = await compile({});
    const providers = moduleRef.get<ESignProviderPort[]>(ESIGN_PROVIDERS, { strict: false });
    const registry = moduleRef.get(ProviderRegistry, { strict: false });

    expect(providers.map((p) => p.constructor)).toEqual([MockTridumProvider, MockMonpassProvider]);
    expect(providers.every((p) => p.isMock)).toBe(true);
    expect(registry.get('TRIDUM')).toBe(providers[0]);
    expect(registry.get('MONPASS')).toBe(providers[1]);
    expect(registry.list()).toEqual(providers);
  });

  it('INTEGRATION_MODE=real: хоёр real stub (isMock=false)', async () => {
    const moduleRef = await compile({ INTEGRATION_MODE: 'real' });
    const providers = moduleRef.get<ESignProviderPort[]>(ESIGN_PROVIDERS, { strict: false });

    expect(providers.map((p) => p.constructor)).toEqual([RealTridumProvider, RealMonpassProvider]);
    expect(providers.some((p) => p.isMock)).toBe(false);
  });

  it('real горимд env-ийг provider-т дамжуулна: тохиргоогүй бол NOT_CONFIGURED, тохируулсан бол NOT_IMPLEMENTED', async () => {
    const unconfigured = await compile({ INTEGRATION_MODE: 'real' });
    const configured = await compile({
      INTEGRATION_MODE: 'real',
      TRIDUM_BASE_URL: 'https://sandbox.example.test',
      TRIDUM_CLIENT_ID: 'id',
      TRIDUM_CLIENT_SECRET: 'secret',
      TRIDUM_WEBHOOK_SECRET: 'hook',
    });

    await expect(unconfigured.get(ProviderRegistry, { strict: false }).get('TRIDUM').getSession('r')).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    await expect(configured.get(ProviderRegistry, { strict: false }).get('TRIDUM').getSession('r')).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
    await expect(configured.get(ProviderRegistry, { strict: false }).get('MONPASS').getSession('r')).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });

  it('CLOCK default нь системийн цаг (() => new Date()); инжектлэсэн clock-ийг ашиглана', async () => {
    const moduleRef = await compile({});
    const clock = moduleRef.get<Clock>(CLOCK, { strict: false });
    expect(clock).toBe(systemClock);
    expect(Math.abs(clock().getTime() - Date.now())).toBeLessThan(5000);

    const fixed: Clock = () => new Date(START_MS);
    expect((await compile({}, fixed)).get<Clock>(CLOCK, { strict: false })).toBe(fixed);
  });

  it('MOCK_ESIGN_APPROVE_AFTER_MS ба clock mock provider-т хэрэглэгдэнэ', async () => {
    let nowMs = START_MS;
    const moduleRef = await compile({ MOCK_ESIGN_APPROVE_AFTER_MS: '1500' }, () => new Date(nowMs));
    const tridum = moduleRef.get(ProviderRegistry, { strict: false }).get('TRIDUM');
    const { providerRef } = await tridum.createSession(input());

    nowMs += 1499;
    expect((await tridum.getSession(providerRef)).state).toBe('PENDING');
    nowMs += 1;
    expect((await tridum.getSession(providerRef)).state).toBe('SIGNED');
  });

  it('MOCK_ESIGN_WEBHOOK_SECRET-ээр webhook-ийг баталгаажуулна (dev default биш)', async () => {
    const moduleRef = await compile({ MOCK_ESIGN_WEBHOOK_SECRET: 'custom-webhook-secret-123' });
    const tridum = moduleRef.get(ProviderRegistry, { strict: false }).get('TRIDUM');
    const raw = Buffer.from(JSON.stringify({ providerRef: 'TRD-MOCK-x' }));

    expect(tridum.parseWebhook({ headers: { 'x-mock-signature': createHmac('sha256', 'custom-webhook-secret-123').update(raw).digest('hex') }, rawBody: raw })).toEqual({ providerRef: 'TRD-MOCK-x' });
    expect(() => tridum.parseWebhook({ headers: { 'x-mock-signature': createHmac('sha256', 'dev-only-mock-esign-webhook-secret').update(raw).digest('hex') }, rawBody: raw })).toThrow(ESignProviderError);
  });
});

describe('DevMockEsignController — POST /api/dev/esign/mock/:providerRef/(approve|decline)', () => {
  const post = (base: string, ref: string, action: 'approve' | 'decline') => fetch(`${base}/api/dev/esign/mock/${ref}/${action}`, { method: 'POST' });

  it('approve: session-ийг эзэмшдэг provider (Tridum / Monpass) дээр SIGNED болгоно', async () => {
    const { moduleRef, base } = await listen({ MOCK_ESIGN_APPROVE_AFTER_MS: '3600000' });
    const registry = moduleRef.get(ProviderRegistry, { strict: false });

    for (const code of ['TRIDUM', 'MONPASS'] as const) {
      const provider = registry.get(code);
      const { providerRef } = await provider.createSession(input());
      expect((await provider.getSession(providerRef)).state).toBe('PENDING');

      const res = await post(base, providerRef, 'approve');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ providerRef, action: 'approve' });
      expect((await provider.getSession(providerRef)).state).toBe('SIGNED');
    }
  });

  it('decline: DECLINED болгоно; дараа нь approve → 409', async () => {
    const { moduleRef, base } = await listen({ MOCK_ESIGN_APPROVE_AFTER_MS: '3600000' });
    const provider = moduleRef.get(ProviderRegistry, { strict: false }).get('MONPASS');
    const { providerRef } = await provider.createSession(input());

    expect((await post(base, providerRef, 'decline')).status).toBe(200);
    expect(await provider.getSession(providerRef)).toEqual({ state: 'DECLINED' });
    const conflict = await post(base, providerRef, 'approve');
    expect(conflict.status).toBe(409);
    expect(await provider.getSession(providerRef)).toEqual({ state: 'DECLINED' });
  });

  it('үл мэдэгдэх providerRef → 404', async () => {
    const { base } = await listen({});
    expect((await post(base, 'TRD-MOCK-00000000-0000-4000-8000-000000000000', 'approve')).status).toBe(404);
    expect((await post(base, 'nope', 'decline')).status).toBe(404);
  });

  it('зөвхөн POST route байна (GET → 404)', async () => {
    const { base } = await listen({});
    expect((await fetch(`${base}/api/dev/esign/mock/x/approve`)).status).toBe(404);
  });

  it('INTEGRATION_MODE=real үед route огт байхгүй (404) — session ref таарсан ч', async () => {
    const { base } = await listen({ INTEGRATION_MODE: 'real' });
    expect((await post(base, 'TRD-MOCK-00000000-0000-4000-8000-000000000000', 'approve')).status).toBe(404);
  });
});
