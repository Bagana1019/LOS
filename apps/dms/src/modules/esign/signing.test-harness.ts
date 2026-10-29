// FR-11.4 SigningService-ийн тестүүдийн нийтлэг угсралт (production-д ашиглагдахгүй). Бодит гүйцэтгэлүүдийг (hand-rolled fake БИШ) холбоно:
// MockTridum/MockMonpass provider, PdfLibStamper, MemorySigningStore, MemorySigningFiles, DatabaseFieldCipher — бүгд ИЖИЛ удирдаж болох цагтай.
import { Logger } from '@nestjs/common';
import type { DomainEvent, ESignProvider } from '@los/contracts';
import { vi } from 'vitest';
import type { Clock } from '../../integrations/esign/esign-provider.port';
import { ProviderRegistry } from '../../integrations/esign/provider.registry';
import { MockMonpassProvider } from '../../integrations/monpass/monpass.mock';
import { MockTridumProvider } from '../../integrations/tridum/tridum.mock';
import { DatabaseFieldCipher } from './adapters/database-field-cipher';
import { loadEsignConfig, type EsignConfig } from './esign.config';
import { PdfLibStamper } from './pdf/pdf-lib-stamper';
import { createSamplePdf, SAMPLE_CONTRACT_NO } from './pdf/test-utils';
import type { PdfStamper } from './ports/pdf-stamper.port';
import type { SigningFiles } from './ports/signing-files.port';
import type { SigningRequestRecord, SigningStore } from './ports/signing.store';
import { SigningService, type ClientMeta, type CreateSigningInput, type RequestContext } from './signing.service';
import { MemorySigningStore } from './stores/memory-signing.store';
import { MemorySigningFiles, type MemoryObjectBucket } from './testing/memory-signing-files';

export const START_MS = Date.UTC(2026, 9, 28, 3, 0, 0);
export const SIGNER_NAME = 'Бат-Эрдэнэ Болд';
export const SIGNER_PHONE = '99112233';
/** Fixture: сүүлийн 2 цифр нь `33` → mock provider-ийн default (баталгаажуулна) */
export const DEFAULT_REGISTER = 'УА12345633';
export const SECRET_WEBHOOK = 'unit-test-webhook-secret-0123456789';
export const CTX: RequestContext = { actorId: 'officer-7', correlationId: 'corr-create-1', orgId: 'org-1' };
export const META: ClientMeta = { ip: '203.0.113.7', userAgent: 'Mozilla/5.0 (Linux; Android 14) TestBrowser' };
export const CONTRACT_NO = SAMPLE_CONTRACT_NO;

/** Mock provider-ийн fixture-ийг регистрийн сүүлийн 2 цифрээр сонгоно (`00`, `99`, `55`, `77`, `11`) */
export const registerEndingWith = (digits: string): string => `УА123456${digits}`;

export class TestClock {
  private ms = START_MS;
  readonly now: Clock = () => new Date(this.ms);
  advance(ms: number): void {
    this.ms += ms;
  }
  advanceSeconds(seconds: number): void {
    this.advance(seconds * 1000);
  }
  advanceHours(hours: number): void {
    this.advance(hours * 3_600_000);
  }
}

let samplePdf: Promise<Buffer> | undefined;
/** Тест файл бүрт нэг л удаа (шрифт embed удаан) */
export const getSamplePdf = (): Promise<Buffer> => (samplePdf ??= createSamplePdf({ pages: 2 }));

export type MockProvider = MockTridumProvider | MockMonpassProvider;
/** dms-ийн гаргадаг гурван event — бүгд `signingRequestId`-тай */
export type SigningDomainEvent = Extract<DomainEvent, { type: 'ContractSigningRequested' | 'ContractSigned' | 'ContractSigningFailed' }>;

export interface Harness {
  clock: TestClock;
  store: MemorySigningStore;
  storage: MemoryObjectBucket;
  fileService: MemorySigningFiles;
  cipher: DatabaseFieldCipher;
  tridum: MockTridumProvider;
  monpass: MockMonpassProvider;
  registry: ProviderRegistry;
  config: EsignConfig;
  service: SigningService;
  sourcePdf: Buffer;
  sourceFileId: string;
  providerPort(code: ESignProvider): MockProvider;
  /** Outbox-д бичигдсэн e-sign event-үүд (дарааллаар) */
  events(): SigningDomainEvent[];
  /** Дефолт DTO-оор хүсэлт үүсгэж, токеныг линкээс салгаж буцаана */
  create(overrides?: Partial<CreateSigningInput>, ctx?: RequestContext): Promise<{ record: SigningRequestRecord; signingUrl: string; token: string }>;
  /** Зээлдэгч гэрээг үзээд зөвшөөрч provider сонгоно (PENDING → IN_PROGRESS) */
  beginSigning(token: string, provider?: ESignProvider): Promise<Awaited<ReturnType<SigningService['start']>>>;
  /** Зээлдэгч утсан дээрээ баталлаа (mock provider-ийн approveNow) */
  approve(id: string): Promise<void>;
  record(id: string): Promise<SigningRequestRecord>;
}

export interface HarnessOptions {
  config?: Partial<EsignConfig>;
  /** Дефолт: хоёулаа бүртгэлтэй. Зөвхөн нэгийг өгвөл registry-д ганц provider байна */
  providers?: readonly ESignProvider[];
  /** Алдаа тарьж шалгахад: БОДИТ гүйцэтгэлийг ороосон нимгэн decorator (service-ийн хамаарал болж орно) */
  wrapFiles?: (files: SigningFiles) => SigningFiles;
  wrapStamper?: (stamper: PdfStamper) => PdfStamper;
  wrapStore?: (store: SigningStore) => SigningStore;
}

export const tokenOf = (signingUrl: string): string => signingUrl.slice(signingUrl.lastIndexOf('/sign/') + '/sign/'.length);

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const clock = new TestClock();
  const fileService = new MemorySigningFiles();
  const storage = fileService.storage;
  const files: SigningFiles = fileService;
  const store = new MemorySigningStore(clock.now);
  const cipher = new DatabaseFieldCipher();
  const mockOptions = { clock: clock.now, approveAfterMs: 3000, webhookSecret: SECRET_WEBHOOK };
  const tridum = new MockTridumProvider(mockOptions);
  const monpass = new MockMonpassProvider(mockOptions);
  const enabled = options.providers ?? ['TRIDUM', 'MONPASS'];
  const registry = new ProviderRegistry([tridum, monpass].filter((provider) => enabled.includes(provider.code)));
  const config: EsignConfig = { ...loadEsignConfig({}), ...options.config };
  const service = new SigningService(
    options.wrapStore?.(store) ?? store,
    options.wrapFiles?.(files) ?? files,
    options.wrapStamper?.(new PdfLibStamper()) ?? new PdfLibStamper(),
    cipher,
    registry,
    clock.now,
    config,
  );

  const sourcePdf = await getSamplePdf();
  const source = await fileService.put({ name: `${CONTRACT_NO}.pdf`, mime: 'application/pdf', bytes: sourcePdf, uploadedBy: 'officer-7' });

  const providerPort = (code: ESignProvider): MockProvider => (code === 'TRIDUM' ? tridum : monpass);
  const harness: Harness = {
    clock, store, storage, fileService, cipher, tridum, monpass, registry, config, service, sourcePdf, sourceFileId: source.id, providerPort,
    events: () => store.events.filter((event): event is SigningDomainEvent => event.type === 'ContractSigningRequested' || event.type === 'ContractSigned' || event.type === 'ContractSigningFailed'),
    async create(overrides = {}, ctx = CTX) {
      const dto: CreateSigningInput = {
        orgId: 'org-1',
        applicationId: 'app-1',
        contractId: 'contract-1',
        contractNo: CONTRACT_NO,
        sourceFileId: source.id,
        signer: { customerId: 'cust-1', fullName: SIGNER_NAME, registerNo: DEFAULT_REGISTER, phone: SIGNER_PHONE },
        ...overrides,
      };
      const { record, signingUrl } = await service.createRequest(dto, ctx);
      return { record, signingUrl, token: tokenOf(signingUrl) };
    },
    async beginSigning(token, provider = 'TRIDUM') {
      await service.getDocumentForReview(token, META);
      return service.start(token, { provider, consent: true, consentVersion: 'v1' }, META);
    },
    async approve(id) {
      const record = await store.getById(id);
      if (!record?.provider || !record.providerRef) throw new Error('harness.approve: no provider session');
      providerPort(record.provider).approveNow(record.providerRef);
    },
    async record(id) {
      const record = await store.getById(id);
      if (!record) throw new Error(`harness.record: ${id} not found`);
      return record;
    },
  };
  return harness;
}

export interface CapturedLogs {
  lines: string[];
  restore(): void;
}

/** Nest Logger-ийн бүх түвшинг барьж авч stdout-д гаргахгүй. Дуудагч `afterEach`-д `restore()` хийнэ */
export function captureLogs(): CapturedLogs {
  const lines: string[] = [];
  const spies = (['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const).map((level) =>
    vi.spyOn(Logger.prototype, level).mockImplementation((message: unknown, ...rest: unknown[]) => {
      lines.push([message, ...rest].map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '));
    }),
  );
  return { lines, restore: () => spies.forEach((spy) => spy.mockRestore()) };
}

/** Promise заавал reject хийх ёстой: reject-ийн утгыг буцаана (дараа нь instanceof/toMatchObject-оор шалгана) */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected the promise to reject');
    },
    (error: unknown) => error,
  );
}
