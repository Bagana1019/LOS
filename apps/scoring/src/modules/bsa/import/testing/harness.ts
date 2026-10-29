// ТЕСТИЙН harness: in-memory port-ууд (repository, object store, queue, event publisher, cipher) + ЖИНХЭНЭ parser/classifier/DTI/calc дээр
// import service-үүдийг угсарна. Бүх өгөгдөл SYNTHETIC. Тест бүр шинэ harness авна (хуваалцсан төлөвгүй, deterministic).
import type { BankCode, UserRole } from '@los/contracts';
import { ClassifierService, DEFAULT_BSA_CATEGORIES, DEFAULT_BSA_RULES } from '../../classify';
import { InMemoryEventPublisher } from '../../common/event-publisher';
import { InlineImportQueue } from '../../common/import-queue';
import type { BsaSettings, BsaSettingsProvider, ObjectStore, RequestContext } from '../../common/infra.ports';
import { InMemoryObjectStore } from '../../common/object-store';
import { InMemoryBsaRepository, type BsaRepository } from '../../common/persistence';
import { TestPiiCipher } from '../../common/persistence/testing/test-pii-cipher';
import { DtiAnalysisService } from '../../dti';
import { TEST_SETTINGS } from '../../dti/testing/fixtures';
import { BANK_PARSERS } from '../../parsers';
import { StatementParserRegistry } from '../../parsers/parser.registry';
import type { StatementParser } from '../../parsers/statement.types';
import { StatementTextService } from '../../parsers/text-extraction';
import { NullQrVerifier } from '../../parsers/verifier/qr-verifier';
import { StatementVerificationService } from '../../parsers/verifier/statement-verification.service';
import { AnalysisService } from '../analysis.service';
import { FinalizeService } from '../finalize.service';
import { IMPORT_DEFAULTS, type Clock, type ImportOptions } from '../import.defaults';
import { ImportPipelineService } from '../import-pipeline.service';
import { ImportProcessor } from '../import.processor';
import { RecalculationService } from '../recalculation.service';
import { ReclassifyService } from '../reclassify.service';
import { RetentionService } from '../retention.service';
import type { SuspicionCounter } from '../suspicion.counter';
import { UploadService, type UploadResult } from '../upload.service';
import type { AnalysisView, ImportJobView } from '../views';
import type { SynFile } from './statement-files';

export const ORG = 'org-1';
export const OTHER_ORG = 'org-2';
export const BRANCH = 'br-1';
export const OTHER_BRANCH = 'br-2';
export const CUSTOMER_REGISTER = 'УБ90010203';

/** Тестийн цаг: гараар урагшлуулна */
export class MutableClock implements Clock {
  constructor(public current: Date) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export const ctxOf = (roles: UserRole[], over: Partial<RequestContext> = {}): RequestContext => ({
  orgId: ORG,
  userId: 'u-officer',
  roles,
  branchId: BRANCH,
  correlationId: 'corr-test',
  ...over,
});

/** Үндсэн хэрэглэгчид */
export const OFFICER = ctxOf(['OFFICER']);
export const ADMIN = ctxOf(['ADMIN'], { userId: 'u-admin', branchId: null });

/** repo.runInTransaction-ийг buffered publisher-ийн scope-д ороож, rollback үед outbox event-ийг мөн буцаана */
class ScopedRepository implements BsaRepository {
  readonly analyses: BsaRepository['analyses'];
  readonly importJobs: BsaRepository['importJobs'];
  readonly transactions: BsaRepository['transactions'];
  readonly events: BsaRepository['events'];
  readonly config: BsaRepository['config'];
  readonly retention: BsaRepository['retention'];

  constructor(private readonly inner: InMemoryBsaRepository, private readonly publisher: InMemoryEventPublisher) {
    this.analyses = inner.analyses;
    this.importJobs = inner.importJobs;
    this.transactions = inner.transactions;
    this.events = inner.events;
    this.config = inner.config;
    this.retention = inner.retention;
  }

  runInTransaction<T>(fn: (repo: BsaRepository, tx: unknown) => Promise<T>): Promise<T> {
    return this.publisher.scope(() => this.inner.runInTransaction(fn));
  }
}

export interface HarnessOptions {
  settings?: Partial<BsaSettings>;
  options?: Partial<ImportOptions>;
  /** 'sync' (анхдагч): enqueue ажил дуустал хүлээнэ */
  queueMode?: 'sync' | 'async';
  attempts?: number;
  now?: Date;
  /** Object store-ийг ороох (тест: алдаа шахах, дарааллыг бүртгэх) */
  wrapStore?: (store: InMemoryObjectStore, memory: InMemoryBsaRepository) => ObjectStore;
  /** Parser-ийг солих (тест: гэнэтийн алдаа шидэх) */
  parsers?: StatementParser[];
  /** false: worker-ийг эхлүүлэхгүй (ажил дараалалд хүлээнэ) */
  startWorker?: boolean;
}

export interface Harness {
  clock: MutableClock;
  settings: BsaSettings;
  memory: InMemoryBsaRepository;
  repo: BsaRepository;
  store: InMemoryObjectStore;
  /** Services-д өгсөн (боломжтой бол ороосон) object store */
  objects: ObjectStore;
  publisher: InMemoryEventPublisher;
  queue: InlineImportQueue;
  cipher: TestPiiCipher;
  suspicion: { pending: number };
  /** InlineImportQueue-ийн лог (PII шалгалтад) */
  queueLog: string[];
  options: ImportOptions;
  analysis: AnalysisService;
  upload: UploadService;
  pipeline: ImportPipelineService;
  processor: ImportProcessor;
  recalc: RecalculationService;
  reclassify: ReclassifyService;
  finalize: FinalizeService;
  retention: RetentionService;
  createAnalysis(over?: Record<string, unknown>, ctx?: RequestContext): Promise<AnalysisView>;
  uploadFiles(analysisId: string, files: SynFile[], ctx?: RequestContext, bankCode?: BankCode): Promise<UploadResult>;
  jobs(analysisId: string): Promise<ImportJobView[]>;
}

export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const clock = new MutableClock(opts.now ?? new Date('2026-07-15T09:00:00.000Z'));
  const settings: BsaSettings = { ...TEST_SETTINGS, minStatementMonths: 3, ...opts.settings };
  const settingsProvider: BsaSettingsProvider = { get: async () => settings };
  const cipher = new TestPiiCipher();
  const memory = new InMemoryBsaRepository({ now: () => clock.now(), cipher });
  memory.seedConfig(ORG, { categories: DEFAULT_BSA_CATEGORIES, rules: DEFAULT_BSA_RULES });
  const publisher = new InMemoryEventPublisher({ buffered: true });
  const repo = new ScopedRepository(memory, publisher);
  const store = new InMemoryObjectStore();
  const objects = opts.wrapStore ? opts.wrapStore(store, memory) : store;
  const queueLog: string[] = [];
  const recorder = { warn: (m: string): void => void queueLog.push(m), error: (m: string): void => void queueLog.push(m) };
  const queue = new InlineImportQueue({ mode: opts.queueMode ?? 'sync', attempts: opts.attempts ?? 3, logger: recorder });
  const options: ImportOptions = { ...IMPORT_DEFAULTS, ...opts.options };
  const suspicion = { pending: 0 };
  const suspicionCounter: SuspicionCounter = { countPending: async () => suspicion.pending };

  const classifier = new ClassifierService();
  const dti = new DtiAnalysisService();
  const parsers = opts.parsers ?? BANK_PARSERS.map((P) => new P());
  const registry = new StatementParserRegistry(parsers);
  const verifier = new StatementVerificationService(registry, new NullQrVerifier());
  const text = new StatementTextService(undefined, {});

  const recalc = new RecalculationService(repo, settingsProvider, classifier, dti, suspicionCounter, clock);
  const analysis = new AnalysisService(repo, settingsProvider, objects, recalc);
  const upload = new UploadService(repo, settingsProvider, objects, queue, clock);
  const pipeline = new ImportPipelineService(repo, settingsProvider, objects, cipher, publisher, text, registry, verifier, recalc, options, clock);
  const processor = new ImportProcessor(pipeline, queue);
  const reclassify = new ReclassifyService(repo, classifier, recalc, clock);
  const finalize = new FinalizeService(repo, settingsProvider, recalc, suspicionCounter, clock);
  const retention = new RetentionService(repo, settingsProvider, objects, options, clock);
  if (opts.startWorker !== false) await processor.start();

  return {
    clock, settings, memory, repo, store, objects, publisher, queue, cipher, suspicion, queueLog, options,
    analysis, upload, pipeline, processor, recalc, reclassify, finalize, retention,
    createAnalysis: (over = {}, ctx = OFFICER) =>
      analysis.create(ctx, {
        loanApplicationId: 'app-1',
        customerId: 'cust-1',
        borrowerId: 'bor-1',
        customer: { registerNo: CUSTOMER_REGISTER, lastName: 'Bat-Erdene', firstName: 'Bold' },
        periodMonths: 3,
        proposedMonthlyPayment: 500_000,
        ...over,
      }),
    uploadFiles: (analysisId, files, ctx = OFFICER, bankCode) =>
      upload.upload(ctx, analysisId, files.map((f) => ({ content: f.content, fileName: f.fileName, mimeType: f.mimeType, bankCode: bankCode ?? null }))),
    jobs: async (analysisId) => (await analysis.listJobs(ADMIN, analysisId)).items,
  };
}
