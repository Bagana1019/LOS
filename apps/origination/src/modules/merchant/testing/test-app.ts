import { Logger, type INestApplication, type Provider, type Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { POS_CONFIG, loadPosConfig, type PosConfig } from '../config/pos.config';
import { IN_MEMORY_OUTBOX, MerchantModule } from '../merchant.module';
import { BuyerScreeningPort, Clock, IdGenerator, SmsGateway } from '../ports';
import type { InMemoryOutbox } from '../persistence/memory/in-memory';
import { DashboardService } from '../services/dashboard.service';
import { LeaseService } from '../services/lease.service';
import { MerchantService } from '../services/merchant.service';
import { OtpService } from '../services/otp.service';
import { PlanService } from '../services/plan.service';
import { QuoteService } from '../services/quote.service';
import { CapturingLogger } from './capturing-logger';
import { ControllableSms } from './controllable-sms';
import { ControllableScreening } from './controllable-screening';
import { FakeClock } from './fake-clock';
import { seedFixtures, type Fixtures } from './fixtures';
import { personasFor, type HeaderMap, type Personas } from './personas';
import { SequentialIdGenerator } from './sequential-id';

export interface TestAppOptions {
  config?: Partial<PosConfig>;
  overrides?: Provider[];
}

export type HttpResult = { status: number; body: any; headers: Record<string, string>; text: string }; // eslint-disable-line @typescript-eslint/no-explicit-any

/** HTTP e2e + service тестэд: санах ойн persistence, mock интеграци, FakeClock, дараалсан ID. */
export class TestApp {
  static readonly PREFIX = '/api';
  /** Бүх HTTP хариу: `METHOD path status body` */
  readonly transcript: string[] = [];
  /** Зөвхөн хариуны бие (PII scan: хүсэлтийн URL-д хайлтын PII орж болно) */
  readonly bodies: string[] = [];

  private constructor(
    readonly app: INestApplication,
    readonly clock: FakeClock,
    readonly ids: SequentialIdGenerator,
    readonly screening: ControllableScreening,
    readonly logger: CapturingLogger,
  ) {}

  static async create(opts: TestAppOptions = {}): Promise<TestApp> {
    const clock = new FakeClock();
    const ids = new SequentialIdGenerator();
    const screening = new ControllableScreening(clock);
    const sms = new ControllableSms();
    const logger = new CapturingLogger();
    const config: PosConfig = { ...loadPosConfig({ NODE_ENV: 'test' }), ...opts.config };
    const moduleRef = await Test.createTestingModule({
      imports: [MerchantModule.register({
        persistence: 'memory', integrationMode: 'mock',
        overrides: [
          { provide: Clock, useValue: clock }, { provide: IdGenerator, useValue: ids }, { provide: BuyerScreeningPort, useValue: screening }, { provide: SmsGateway, useValue: sms },
          { provide: POS_CONFIG, useValue: config }, ...(opts.overrides ?? []),
        ],
      })],
    }).compile();
    const app = moduleRef.createNestApplication();
    app.useLogger(logger); // compile() Nest-ийн TestingLogger-ийг суулгадаг тул ДАРАА нь
    Logger.overrideLogger(logger);
    app.setGlobalPrefix('api');
    await app.init();
    return new TestApp(app, clock, ids, screening, logger);
  }

  get<T>(token: Type<T> | symbol | string | (abstract new (...args: never[]) => T)): T {
    return this.app.get(token as Type<T>, { strict: false });
  }

  get sms(): ControllableSms { return this.get(SmsGateway) as ControllableSms; }
  get outbox(): InMemoryOutbox { return this.get<InMemoryOutbox>(IN_MEMORY_OUTBOX); }
  get services() {
    return {
      merchants: this.get(MerchantService), plans: this.get(PlanService), quotes: this.get(QuoteService),
      leases: this.get(LeaseService), dashboard: this.get(DashboardService), otp: this.get(OtpService),
    };
  }

  async fixtures(): Promise<Fixtures> { return seedFixtures(this.services); }
  personas(merchantId: string): Personas { return personasFor(merchantId); }

  async close(): Promise<void> { await this.app.close(); }

  /** Бүх HTTP дуудлага ('/api' угтвартай) */
  async http(method: 'get' | 'post' | 'patch', path: string, headers: HeaderMap = {}, body?: unknown, extra: HeaderMap = {}): Promise<HttpResult> {
    let req = request(this.app.getHttpServer())[method](`${TestApp.PREFIX}${path}`).set({ ...headers, ...extra });
    if (body !== undefined) req = req.send(body);
    const res = await req;
    this.transcript.push(`${method.toUpperCase()} ${path} ${res.status} ${res.text}`);
    this.bodies.push(res.text);
    return { status: res.status, body: res.body, headers: res.headers, text: res.text };
  }
  getJson(path: string, headers?: HeaderMap) { return this.http('get', path, headers); }
  postJson(path: string, headers: HeaderMap, body?: unknown, extra?: HeaderMap) { return this.http('post', path, headers, body ?? {}, extra); }
  patchJson(path: string, headers: HeaderMap, body: unknown) { return this.http('patch', path, headers, body); }
}
