// BSA-FR-2.1 / 2.6: хуулгын файл хүлээн авах (олон файл, нэг дуудлагаар), давхардал шалгах, object store-д хадгалах, импортын ажил үүсгэж
// дараалалд оруулах + алдаатай ажлыг дахин оруулах.
//  - Файл бүр бие даан шийдэгдэнэ: ACCEPTED | DUPLICATE | REJECTED (файлын нэр буцаахгүй — индексээр).
//  - Дараалал: DB-д ажил COMMIT хийгдсэний ДАРАА enqueue (worker хараахан харагдаагүй мөрийг уншихаас сэргийлнэ).
//  - Файлын төрлийг ЗӨВХӨН бит (magic bytes)-ээр шийднэ; клиентийн MIME текст файлыг CSV/TEXT гэж ялгахад л нөлөөлнө.
//  - Object store-ийн түлхүүр нэр/PII агуулахгүй: `bsa/<orgId>/<analysisId>/<uuid>`.
import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { BankCode, type BsaUploadOutcome, type ImportFormat } from '@los/contracts';
import { describeError } from '../common/import-queue';
import { IMPORT_QUEUE, OBJECT_STORE, BSA_SETTINGS, type ImportQueue, type ObjectStore, type BsaSettingsProvider, type RequestContext } from '../common/infra.ports';
import { BSA_REPOSITORY, BsaDuplicateError, type BsaImportJobRecord, type BsaRepository } from '../common/persistence';
import { assertSystemCategories, ClassifierConfigError } from '../classify';
import { inspectFile } from '../parsers/text-extraction';
import { loadAnalysis } from './access';
import { BSA_CLOCK, type Clock } from './import.defaults';
import { BSA_EVENT } from './import.events';
import { badRequest, conflict, notFound, unavailable, unprocessable } from './import.errors';
import { pipelineIssue, UPLOAD_REJECT_MESSAGES, type UploadRejectCode } from './import.issues';
import { toJobView, type ImportJobView } from './views';

export interface UploadFileInput {
  content: Buffer;
  /** Клиентийн файлын нэр (PII байж болно): зөвхөн job.fileName-д хадгална, лог/event-д бичихгүй */
  fileName: string;
  /** Клиентийн MIME — шийдвэрлэгч биш (inspectFile) */
  mimeType?: string;
  /** Банкийг гараар сонгосон бол (автомат таних дарагдана) */
  bankCode?: BankCode | null;
}

export interface UploadResult {
  outcomes: BsaUploadOutcome[];
  accepted: number;
  duplicates: number;
  rejected: number;
}

/** Клиентийн файлын нэр: удирдлагын тэмдэгт хасч, уртыг хязгаарлана (хоосон бол 'unnamed'). Нэр PII байж болно — зөвхөн job.fileName-д */
function safeFileName(raw: unknown): string {
  // eslint-disable-next-line no-control-regex
  const clean = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255);
  return clean === '' ? 'unnamed' : clean;
}

const FORMAT_OF_KIND: Readonly<Record<string, ImportFormat>> = { PDF: 'PDF', IMAGE: 'IMAGE', CSV: 'CSV', TEXT: 'TEXT' };

@Injectable()
export class UploadService {
  private readonly log = new Logger(UploadService.name);

  constructor(
    @Inject(BSA_REPOSITORY) private readonly repo: BsaRepository,
    @Inject(BSA_SETTINGS) private readonly settingsProvider: BsaSettingsProvider,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(IMPORT_QUEUE) private readonly queue: ImportQueue,
    @Inject(BSA_CLOCK) private readonly clock: Clock,
  ) {}

  /** BSA-FR-2.1: нэг дуудлагад ≤ settings.maxFilesPerUpload файл. Зөвхөн DRAFT шинжилгээнд */
  async upload(ctx: RequestContext, analysisId: string, files: readonly UploadFileInput[]): Promise<UploadResult> {
    if (!Array.isArray(files) || files.length === 0) throw badRequest('NO_FILES');
    const analysis = await loadAnalysis(this.repo, ctx, analysisId, 'write');
    if (analysis.status !== 'DRAFT') throw conflict('ANALYSIS_NOT_DRAFT');
    const settings = await this.settingsProvider.get(analysis.orgId);
    if (files.length > settings.maxFilesPerUpload) throw badRequest('TOO_MANY_FILES', { max: settings.maxFilesPerUpload, received: files.length });
    // Ангиллын сан дутуу бол файлыг хадгалахаас өмнө тодорхой алдаа (импорт дунд нь унахгүй)
    try {
      assertSystemCategories(await this.repo.config.listCategories(analysis.orgId));
    } catch (e) {
      if (e instanceof ClassifierConfigError) throw unprocessable('CATALOG_INCOMPLETE');
      throw e;
    }

    const outcomes: BsaUploadOutcome[] = [];
    for (let index = 0; index < files.length; index++) {
      outcomes.push(await this.acceptOne(ctx, analysis.id, analysis.orgId, files[index], index, settings.maxUploadBytes));
    }
    return {
      outcomes,
      accepted: outcomes.filter((o) => o.status === 'ACCEPTED').length,
      duplicates: outcomes.filter((o) => o.status === 'DUPLICATE').length,
      rejected: outcomes.filter((o) => o.status === 'REJECTED').length,
    };
  }

  private reject(index: number, code: UploadRejectCode, jobId?: string): BsaUploadOutcome {
    return { index, status: 'REJECTED', code, message: UPLOAD_REJECT_MESSAGES[code], ...(jobId ? { jobId } : {}) };
  }

  private async acceptOne(
    ctx: RequestContext,
    analysisId: string,
    orgId: string,
    file: UploadFileInput,
    index: number,
    maxBytes: number,
  ): Promise<BsaUploadOutcome> {
    if (typeof file !== 'object' || file === null || !Buffer.isBuffer(file.content)) return this.reject(index, 'FILE_UNSUPPORTED');
    if (file.bankCode !== undefined && file.bankCode !== null && !(BankCode as readonly string[]).includes(file.bankCode)) {
      return this.reject(index, 'INVALID_BANK');
    }
    if (file.content.length === 0) return this.reject(index, 'FILE_EMPTY');
    if (file.content.length > maxBytes) return this.reject(index, 'FILE_TOO_LARGE');

    const inspected = inspectFile({ fileName: String(file.fileName ?? ''), mimeType: file.mimeType, content: file.content });
    if (inspected.kind === 'XLSX') return this.reject(index, 'XLSX_UNSUPPORTED');
    const format = FORMAT_OF_KIND[inspected.kind];
    if (!format) return this.reject(index, 'FILE_UNSUPPORTED');

    const sha256 = createHash('sha256').update(file.content).digest('hex');
    const existing = await this.repo.importJobs.findBySha256(analysisId, sha256);
    if (existing) return { index, status: 'DUPLICATE', existingJobId: existing.id };

    const key = `bsa/${orgId}/${analysisId}/${randomUUID()}`;
    try {
      await this.store.put(key, file.content, inspected.mimeType);
    } catch (e) {
      this.log.warn(`object put failed (${describeError(e)})`);
      return this.reject(index, 'STORAGE_FAILED');
    }

    let job: BsaImportJobRecord;
    try {
      job = await this.repo.runInTransaction(async (r) => {
        const created = await r.importJobs.create({
          analysisId,
          fileId: key,
          fileName: safeFileName(file.fileName),
          mimeType: inspected.mimeType,
          sizeBytes: file.content.length,
          sha256,
          format,
          bankCode: file.bankCode ?? null,
          createdBy: ctx.userId,
        });
        await r.events.append({
          analysisId,
          action: BSA_EVENT.FILE_UPLOADED,
          actorId: ctx.userId,
          at: this.clock.now(),
          detail: { jobId: created.id, format, sizeBytes: file.content.length, bankOverride: file.bankCode ?? null },
        });
        return created;
      });
    } catch (e) {
      await this.discardObject(key);
      // Зэрэгцээ ижил файл: нөгөө нь түрүүлж commit хийсэн. PostgreSQL-ийн unique зөрчил (P2002) existingId-гүй ирдэг тул
      // таслагдсан транзакцийн ГАДНА sha256-аар дахин хайна (BSA-FR-2.2)
      if (e instanceof BsaDuplicateError) {
        const winner = e.existingId ? { id: e.existingId } : await this.findWinner(analysisId, sha256);
        if (winner) return { index, status: 'DUPLICATE', existingJobId: winner.id };
      }
      this.log.warn(`import job create failed (${describeError(e)})`);
      return this.reject(index, 'INTERNAL_ERROR');
    }

    const queued = await this.enqueueOrFail(analysisId, job.id, ctx.userId);
    if (!queued) return this.reject(index, 'QUEUE_UNAVAILABLE', job.id);
    return { index, status: 'ACCEPTED', jobId: job.id, format };
  }

  /** Зэрэгцээ оруулсан ижил файлын ажил. Хайлт өөрөө унавал (дэд бүтцийн алдаа) null — дуудагч INTERNAL_ERROR болгоно */
  private async findWinner(analysisId: string, sha256: string): Promise<{ id: string } | null> {
    try {
      return await this.repo.importJobs.findBySha256(analysisId, sha256);
    } catch (e) {
      this.log.warn(`duplicate lookup failed (${describeError(e)})`);
      return null;
    }
  }

  /** DB commit-ийн дараа дараалалд оруулна. Амжилтгүй бол ажлыг FAILED болгоно (хэрэглэгч retryJob хийнэ) */
  private async enqueueOrFail(analysisId: string, jobId: string, actorId: string | null): Promise<boolean> {
    try {
      await this.queue.enqueue(jobId);
      return true;
    } catch (e) {
      this.log.warn(`enqueue failed (${describeError(e)})`);
      try {
        await this.repo.runInTransaction(async (r) => {
          await r.importJobs.update(
            jobId,
            { status: 'FAILED', errors: [pipelineIssue('QUEUE_UNAVAILABLE')], finishedAt: this.clock.now() },
            actorId,
          );
          await r.events.append({ analysisId, action: BSA_EVENT.IMPORT_FAILED, actorId, at: this.clock.now(), detail: { jobId, codes: ['QUEUE_UNAVAILABLE'] } });
        });
      } catch (inner) {
        this.log.error(`could not mark job failed after enqueue failure (${describeError(inner)})`);
      }
      return false;
    }
  }

  private async discardObject(key: string): Promise<void> {
    try {
      await this.store.delete(key);
    } catch (e) {
      this.log.warn(`orphan object cleanup failed (${describeError(e)})`);
    }
  }

  /**
   * BSA-FR-2.6 «дахин оруулах»: FAILED ажлыг PENDING болгож дахин дараалалд оруулна (ижил файл). Банкийг гараар солих боломжтой
   * (BANK_NOT_DETECTED / BANK_AMBIGUOUS-ийн дараа). Зөвхөн DRAFT шинжилгээнд.
   */
  async retryJob(ctx: RequestContext, analysisId: string, jobId: string, options: { bankCode?: BankCode | null } = {}): Promise<ImportJobView> {
    if (options.bankCode !== undefined && options.bankCode !== null && !(BankCode as readonly string[]).includes(options.bankCode)) {
      throw badRequest('INVALID_REQUEST', { issues: ['bankCode: invalid_enum_value'] });
    }
    const reset = await this.repo.runInTransaction(async (r) => {
      const analysis = await loadAnalysis(r, ctx, analysisId, 'write');
      if (analysis.status !== 'DRAFT') throw conflict('ANALYSIS_NOT_DRAFT');
      const job = await r.importJobs.getById(jobId, { orgId: ctx.orgId });
      if (!job || job.analysisId !== analysisId) throw notFound('JOB_NOT_FOUND');
      if (job.status !== 'FAILED') throw conflict('JOB_NOT_RETRYABLE', { status: job.status });
      await r.transactions.deleteByJob(jobId); // FAILED ажилд мөр байх ёсгүй; аюулгүйн үүднээс
      const updated = await r.importJobs.update(
        jobId,
        {
          status: 'PENDING',
          errors: [],
          warnings: [],
          rowsTotal: 0,
          rowsDone: 0,
          parserOk: null,
          verifierOk: null,
          qrVerified: null,
          attempts: 0,
          startedAt: null,
          finishedAt: null,
          ...(options.bankCode !== undefined ? { bankCode: options.bankCode } : {}),
        },
        ctx.userId,
      );
      await r.events.append({
        analysisId,
        action: BSA_EVENT.JOB_RETRY_REQUESTED,
        actorId: ctx.userId,
        at: this.clock.now(),
        detail: { jobId, bankOverride: options.bankCode ?? null },
      });
      return updated;
    });
    const queued = await this.enqueueOrFail(analysisId, jobId, ctx.userId);
    if (!queued) throw unavailable('QUEUE_UNAVAILABLE');
    const latest = (await this.repo.importJobs.getById(reset.id, { orgId: ctx.orgId })) ?? reset;
    return toJobView(latest);
  }
}
