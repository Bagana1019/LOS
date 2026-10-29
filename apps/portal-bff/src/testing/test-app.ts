import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../app.module';
import { AUDIT_SINK, type AuditEvent, type AuditSink } from '../audit/audit.service';
import { configureApp } from '../bootstrap';
import { CLOCK, type Clock } from '../common/clock';
import { PORTAL_CONFIG, type PortalConfig, loadConfig } from '../config/portal.config';
import { MOCK_LEDGER } from '../integrations/integrations.module';
import type { MockLedger } from '../integrations/mock/mock-ledger';
import type { MockOtpSender } from '../integrations/otp-sender/mock-otp-sender';
import { OTP_SENDER } from '../integrations/otp-sender/otp-sender.port';
import { AuthService } from '../modules/auth/auth.service';
import { KV_STORE, type KvStore } from '../store/kv-store';
import { MemoryKvStore } from '../store/memory-kv-store';
import { FakeOrigination } from './fake-origination';

export class FakeClock implements Clock {
  constructor(public current: Date) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class MemoryAuditSink implements AuditSink {
  readonly records: Array<AuditEvent & { at: string }> = [];
  write(record: AuditEvent & { at: string }): void {
    this.records.push(record);
  }
  actions(): string[] {
    return this.records.map((r) => r.action);
  }
}

export const TEST_ENV = {
  NODE_ENV: 'test',
  PORTAL_JWT_SECRET: 'test-jwt-secret-0123456789abcdef0123456789',
  PORTAL_HASH_SECRET: 'test-hash-secret-0123456789abcdef012345678',
  PORTAL_STORE: 'memory',
  PORTAL_TRUST_PROXY: '1',
  PORTAL_OTP_RESEND_SEC: '0',
  PORTAL_OTP_REQUESTS_PER_HOUR: '1000',
  PORTAL_OTP_REQUESTS_PER_HOUR_PER_IP: '1000',
  PORTAL_MOCK_PAYMENT_CONFIRM_MS: '1000',
} satisfies Record<string, string>;

export interface TestApp {
  app: NestExpressApplication;
  cfg: PortalConfig;
  clock: FakeClock;
  store: KvStore;
  ledger: MockLedger;
  otp: MockOtpSender;
  audit: MemoryAuditSink;
  http: () => ReturnType<typeof request>;
  /** Арын ажил (OTP SMS илгээлт) дуустал хүлээнэ. */
  settle: () => Promise<void>;
  /** Демо харилцагчаар OTP-оор нэвтэрч access/refresh токен авна. */
  login(registerNo?: string, phone?: string, ip?: string): Promise<{ accessToken: string; refreshToken: string; customerId: string }>;
}

export const DEMO_1 = { registerNo: 'УБ90010112', phone: '99112233', customerId: 'cust_demo_001' };
export const DEMO_2 = { registerNo: 'УА85050505', phone: '88112233', customerId: 'cust_demo_002' };

export async function createTestApp(env: Record<string, string> = {}): Promise<TestApp> {
  const cfg = loadConfig({ ...TEST_ENV, ...env });
  const clock = new FakeClock(new Date('2026-10-28T04:00:00.000Z')); // Улаанбаатарт 12:00
  const store = new MemoryKvStore(clock);
  const audit = new MemoryAuditSink();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PORTAL_CONFIG)
    .useValue(cfg)
    .overrideProvider(CLOCK)
    .useValue(clock)
    .overrideProvider(KV_STORE)
    .useValue(store)
    .overrideProvider(AUDIT_SINK)
    .useValue(audit)
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  configureApp(app, cfg);
  await app.init();

  const otp = app.get<MockOtpSender>(OTP_SENDER);
  const ledger = app.get<MockLedger>(MOCK_LEDGER);
  const http = () => request(app.getHttpServer());
  const settle = () => app.get(AuthService).drainPendingSends();

  const login: TestApp['login'] = async (registerNo = DEMO_1.registerNo, phone = DEMO_1.phone, ip = '10.0.0.1') => {
    const challenge = await http().post('/api/portal/auth/otp').set('X-Forwarded-For', ip).send({ registerNo, phone }).expect(200);
    await settle();
    const customerId = [DEMO_1, DEMO_2].find((c) => c.registerNo === registerNo)?.customerId ?? '';
    const code = otp.lastCodeFor(customerId) as string;
    const res = await http()
      .post('/api/portal/auth/verify')
      .set('X-Forwarded-For', ip)
      .send({ challengeId: challenge.body.challengeId, code })
      .expect(200);
    return { accessToken: res.body.accessToken, refreshToken: res.body.refreshToken, customerId };
  };

  return { app, cfg, clock, store, ledger, otp, audit, http, settle, login };
}

/** INTEGRATION_MODE=real: portal-bff ↔ FakeOrigination (жинхэнэ HTTP, сүлжээгээр). */
export async function createRealModeApp(env: Record<string, string> = {}): Promise<{
  t: Omit<TestApp, 'ledger' | 'otp' | 'login'> & { login: (registerNo?: string, phone?: string, ip?: string) => Promise<{ accessToken: string; refreshToken: string; customerId: string }> };
  origination: FakeOrigination;
  close: () => Promise<void>;
}> {
  const clock = new FakeClock(new Date('2026-10-28T04:00:00.000Z'));
  const origination = new FakeOrigination(clock);
  await origination.start();
  const cfg = loadConfig({ ...TEST_ENV, INTEGRATION_MODE: 'real', ORIGINATION_URL: origination.url, ...env });
  const store = new MemoryKvStore(clock);
  const audit = new MemoryAuditSink();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PORTAL_CONFIG)
    .useValue(cfg)
    .overrideProvider(CLOCK)
    .useValue(clock)
    .overrideProvider(KV_STORE)
    .useValue(store)
    .overrideProvider(AUDIT_SINK)
    .useValue(audit)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  configureApp(app, cfg);
  await app.init();
  const http = () => request(app.getHttpServer());
  const settle = () => app.get(AuthService).drainPendingSends();

  const login = async (registerNo = DEMO_1.registerNo, phone = DEMO_1.phone, ip = '10.0.0.1') => {
    const challenge = await http().post('/api/portal/auth/otp').set('X-Forwarded-For', ip).send({ registerNo, phone }).expect(200);
    await settle();
    const customerId = [DEMO_1, DEMO_2].find((c) => c.registerNo === registerNo)?.customerId ?? '';
    const code = origination.otpCodes.get(customerId) as string;
    const res = await http().post('/api/portal/auth/verify').set('X-Forwarded-For', ip).send({ challengeId: challenge.body.challengeId, code }).expect(200);
    return { accessToken: res.body.accessToken as string, refreshToken: res.body.refreshToken as string, customerId };
  };

  return {
    t: { app, cfg, clock, store, audit, http, settle, login },
    origination,
    close: async () => {
      await app.close();
      await origination.stop();
    },
  };
}
