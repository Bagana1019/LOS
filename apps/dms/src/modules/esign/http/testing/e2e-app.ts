// FR-11.4 e2e угсралт: БОДИТ EsignModule + main-ийн CommonModule (auth guard, алдааны фильтр) — HTTP → SigningService → store/files → mock provider-ууд → PdfLibStamper,
// удирдаж болох цагтай. Production-д ашиглагдахгүй. Хоёр горим: санах ой (DB-гүй, overrideProvider) эсвэл `database: true` (бодит Postgres, TEST_DATABASE_URL).
// `rawBody: true` + `api` угтвар нь bootstrapService-тэй ижил; env-ийг provider factory-ууд process.env-ээс уншина.
import { createHmac } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type { DomainEvent } from '@los/contracts';
import { CommonModule } from '@los/nest-common';
import request from 'supertest';
import { expect } from 'vitest';
import { PrismaModule, PrismaService } from '../../../../prisma.service';
import { EsignModule } from '../../esign.module';
import { SIGNING_FILES, type SigningFiles } from '../../ports/signing-files.port';
import { SIGNING_STORE, type SigningStore } from '../../ports/signing.store';
import type { CreateSigningInput } from '../../signing.service';
import { SigningSweeperService } from '../../signing-sweeper.service';
import { MemorySigningStore } from '../../stores/memory-signing.store';
import { MemorySigningFiles } from '../../testing/memory-signing-files';
import {
  captureLogs, CONTRACT_NO, DEFAULT_REGISTER, getSamplePdf, registerEndingWith, SIGNER_NAME, SIGNER_PHONE, TestClock, type CapturedLogs,
} from '../../signing.test-harness';

export const WEBHOOK_SECRET = 'e2e-webhook-secret-0123456789abcdef';
export const PUBLIC_BASE_URL = 'https://sign.example.test';
/** e2e-ийн бүх хүсэлт энэ байгууллагад: Postgres горимд өмнөх ажиллалтын үлдэгдлийг цэвэрлэхэд ашиглана */
export const E2E_ORG = 'e2e-esign-org';
/** Gateway-ийн тавьдаг итгэмжлэгдсэн толгойнууд (CommonModule-ийн guard) */
export const OFFICER = { 'x-user-id': 'officer-7', 'x-roles': 'OFFICER', 'x-org-id': E2E_ORG, 'x-correlation-id': 'corr-e2e-1' } as const;
const UPLOADER = 'e2e-uploader';
/** Fixture: `registerEndingWith('00')` гэх мэт — mock provider-ийн үр дүн регистрийн сүүлийн 2 цифрээс */
export { DEFAULT_REGISTER, SIGNER_NAME, SIGNER_PHONE, CONTRACT_NO };

const E2E_ENV: Readonly<Record<string, string>> = {
  STORAGE_DRIVER: 'memory',
  OUTBOX_RELAY: 'off',
  INTERNAL_AUTH_SECRET: '',
  INTEGRATION_MODE: 'mock',
  ESIGN_SWEEP_INTERVAL_SEC: '0',
  MOCK_ESIGN_APPROVE_AFTER_MS: '3000',
  MOCK_ESIGN_WEBHOOK_SECRET: WEBHOOK_SECRET,
  ESIGN_PUBLIC_BASE_URL: PUBLIC_BASE_URL,
  ESIGN_CALLBACK_BASE_URL: 'https://api.example.test/api',
};

/** `beforeAll`-д дуудаж, буцаасан функцийг `afterAll`-д дуудна: provider factory-ууд process.env-ийг уншдаг тул түр тавьж, дараа нь сэргээнэ */
export function applyE2eEnv(overrides: Record<string, string> = {}): () => void {
  const wanted = { ...E2E_ENV, ...overrides };
  const saved = Object.fromEntries(Object.keys(wanted).map((name) => [name, process.env[name]]));
  Object.assign(process.env, wanted);
  return () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

export const tokenFrom = (signingUrl: string): string => signingUrl.slice(signingUrl.lastIndexOf('/sign/') + '/sign/'.length);
/** Mock deep link `mock-tridum://sign/<providerRef>` */
export const providerRefFrom = (deepLink: string): string => deepLink.slice(deepLink.lastIndexOf('/') + 1);
export const signWebhook = (rawBody: string, secret = WEBHOOK_SECRET): string => createHmac('sha256', secret).update(rawBody).digest('hex');

/** Ажилтны (`/api/esign/…`) хүсэлт толгой өгөөгүй бол gateway-ийн итгэмжлэгдсэн толгойг OFFICER-ээр тавина; public/dev замд юу ч нэмэхгүй. Заасан толгой нь хэвээр */
const authFor = (path: string, headers: Record<string, string> | undefined): Record<string, string> => headers ?? (path.startsWith('/api/esign') ? { ...OFFICER } : {});

export interface Reply {
  status: number;
  /** JSON бие (бинар хариунд `Buffer`) */
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  text: string;
  headers: Record<string, string>;
}

export interface E2e {
  app: INestApplication;
  moduleRef: TestingModule;
  clock: TestClock;
  /** MemorySigningStore (default) | PrismaSigningStore (`database: true`) */
  store: SigningStore;
  prisma: PrismaService;
  files: SigningFiles;
  sweeper: SigningSweeperService;
  sourceFileId: string;
  sourcePdf: Buffer;
  logs: CapturedLogs;
  /** Бүх JSON/text хариуны бие + толгой (PII шалгалтад). Бинар (PDF) хариуны бие орохгүй */
  transcript: string[];
  /** Хариунд ирсэн нэг удаагийн линкийн токенууд (create/resend) — лог-д орох ёсгүй */
  tokens: string[];
  /** Outbox-д бичигдсэн e-sign event-үүд (дарааллаар) */
  events(): Promise<DomainEvent[]>;
  get(path: string, headers?: Record<string, string>): Promise<Reply>;
  getBinary(path: string, headers?: Record<string, string>): Promise<Reply>;
  post(path: string, body?: string | object, headers?: Record<string, string>): Promise<Reply>;
  /** Ажилтан хүсэлт үүсгэнэ (default DTO + overrides) */
  createRequest(overrides?: Partial<CreateSigningInput>, headers?: Record<string, string>): Promise<Reply>;
  /** Үүсгээд токен + id-г салгаж буцаана (201 гэж шалгана) */
  issue(overrides?: Partial<CreateSigningInput>): Promise<{ id: string; token: string; signingUrl: string }>;
  close(): Promise<void>;
}

/** Postgres горимд: энэ e2e-ийн мөр, audit, outbox event, файлуудыг устгана (тест эхлэхийн өмнө ба дараа) */
async function purgeDatabase(prisma: PrismaService): Promise<void> {
  const rows = await prisma.signingRequest.findMany({ where: { orgId: E2E_ORG }, select: { sourceFileId: true, signedFileId: true, signatureFileId: true } });
  const fileIds = rows.flatMap((row) => [row.sourceFileId, row.signedFileId, row.signatureFileId]).filter((id): id is string => id !== null);
  await prisma.signingEvent.deleteMany({ where: { signingRequest: { orgId: E2E_ORG } } });
  await prisma.signingRequest.deleteMany({ where: { orgId: E2E_ORG } });
  await prisma.outbox.deleteMany({ where: { payload: { path: ['orgId'], equals: E2E_ORG } } });
  await prisma.file.deleteMany({ where: { OR: [{ id: { in: fileIds } }, { uploadedBy: UPLOADER }, { orgId: E2E_ORG }] } });
}

export interface StartE2eOptions {
  /** Бодит Postgres (TEST_DATABASE_URL, dms schema) дээр PrismaSigningStore + `dms.file`. Default: санах ой */
  database?: boolean;
}

export async function startE2e(options: StartE2eOptions = {}): Promise<E2e> {
  const clock = new TestClock();
  const logs = captureLogs();
  const usesDatabase = options.database === true;
  const builder = Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true }), CommonModule.forRoot(), PrismaModule, EsignModule.register({ clock: clock.now })],
  });
  if (!usesDatabase) {
    // DB-гүй: PrismaService-ийг холбогдохгүй stub-аар, store/files-ийг санах ойн хувилбараар солино
    builder.overrideProvider(PrismaService).useValue({});
    builder.overrideProvider(SIGNING_STORE).useValue(new MemorySigningStore(clock.now));
    builder.overrideProvider(SIGNING_FILES).useValue(new MemorySigningFiles());
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ rawBody: true, logger: false });
  app.setGlobalPrefix('api');
  await app.init();

  const store = moduleRef.get<SigningStore>(SIGNING_STORE, { strict: false });
  const prisma = moduleRef.get(PrismaService, { strict: false });
  const files = moduleRef.get<SigningFiles>(SIGNING_FILES, { strict: false });
  if (usesDatabase) await purgeDatabase(prisma);

  const sourcePdf = await getSamplePdf();
  const source = await files.save({ orgId: E2E_ORG, name: `${CONTRACT_NO}.pdf`, mime: 'application/pdf', bytes: sourcePdf, uploadedBy: UPLOADER });
  const transcript: string[] = [];

  const tokens: string[] = [];
  const finish = (res: { status: number; body: unknown; text: string; headers: Record<string, string> }): Reply => {
    transcript.push(res.text, JSON.stringify(res.headers));
    const signingUrl = (res.body as { signingUrl?: unknown } | null)?.signingUrl;
    if (typeof signingUrl === 'string') tokens.push(tokenFrom(signingUrl));
    return { status: res.status, body: res.body, text: res.text, headers: res.headers };
  };
  const http = () => request(app.getHttpServer());
  const e2e: E2e = {
    app, moduleRef, clock, logs, transcript, tokens, sourceFileId: source.id, sourcePdf,
    store, prisma, files,
    events: async () => {
      if (store instanceof MemorySigningStore) return store.events;
      const rows = await prisma.outbox.findMany({ where: { payload: { path: ['orgId'], equals: E2E_ORG } }, orderBy: { createdAt: 'asc' } });
      return rows.map((row) => row.payload as unknown as DomainEvent);
    },
    sweeper: moduleRef.get(SigningSweeperService, { strict: false }),
    get: async (path, headers) => finish(await http().get(path).set(authFor(path, headers))),
    // Бинар (PDF) хариуны бие transcript-д орохгүй; алдааны JSON хариу (410 гэх мэт) нь задлагдаж, transcript-д орно
    getBinary: async (path, headers) => {
      const res = await http().get(path).set(authFor(path, headers)).responseType('blob');
      if (!/json/.test(res.headers['content-type'] ?? '')) return { status: res.status, body: res.body, text: '', headers: res.headers };
      const text = (res.body as Buffer).toString('utf8');
      return finish({ status: res.status, body: JSON.parse(text), text, headers: res.headers });
    },
    post: async (path, body, headers) => finish(await http().post(path).set(authFor(path, headers)).send(body)),
    createRequest: (overrides = {}, headers = { ...OFFICER }) => {
      const dto = {
        applicationId: 'app-1',
        contractId: 'contract-1',
        contractNo: CONTRACT_NO,
        sourceFileId: source.id,
        signer: { customerId: 'cust-1', fullName: SIGNER_NAME, registerNo: DEFAULT_REGISTER, phone: SIGNER_PHONE },
        ...overrides,
      };
      return e2e.post('/api/esign/requests', dto, headers);
    },
    issue: async (overrides) => {
      const res = await e2e.createRequest(overrides);
      if (res.status !== 201) throw new Error(`issue: expected 201, got ${res.status}`);
      return { id: res.body.id as string, signingUrl: res.body.signingUrl as string, token: tokenFrom(res.body.signingUrl) };
    },
    close: async () => {
      logs.restore();
      if (usesDatabase) await purgeDatabase(prisma);
      await app.close();
    },
  };
  return e2e;
}

/** Fixture регистрүүд (`registerEndingWith`) ба тэдгээрийн тоон хэсэг, утас, нэр — хариу/лог-д ХЭЗЭЭ Ч орох ёсгүй (далдалсан хэлбэр л) */
const PII = [DEFAULT_REGISTER, ...['00', '11', '55', '77', '99'].map(registerEndingWith), SIGNER_PHONE, SIGNER_NAME, 'Бат-Эрдэнэ'].flatMap((value) => (/^\p{L}/u.test(value) && /\d/.test(value) ? [value, value.slice(2)] : [value]));

/** Тест бүрийн дараа: бүх JSON/text хариу, толгой, лог-д PII байхгүй; линкийн токен лог-д байхгүй */
export function assertNoLeaks(e2e: E2e): void {
  const responses = e2e.transcript.join('\n');
  const logs = e2e.logs.lines.join('\n');
  for (const secret of PII) {
    expect(responses, `хариуд "${secret.slice(0, 4)}…" орсон`).not.toContain(secret);
    expect(logs, `лог-д "${secret.slice(0, 4)}…" орсон`).not.toContain(secret);
  }
  for (const token of e2e.tokens) expect(logs, 'лог-д токен орсон').not.toContain(token);
}
