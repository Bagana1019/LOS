// E2E ТЕСТИЙН туслах (SYNTHETIC): ЖИНХЭНЭ BsaModule + main.ts-тэй ижил `configureBsaApp`-аар Nest HTTP апп босгож supertest-ээр дуудна.
// Хоёр горим: 'memory' (DB/Redis-гүй, in-memory repository + InlineImportQueue 'async') ба 'real' (PrismaBsaRepository + BullMQ; зөвхөн TEST_DATABASE_URL /
// REDIS_URL_TEST-тэй ажиллуулсан тест). Object store хоёулаа in-memory. Gateway-ийг X-* толгойгоор дуурайна (CLAUDE.md §3.2(9)).
import 'reflect-metadata';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { UserRole } from '@los/contracts';
import { MockOcrProvider } from '@los/ocr';
import request from 'supertest';
import { BsaModule } from '../../bsa.module';
import { DEFAULT_BSA_CATEGORIES, DEFAULT_BSA_RULES } from '../../classify';
import { InMemoryEventPublisher } from '../../common/event-publisher';
import { InlineImportQueue } from '../../common/import-queue';
import { BSA_SETTINGS, EVENT_PUBLISHER, IMPORT_QUEUE, OBJECT_STORE, PII_CIPHER, type BsaSettings, type ImportQueue, type PiiCipher } from '../../common/infra.ports';
import { InMemoryObjectStore } from '../../common/object-store';
import { BSA_REPOSITORY, InMemoryBsaRepository } from '../../common/persistence';
import { PrismaService } from '../../common/persistence/prisma.service';
import { TestPiiCipher } from '../../common/persistence/testing/test-pii-cipher';
import { TEST_SETTINGS } from '../../dti/testing/fixtures';
import { OCR_PROVIDER } from '../../parsers/text-extraction';
import { configureBsaApp } from '../http';
import { BSA_CLOCK, BSA_IMPORT_OPTIONS, IMPORT_DEFAULTS, type ImportOptions } from '../import.defaults';
import { SUSPICION_COUNTER } from '../suspicion.counter';
import { MutableClock, ORG } from '../testing/harness';
import type { SynFile } from '../testing/statement-files';

/** Шинжилгээний үндсэн хугацаа: 2026-04-01..2026-06-30 хуулгууд, «одоо» нь 2026-07-15 (testing/harness.ts-тэй ижил) */
export const E2E_NOW = new Date('2026-07-15T09:00:00.000Z');

export interface Actor {
  userId: string;
  roles: UserRole[];
  orgId: string;
  branchId: string | null;
}

const actor = (userId: string, roles: UserRole[], branchId: string | null, orgId = ORG): Actor => ({ userId, roles, orgId, branchId });

/** Gateway-ийн дамжуулах хэрэглэгчид: үндсэн нь br-1 салбар, org-1 */
export const ACTORS = {
  officer: actor('u-officer', ['OFFICER'], 'br-1'),
  officer2: actor('u-officer-2', ['OFFICER'], 'br-1'),
  manager: actor('u-manager', ['BRANCH_MANAGER'], 'br-1'),
  managerOtherBranch: actor('u-manager-2', ['BRANCH_MANAGER'], 'br-2'),
  officerOtherBranch: actor('u-officer-3', ['OFFICER'], 'br-2'),
  approver: actor('u-approver', ['APPROVER'], null),
  admin: actor('u-admin', ['ADMIN'], null),
  otherOrgAdmin: actor('u-admin-x', ['ADMIN'], null, 'org-2'),
} as const;
export type ActorKey = keyof typeof ACTORS;

export function headersOf(a: Actor, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { 'X-User-Id': a.userId, 'X-Roles': a.roles.join(','), 'X-Org-Id': a.orgId, ...extra };
  if (a.branchId !== null) h['X-Branch-Id'] = a.branchId;
  return h;
}

export interface E2eOptions {
  settings?: Partial<BsaSettings>;
  options?: Partial<ImportOptions>;
  /** 'memory' (анхдагч) | 'real': PrismaBsaRepository + (queue-г `queue`-ээр) — DATABASE_URL тохируулсан байх ёстой */
  mode?: 'memory' | 'real';
  /** Өөрийн queue (жишээ нь BullmqImportQueue). Анхдагч: InlineImportQueue 'async' */
  queue?: ImportQueue;
  /** 'real' горимд PII cipher-ийг env-ээс (production-тэй ижил) авна; 'memory'-д TestPiiCipher */
  cipher?: PiiCipher;
  /** Хүлээгдэж буй сэжигтэй гүйлгээний тоо (SuspicionCounter) — тест дунд өөрчилнө */
  suspicionPending?: number;
}

export interface E2eApp {
  app: INestApplication;
  settings: BsaSettings;
  clock: MutableClock;
  /** Хүлээгдэж буй сэжигтэй гүйлгээний тоолуур: `suspicion.pending = 3` */
  suspicion: { pending: number };
  memory: InMemoryBsaRepository | null;
  store: InMemoryObjectStore;
  publisher: InMemoryEventPublisher;
  inline: InlineImportQueue | null;
  /** Nest-ийн лог мөрүүд (PII шалгалт) */
  logs: string[];
  /** Шинэ хүсэлт (толгойтой) */
  api: Api;
  close(): Promise<void>;
}

const PRISMA_STUB = { onModuleInit: async (): Promise<void> => undefined, onModuleDestroy: async (): Promise<void> => undefined };
const silent = { warn: (): void => undefined, error: (): void => undefined };

/** Nest-ийн БҮХ лог мөрийг цуглуулна (PII лог руу гарсан эсэхийг шалгах). Орчуулалтгүй, stdout руу бичихгүй */
class CapturingLogger implements LoggerService {
  constructor(private readonly sink: string[]) {}
  log(message: unknown, ...rest: unknown[]): void {
    this.add('log', message, rest);
  }
  error(message: unknown, ...rest: unknown[]): void {
    this.add('error', message, rest);
  }
  warn(message: unknown, ...rest: unknown[]): void {
    this.add('warn', message, rest);
  }
  debug(message: unknown, ...rest: unknown[]): void {
    this.add('debug', message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]): void {
    this.add('verbose', message, rest);
  }
  private add(level: string, message: unknown, rest: unknown[]): void {
    this.sink.push(`${level} ${[message, ...rest].map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`);
  }
}

/** main.ts-тэй ЯГ ИЖИЛ bootstrap-аар Nest апп (listen хийхгүй: supertest өөрөө ephemeral порт нээнэ) */
export async function createE2eApp(o: E2eOptions = {}): Promise<E2eApp> {
  const mode = o.mode ?? 'memory';
  const settings: BsaSettings = { ...TEST_SETTINGS, minStatementMonths: 3, ...o.settings };
  const clock = new MutableClock(E2E_NOW);
  const suspicion = { pending: o.suspicionPending ?? 0 };
  const store = new InMemoryObjectStore();
  const publisher = new InMemoryEventPublisher();
  const inline = o.queue ? null : new InlineImportQueue({ mode: 'async', attempts: 3, logger: silent });
  const memory = mode === 'memory' ? new InMemoryBsaRepository({ now: () => clock.now(), cipher: new TestPiiCipher() }) : null;
  memory?.seedConfig(ORG, { categories: DEFAULT_BSA_CATEGORIES, rules: DEFAULT_BSA_RULES });

  let builder = Test.createTestingModule({ imports: [BsaModule] })
    .overrideProvider(OBJECT_STORE).useValue(store)
    .overrideProvider(IMPORT_QUEUE).useValue(o.queue ?? inline)
    .overrideProvider(BSA_SETTINGS).useValue({ get: async () => settings })
    .overrideProvider(BSA_CLOCK).useValue(clock)
    .overrideProvider(BSA_IMPORT_OPTIONS).useValue({ ...IMPORT_DEFAULTS, ...o.options })
    .overrideProvider(SUSPICION_COUNTER).useValue({ countPending: async (): Promise<number> => suspicion.pending })
    .overrideProvider(OCR_PROVIDER).useValue(new MockOcrProvider({ builtins: false, byFileName: [], bySha256: {} }));
  if (mode === 'memory') {
    builder = builder
      .overrideProvider(PII_CIPHER).useValue(o.cipher ?? new TestPiiCipher())
      .overrideProvider(EVENT_PUBLISHER).useValue(publisher)
      .overrideProvider(BSA_REPOSITORY).useValue(memory)
      .overrideProvider(PrismaService).useValue(PRISMA_STUB);
  } else if (o.cipher) {
    builder = builder.overrideProvider(PII_CIPHER).useValue(o.cipher);
  }
  const moduleRef = await builder.compile();
  const logs: string[] = [];
  const app = moduleRef.createNestApplication({ logger: new CapturingLogger(logs) });
  configureBsaApp(app); // main.ts-тэй ижил: /api угтвар, алдааны filter, correlation, JSON хязгаар
  await app.init();
  const server = app.getHttpServer();
  return {
    app, settings, clock, suspicion, memory, store, publisher, inline, logs,
    api: new Api(server),
    close: () => app.close(),
  };
}

type Method = 'get' | 'post' | 'delete';

/** supertest-ийн нимгэн ороолт: `as(actor)` толгойг тохируулна. Хариу нь `request.Response` */
export class Api {
  constructor(private readonly server: Parameters<typeof request>[0], private readonly who: Actor = ACTORS.officer, private readonly extra: Record<string, string> = {}) {}

  as(key: ActorKey | Actor, extra: Record<string, string> = {}): Api {
    return new Api(this.server, typeof key === 'string' ? ACTORS[key] : key, extra);
  }

  private req(method: Method, path: string): request.Test {
    return request(this.server)[method](`/api${path}`).set(headersOf(this.who, this.extra));
  }

  get(path: string): request.Test {
    return this.req('get', path);
  }
  post(path: string, body?: unknown): request.Test {
    const t = this.req('post', path);
    return body === undefined ? t : t.send(body as object);
  }
  del(path: string): request.Test {
    return this.req('delete', path);
  }
  /** multipart/form-data: `files` талбар + (заавал биш) `banks` JSON */
  upload(analysisId: string, files: Array<Pick<SynFile, 'content' | 'fileName' | 'mimeType'>>, banks?: unknown): request.Test {
    const t = this.req('post', `/bsa/analyses/${analysisId}/imports`);
    for (const f of files) t.attach('files', f.content, { filename: f.fileName, contentType: f.mimeType });
    if (banks !== undefined) t.field('banks', typeof banks === 'string' ? banks : JSON.stringify(banks));
    return t;
  }
}

/** Шинжилгээ үүсгэх хүсэлтийн синтетик бие (бүх нэр/регистр зохиомол) */
export const analysisBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  loanApplicationId: 'app-1',
  customerId: 'cust-1',
  borrowerId: 'bor-1',
  branchId: 'br-1',
  customer: { registerNo: 'УБ90010203', lastName: 'Bat-Erdene', firstName: 'Bold' },
  periodMonths: 3,
  proposedMonthlyPayment: 500_000,
  ...over,
});
