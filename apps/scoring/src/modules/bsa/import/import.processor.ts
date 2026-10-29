// Дарааллын worker: IMPORT_QUEUE-ээс ирсэн jobId бүрийг ImportPipelineService-д өгнө. NFR-8: ажил алдагдахгүй, дахин оролдоно.
//
// Queue-тэй гэрээ:
//  - Pipeline ТҮР/гэнэтийн алдаа шидвэл queue өөрийн backoff-оор дахин оролдоно (handler-ээс шууд шидэгдэнэ).
//  - Ажил FAILED болсон (тодорхой алдаа, эсвэл эцсийн оролдлого) үед handler `UnrecoverableError` нэртэй алдаа шидэнэ:
//    BullMQ ийм алдаатай ажлыг дахин оролдохгүй, 'failed' төлөвт оруулна → хэрэглэгч «дахин оруулах» (UploadService.retryJob) үед
//    BullMQ 'failed' ажлыг устгаад шинээр нэмнэ. ('completed' төлөвтэй ажил jobId-аараа дахин нэмэгдэхгүй тул FAILED-ийг амжилт гэж ХЭЗЭЭ Ч буцаахгүй.)
//    Inline queue-д мөн ижил: эцэст нь 'failed' болж дахин оруулах боломжтой.
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { AttemptAwareImportQueue, ImportJobAttempt, ImportJobHandler } from '../common/import-queue';
import { IMPORT_QUEUE } from '../common/infra.ports';
import { ImportPipelineService, type PipelineOutcome } from './import-pipeline.service';

/** BullMQ `err.name == 'UnrecoverableError'`-ийг таньж дахин оролдохгүй. Мессежид зөвхөн алдааны кодууд (PII-гүй) */
export class ImportJobFailedError extends Error {
  constructor(readonly jobId: string, readonly codes: readonly string[]) {
    super(`import job failed: ${codes.join(',') || 'UNKNOWN'}`);
    this.name = 'UnrecoverableError';
  }
}

/** Queue attempt-aware биш (info өгөхгүй) бол эцсийн оролдлого гэж ТООЦООГҮЙ — ажлыг дундаас нь FAILED болгохгүй */
const UNKNOWN_ATTEMPT: ImportJobAttempt = { attempt: 1, attempts: 1, isLastAttempt: false };

@Injectable()
export class ImportProcessor implements OnModuleInit {
  private readonly log = new Logger(ImportProcessor.name);

  constructor(
    @Inject(ImportPipelineService) private readonly pipeline: ImportPipelineService,
    @Inject(IMPORT_QUEUE) private readonly queue: AttemptAwareImportQueue,
  ) {}

  /** Queue handler. Тестэд шууд дуудаж болно */
  readonly handle: ImportJobHandler = async (jobId, info) => {
    const outcome = await this.pipeline.processJob(jobId, info ?? UNKNOWN_ATTEMPT);
    this.assertNotFailed(outcome);
  };

  private assertNotFailed(outcome: PipelineOutcome): void {
    if (outcome.kind === 'FAILED') throw new ImportJobFailedError(outcome.jobId, outcome.codes);
    if (outcome.kind === 'SKIPPED' && outcome.reason === 'ALREADY_FAILED') throw new ImportJobFailedError(outcome.jobId, []);
  }

  /** Worker эхлүүлнэ. Redis байхгүй бол тодорхой алдаа app асахад (REDIS_UNAVAILABLE) гарна */
  async onModuleInit(): Promise<void> {
    await this.start();
  }

  async start(): Promise<void> {
    await this.queue.start(this.handle);
    this.log.log('import worker started');
  }
}
