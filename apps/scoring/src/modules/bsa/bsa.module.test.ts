// Nest DI: decorator metadata-гүй (esbuild/vitest) орчинд ч BsaModule-ийн БҮХ service `@Inject`-ээр шийдэгдэх ёстой. Дэд бүтэц
// (repository, object store, queue, publisher, cipher, OCR) in-memory/stub-аар солигдоно; жинхэнэ Postgres/Redis/MinIO шаардахгүй.
import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { MockOcrProvider } from '@los/ocr';
import { afterEach, describe, expect, it } from 'vitest';
import { ClassifierService } from './classify';
import { InMemoryEventPublisher } from './common/event-publisher';
import { InlineImportQueue } from './common/import-queue';
import { BSA_SETTINGS, EVENT_PUBLISHER, IMPORT_QUEUE, OBJECT_STORE, PII_CIPHER } from './common/infra.ports';
import { InMemoryObjectStore } from './common/object-store';
import { BSA_REPOSITORY, InMemoryBsaRepository } from './common/persistence';
import { PrismaService } from './common/persistence/prisma.service';
import { TestPiiCipher } from './common/persistence/testing/test-pii-cipher';
import { DtiAnalysisService } from './dti';
import { DEFAULT_BSA_CATEGORIES, DEFAULT_BSA_RULES } from './classify';
import { TEST_SETTINGS } from './dti/testing/fixtures';
import { BsaModule } from './bsa.module';
import {
  AnalysisService, BSA_CLOCK, BSA_IMPORT_OPTIONS, FinalizeService, ImportPipelineService, ImportProcessor, NullSuspicionCounter, RecalculationService,
  ReclassifyService, RetentionService, SUSPICION_COUNTER, UploadService, type ImportOptions, type SuspicionCounter,
} from './import';
import { OCR_PROVIDER, StatementTextService } from './parsers/text-extraction';
import { StatementParserRegistry } from './parsers/parser.registry';
import { StatementVerificationService } from './parsers/verifier/statement-verification.service';
import { OFFICER } from './import/testing/harness';
import { happyFiles } from './import/testing/scenario';

const SERVICES = [
  AnalysisService, UploadService, ImportPipelineService, ImportProcessor, RecalculationService, ReclassifyService, FinalizeService, RetentionService,
] as const;

const PRISMA_STUB = { onModuleInit: async (): Promise<void> => undefined, onModuleDestroy: async (): Promise<void> => undefined };

function build(extra: Parameters<typeof Test.createTestingModule>[0]['imports'] = [BsaModule]) {
  const memory = new InMemoryBsaRepository({ cipher: new TestPiiCipher() });
  memory.seedConfig(OFFICER.orgId, { categories: DEFAULT_BSA_CATEGORIES, rules: DEFAULT_BSA_RULES });
  const queue = new InlineImportQueue({ mode: 'sync', logger: { warn: () => undefined, error: () => undefined } });
  const publisher = new InMemoryEventPublisher();
  const store = new InMemoryObjectStore();
  const builder = Test.createTestingModule({ imports: extra })
    .overrideProvider(PII_CIPHER).useValue(new TestPiiCipher())
    .overrideProvider(OBJECT_STORE).useValue(store)
    .overrideProvider(EVENT_PUBLISHER).useValue(publisher)
    .overrideProvider(IMPORT_QUEUE).useValue(queue)
    .overrideProvider(BSA_SETTINGS).useValue({ get: async () => ({ ...TEST_SETTINGS, minStatementMonths: 3 }) })
    .overrideProvider(BSA_REPOSITORY).useValue(memory)
    .overrideProvider(OCR_PROVIDER).useValue(new MockOcrProvider({ builtins: false, byFileName: [], bySha256: {} }))
    .overrideProvider(PrismaService).useValue(PRISMA_STUB);
  return { builder, memory, queue, publisher, store };
}

let current: TestingModule | null = null;
afterEach(async () => {
  await current?.close();
  current = null;
});

describe('BsaModule dependency injection', () => {
  it('resolves every application service (all constructor parameters carry an explicit @Inject)', async () => {
    const { builder } = build();
    current = await builder.compile();
    for (const service of SERVICES) {
      const instance = current.get(service);
      expect(instance, service.name).toBeInstanceOf(service);
      // @Inject-гүй параметрийг Nest алдаагүй `undefined` болгож өгч болдог (метадата байхгүй үед) ⇒ талбар бүр утгатай эсэхийг шалгана
      const missing = Object.entries(instance).filter(([, value]) => value === undefined).map(([key]) => key);
      expect(missing, `${service.name} has undefined dependencies`).toEqual([]);
    }
    // Модулиас экспортлогдсон дэд хамаарал
    expect(current.get(ClassifierService, { strict: false })).toBeInstanceOf(ClassifierService);
    expect(current.get(DtiAnalysisService, { strict: false })).toBeInstanceOf(DtiAnalysisService);
    expect(current.get(StatementTextService, { strict: false })).toBeInstanceOf(StatementTextService);
    expect(current.get(StatementParserRegistry, { strict: false }).banks().sort()).toEqual(['CAPITRON', 'GOLOMT', 'KHAN', 'MBANK', 'STATE', 'TDB', 'XAC']);
    expect(current.get(StatementVerificationService, { strict: false })).toBeDefined();
  });

  it('provides the default options, the system clock and a null suspicion counter', async () => {
    const { builder } = build();
    current = await builder.compile();
    const options = current.get<ImportOptions>(BSA_IMPORT_OPTIONS, { strict: false });
    expect(options).toMatchObject({ maxRowsPerFile: 50_000, retentionIntervalMs: 0 });
    expect(current.get<{ now(): Date }>(BSA_CLOCK, { strict: false }).now()).toBeInstanceOf(Date);
    const counter = current.get<SuspicionCounter>(SUSPICION_COUNTER, { strict: false });
    expect(counter).toBeInstanceOf(NullSuspicionCounter);
    await expect(counter.countPending('org-1', 'a1')).resolves.toBe(0);
  });

  it('BsaModule.register({ suspicionCounter }) replaces the default counter', async () => {
    @Injectable()
    class FakeCounter implements SuspicionCounter {
      async countPending(): Promise<number> {
        return 7;
      }
    }
    const { builder } = build([BsaModule.register({ suspicionCounter: FakeCounter })]);
    current = await builder.compile();
    expect(current.get<SuspicionCounter>(SUSPICION_COUNTER, { strict: false })).toBeInstanceOf(FakeCounter);
  });

  it('starts the import worker on init and runs an upload end to end through the wired services', async () => {
    const { builder, memory, queue } = build();
    current = await builder.compile();
    await current.init(); // ImportProcessor.onModuleInit → queue.start; PrismaService stub-аар солигдсон тул DB холболтгүй
    const analysis = await current.get(AnalysisService).create(OFFICER, {
      loanApplicationId: 'app-1', customerId: 'cust-1', borrowerId: 'bor-1',
      customer: { registerNo: 'УБ90010203', lastName: 'Bat-Erdene', firstName: 'Bold' },
      periodMonths: 3, proposedMonthlyPayment: 500_000,
    });
    const { a } = await happyFiles();
    const res = await current.get(UploadService).upload(OFFICER, analysis.id, [{ content: a.content, fileName: a.fileName, mimeType: a.mimeType }]);
    expect(res.accepted).toBe(1);
    const [job] = (await current.get(AnalysisService).listJobs(OFFICER, analysis.id)).items;
    expect(job.status).toBe('COMPLETED');
    const summary = (await current.get(AnalysisService).get(OFFICER, analysis.id)).summary;
    expect(summary?.transactionCount).toBe(18);
    // Бүх service бодит хамаарлаараа ажиллана: reclassify + finalize + scoring оролт + retention
    const rows = await memory.transactions.loadAll(analysis.id);
    const salary = rows.find((r) => r.description.startsWith('Цалин'));
    await current.get(ReclassifyService).reclassify(OFFICER, analysis.id, { transactionIds: [salary!.id], categoryCode: 'CONTRACT_INCOME' });
    const pushed = await current.get(FinalizeService).finalize(OFFICER, analysis.id);
    expect(pushed.summary.status).toBe('ANALYZED');
    expect((await current.get(FinalizeService).toScoringInput(OFFICER, analysis.id)).status).toBe('ANALYZED');
    expect((await current.get(RecalculationService).report(OFFICER, analysis.id)).summaryStale).toBe(false);
    expect(await current.get(RetentionService).purgeExpired()).toMatchObject({ purged: 0 });
    // Модуль хаагдахад queue хаагдана (дараагийн enqueue татгалзана)
    await current.close();
    current = null;
    await expect(queue.enqueue('later-job')).rejects.toMatchObject({ code: 'CLOSED' });
  });
});
