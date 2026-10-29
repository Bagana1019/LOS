// BSA-FR-2.2 / 2.3 / 2.4 / 3.1 / 3.2 / 4: нэг импортын ажлын бүтэн гүйцэтгэл — файл → текст → parser → verifier → гүйлгээ хадгалах →
// өөрийн данс нэмэх → бүх гүйлгээг дахин ангилах → DTI дахин тооцоолох → ажил COMPLETED + StatementImported event.
//
// Алдааны ангилал (queue-ийн дахин оролдлоготой уялдана):
//  - ТОДОРХОЙ (deterministic) алдаа — ижил файл дахин оролдоход ижил үр дүн: ажил FAILED (мөр хадгалагдахгүй), дахин оролдохгүй.
//    Үүнд verifier ERROR, банк танигдаагүй, PDF нууцлагдсан, мөр хэт олон, хугацаа хэтэрсэн гэх мэт.
//  - ТҮР (transient)/гэнэтийн алдаа — дахин шидэж queue дахин оролдуулна; ЭЦСИЙН оролдлого дээр ажил INTERNAL_ERROR-оор FAILED.
//  - Импортын бичилт бүгд НЭГ транзакцид: мөр, өөрийн данс, ажлын төлөв, ангилал, DTI, түүх, outbox event. Дунд нь унавал юу ч үлдэхгүй.
// АНХААР (PII): алдааны мессеж, лог, event, түүхэнд файлын нэр/агуулга/нэр/данс орохгүй (import.issues.ts). Лог дээр зөвхөн алдааны класс/код.
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { BankCode } from '@los/contracts';
import { describeError } from '../common/import-queue';
import { buildStatementImportedEvent } from '../common/event-publisher';
import {
  BSA_SETTINGS, EVENT_PUBLISHER, OBJECT_STORE, PII_CIPHER,
  type BsaSettingsProvider, type DomainEventPublisher, type ObjectStore, type PiiCipher,
} from '../common/infra.ports';
import { ObjectStoreError } from '../common/object-store';
import {
  accountKeyOf, buildDedupeKeys, BSA_REPOSITORY, BsaInvalidError, BsaNotFoundError, MAX_PAGE_SIZE,
  type BsaAnalysisRecord, type BsaImportJobPatch, type BsaImportJobRecord, type BsaRepository, type ImportIssue, type NewBsaTransaction,
} from '../common/persistence';
import { assertSystemCategories, ClassifierConfigError, collectAccountsFromStatements, matchOwnAccount, ownAccountKeys } from '../classify';
import {
  AmbiguousBankError, StatementParserRegistry, StatementVerificationService, UnsupportedBankError,
  type ParsedStatement, type StatementText,
} from '../parsers';
import { isStatementExtractionError, StatementTextService } from '../parsers/text-extraction';
import { BSA_CLOCK, BSA_IMPORT_OPTIONS, type Clock, type ImportOptions } from './import.defaults';
import { BSA_EVENT } from './import.events';
import { BsaException } from './import.errors';
import {
  ambiguousBankIssue, extractionIssue, issue, parseWarningIssues, PIPELINE_MESSAGES, pipelineIssue, tooManyRowsIssue, verificationIssues,
  VERIFICATION_MESSAGES,
} from './import.issues';
import { RecalculationService } from './recalculation.service';
import { Deadline, ImportTimeoutError, withTimeout } from './timeout';

/** Queue-ийн оролдлогын мэдээлэл (common/import-queue.ts-ийн ImportJobAttempt-тэй ижил хэлбэр) */
export interface AttemptInfo {
  attempt: number;
  attempts: number;
  isLastAttempt: boolean;
}

export type PipelineOutcome =
  | { kind: 'COMPLETED'; jobId: string; inserted: number; skipped: number; reclassified: number }
  | { kind: 'FAILED'; jobId: string; codes: string[] }
  | { kind: 'SKIPPED'; jobId: string; reason: 'NOT_FOUND' | 'ALREADY_COMPLETED' | 'ALREADY_FAILED' };

/** Тодорхой (дахин оролдоход өөрчлөгдөхгүй) алдаа: ажлыг шууд FAILED болгоно */
class DeterministicFailure extends Error {
  constructor(readonly errors: ImportIssue[], readonly patch: BsaImportJobPatch = {}, readonly warnings: ImportIssue[] = []) {
    super(`deterministic import failure: ${errors.map((e) => e.code).join(',')}`);
    this.name = 'DeterministicFailure';
  }
}

/** OCR хөдөлгүүр түр унасан/хугацаа хэтэрсэн ⇒ дахин оролдоно (бусад OCR_FAILED нь тухайн зурагт тодорхой) */
const isTransientExtraction = (detail: string | undefined): boolean => detail !== undefined && /ENGINE_UNAVAILABLE|TIMEOUT/.test(detail);

const nameVariants = (analysis: BsaAnalysisRecord): string[] => {
  const c = analysis.customer;
  if (!c) return [];
  const out = new Set<string>();
  const last = c.lastName?.trim() ?? '';
  const first = c.firstName?.trim() ?? '';
  if (last && first) {
    out.add(`${last} ${first}`);
    out.add(`${first} ${last}`);
  } else if (last || first) out.add(last || first);
  return [...out];
};

const normId = (v: string | null | undefined): string => (v ?? '').replace(/\s+/g, '').toUpperCase();

@Injectable()
export class ImportPipelineService {
  private readonly log = new Logger(ImportPipelineService.name);

  constructor(
    @Inject(BSA_REPOSITORY) private readonly repo: BsaRepository,
    @Inject(BSA_SETTINGS) private readonly settingsProvider: BsaSettingsProvider,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(PII_CIPHER) private readonly cipher: PiiCipher,
    @Inject(EVENT_PUBLISHER) private readonly publisher: DomainEventPublisher,
    @Inject(StatementTextService) private readonly textService: StatementTextService,
    @Inject(StatementParserRegistry) private readonly registry: StatementParserRegistry,
    @Inject(StatementVerificationService) private readonly verifier: StatementVerificationService,
    @Inject(RecalculationService) private readonly recalc: RecalculationService,
    @Inject(BSA_IMPORT_OPTIONS) private readonly options: ImportOptions,
    @Inject(BSA_CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Нэг ажлыг боловсруулна. Идемпотент: COMPLETED / FAILED ажил, эсвэл олдохгүй ажил/шинжилгээ ⇒ юу ч хийхгүй (SKIPPED).
   * PENDING / PROCESSING ажлыг (stalled redelivery) дахин ажиллуулна — транзакц атомар тул аюулгүй.
   * Тодорхой алдаа ⇒ FAILED буцаана (шидэхгүй). Түр алдаа ⇒ шидэнэ (queue дахин оролдоно), эцсийн оролдлого дээр INTERNAL_ERROR.
   */
  async processJob(jobId: string, info: AttemptInfo): Promise<PipelineOutcome> {
    const job = await this.repo.importJobs.getById(jobId);
    if (!job) return { kind: 'SKIPPED', jobId, reason: 'NOT_FOUND' };
    if (job.status === 'COMPLETED') return { kind: 'SKIPPED', jobId, reason: 'ALREADY_COMPLETED' };
    if (job.status === 'FAILED') return { kind: 'SKIPPED', jobId, reason: 'ALREADY_FAILED' };
    const analysis = await this.repo.analyses.getById(job.analysisId);
    if (!analysis) return { kind: 'SKIPPED', jobId, reason: 'NOT_FOUND' };

    try {
      return await this.run(job, analysis, info);
    } catch (e) {
      if (e instanceof DeterministicFailure) return this.fail(job, analysis, e.errors, e.warnings, e.patch);
      // Алхам хоорондын нийт хугацааны шалгалт: дахин оролдвол ижил хугацаа зарцуулах тул автоматаар давтахгүй (хэрэглэгч гараар дахин оруулна)
      if (e instanceof ImportTimeoutError) return this.fail(job, analysis, [pipelineIssue('IMPORT_TIMEOUT')], [], {});
      if (e instanceof BsaNotFoundError) return { kind: 'SKIPPED', jobId, reason: 'NOT_FOUND' }; // ажил/шинжилгээ процессын явцад устгагдсан
      this.log.warn(`import job ${jobId} attempt ${info.attempt}/${info.attempts} failed (${describeError(e)})`);
      if (!info.isLastAttempt) throw e;
      return this.fail(job, analysis, [pipelineIssue('INTERNAL_ERROR')], [], {});
    }
  }

  // ───────────────────────── Үндсэн дараалал ─────────────────────────

  private async run(job: BsaImportJobRecord, analysis: BsaAnalysisRecord, info: AttemptInfo): Promise<PipelineOutcome> {
    const deadline = new Deadline(this.options.jobTimeoutMs);
    if (analysis.status !== 'DRAFT') throw new DeterministicFailure([pipelineIssue('ANALYSIS_LOCKED')]);

    await this.repo.importJobs.update(job.id, {
      status: 'PROCESSING',
      attempts: info.attempt,
      startedAt: job.startedAt ?? this.clock.now(),
      finishedAt: null,
    });
    const settings = await this.settingsProvider.get(analysis.orgId);
    try {
      assertSystemCategories(await this.repo.config.listCategories(analysis.orgId));
    } catch (e) {
      if (e instanceof ClassifierConfigError) throw new DeterministicFailure([pipelineIssue('CATALOG_INCOMPLETE')]);
      throw e;
    }

    const content = await this.readFile(job);
    deadline.check('read');
    const text = await this.extract(job, content);
    deadline.check('extract');
    const parsed = this.parse(text, job.bankCode);
    deadline.check('parse');

    // Хамгаалалт: хэт олон мөр (санах ой, DB)
    const rowCount = parsed.transactions.length;
    const own = collectAccountsFromStatements([parsed])[0] ?? null;
    const period = this.statementPeriod(parsed);
    const base: BsaImportJobPatch = {
      bankCode: parsed.bank,
      accountNo: own?.accountNo ?? null,
      iban: own?.iban ?? null,
      holderName: parsed.holderName ? parsed.holderName.slice(0, 256) : null,
      periodFrom: period.from,
      periodTo: period.to,
      rowsTotal: rowCount,
    };
    if (rowCount > this.options.maxRowsPerFile) throw new DeterministicFailure([tooManyRowsIssue(this.options.maxRowsPerFile)], base);

    const verification = await this.verifier.verify(parsed, text.meta, {
      balanceTolerance: settings.balanceTolerance,
      customer: { names: nameVariants(analysis), registerNo: analysis.customer?.registerNo ?? null },
    });
    deadline.check('verify');
    const found = verificationIssues(verification.issues, { declared: parsed.declaredRowCount, read: rowCount });
    const errors = found.filter((i) => i.severity === 'ERROR');
    const warnings = [...found.filter((i) => i.severity !== 'ERROR'), ...parseWarningIssues(parsed.warnings)];
    const checked: BsaImportJobPatch = { ...base, parserOk: verification.parserOk, verifierOk: verification.verifierOk, qrVerified: verification.qrVerified };

    if (!verification.verifierOk || rowCount === 0) {
      const failures = errors.length > 0 ? errors : [issue('NO_TRANSACTIONS', VERIFICATION_MESSAGES.NO_TRANSACTIONS, { severity: 'ERROR' })];
      throw new DeterministicFailure(failures, checked, warnings);
    }
    if (own === null) warnings.push(pipelineIssue('ACCOUNT_NOT_IDENTIFIED', 'WARNING'));
    if (parsed.holderName === null && !parsed.holderRegisterNo) warnings.push(pipelineIssue('HOLDER_UNVERIFIED', 'WARNING'));

    // Явц: мөрийн тоо, банк (транзакцийн гадна — хэрэглэгч шууд харна)
    await this.repo.importJobs.update(job.id, { bankCode: parsed.bank, rowsTotal: rowCount });
    deadline.check('persist');

    const statementKey = await this.statementKeyFor(job, analysis, own);
    const dedupeKeys = buildDedupeKeys(statementKey, parsed.transactions, (v) => this.cipher.hash(v));
    const rows: NewBsaTransaction[] = parsed.transactions.map((t, i) => ({
      seq: t.seq,
      txnDate: t.txnDate,
      txnTime: t.txnTime,
      direction: t.direction,
      amount: t.amount,
      balanceAfter: t.balanceAfter,
      description: t.description,
      counterpartyAccount: t.counterpartyAccount,
      counterpartyName: t.counterpartyName,
      statementKey,
      dedupeKey: dedupeKeys[i],
    }));

    return this.commit(job, analysis, rows, own, checked, warnings);
  }

  /** Хуулгын хугацаа: parser-ийн хугацаа, байхгүй бол гүйлгээний огнооны хамгийн бага/их. Эргэсэн бол null (persistence татгалзана) */
  private statementPeriod(parsed: ParsedStatement): { from: string | null; to: string | null } {
    let from = parsed.periodFrom;
    let to = parsed.periodTo;
    if ((from === null || to === null) && parsed.transactions.length > 0) {
      const dates = parsed.transactions.map((t) => t.txnDate).sort();
      from ??= dates[0];
      to ??= dates[dates.length - 1];
    }
    return from !== null && to !== null && from > to ? { from: null, to: null } : { from, to };
  }

  private async readFile(job: BsaImportJobRecord): Promise<Buffer> {
    try {
      return await this.store.get(job.fileId);
    } catch (e) {
      if (e instanceof ObjectStoreError && e.code === 'NOT_FOUND') throw new DeterministicFailure([pipelineIssue('FILE_MISSING')]);
      throw e;
    }
  }

  private async extract(job: BsaImportJobRecord, content: Buffer): Promise<StatementText> {
    try {
      return await withTimeout(
        this.textService.extract({ fileName: job.fileName, mimeType: job.mimeType, content }),
        this.options.extractTimeoutMs,
        'extract',
      );
    } catch (e) {
      if (e instanceof ImportTimeoutError) throw new DeterministicFailure([pipelineIssue('IMPORT_TIMEOUT')]);
      if (isStatementExtractionError(e)) {
        if (isTransientExtraction(e.detail)) throw e;
        throw new DeterministicFailure([extractionIssue(e)]);
      }
      throw e;
    }
  }

  private parse(text: StatementText, bank: string | null): ParsedStatement {
    try {
      return this.registry.parse(text, (bank ?? undefined) as BankCode | undefined);
    } catch (e) {
      if (e instanceof UnsupportedBankError) throw new DeterministicFailure([pipelineIssue('BANK_NOT_DETECTED')]);
      if (e instanceof AmbiguousBankError) throw new DeterministicFailure([ambiguousBankIssue(e.candidates)]);
      throw e;
    }
  }

  // ───────────────────────── Дансны таних түлхүүр ─────────────────────────

  /**
   * statementKey = hash(данс). Нэг данс файл бүрт ижил түлхүүртэй байх ёстой (давхцсан хуулгын dedupe, own-transfer хос).
   * Хуулга дансны дугаартай, нөгөө нь зөвхөн IBAN-тай байж болох тул: аль хэдийн COMPLETED ажлын данс/IBAN-тай (IBAN-ы сүүлийн цифрээр)
   * таарвал ТЭР ажлын таних тэмдгийг ашиглана. Данс огт олдохгүй бол ажил бүр өөрийн түлхүүртэй (давхар мөрийг файл дотор л шалгана).
   */
  private async statementKeyFor(job: BsaImportJobRecord, analysis: BsaAnalysisRecord, own: { accountNo: string | null; iban: string | null } | null): Promise<string> {
    const ids = [own?.accountNo, own?.iban].map(normId).filter((v) => v !== '');
    if (ids.length === 0) return accountKeyOf(`JOB:${job.id}`, (v) => this.cipher.hash(v));
    const others = await this.completedJobs(analysis.id, job.id);
    for (const other of others) {
      const otherIds = [other.accountNo, other.iban].map(normId).filter((v) => v !== '');
      const same = ids.some((a) => otherIds.some((b) => a === b || matchOwnAccount(a, [b]) === 'EXACT' || matchOwnAccount(b, [a]) === 'EXACT'));
      if (same) return accountKeyOf(otherIds[0], (v) => this.cipher.hash(v));
    }
    return accountKeyOf(ids[0], (v) => this.cipher.hash(v));
  }

  private async completedJobs(analysisId: string, exceptJobId: string): Promise<BsaImportJobRecord[]> {
    const all: BsaImportJobRecord[] = [];
    for (let offset = 0; ; offset += MAX_PAGE_SIZE) {
      const page = await this.repo.importJobs.list({ analysisId, status: 'COMPLETED' }, { limit: MAX_PAGE_SIZE, offset });
      all.push(...page.items);
      if (offset + page.items.length >= page.total || page.items.length === 0) break;
    }
    return all.filter((j) => j.id !== exceptJobId).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
  }

  // ───────────────────────── Нэг транзакц ─────────────────────────

  private async commit(
    job: BsaImportJobRecord,
    analysis: BsaAnalysisRecord,
    rows: readonly NewBsaTransaction[],
    own: { accountNo: string | null; iban: string | null; bank: string; holderName: string | null } | null,
    patch: BsaImportJobPatch,
    warnings: ImportIssue[],
  ): Promise<PipelineOutcome> {
    let result: { inserted: number; skipped: number; reclassified: number } | 'SKIPPED';
    try {
      result = await this.repo.runInTransaction(async (r, tx) => {
        const current = await r.importJobs.getById(job.id);
        if (!current) throw new BsaNotFoundError('import_job', job.id);
        if (current.status === 'COMPLETED' || current.status === 'FAILED') return 'SKIPPED' as const; // зэрэгцээ давхар хүргэлт

        let inserted = 0;
        let skipped = 0;
        const chunk = this.options.insertChunkRows;
        for (let offset = 0; offset < rows.length; offset += chunk) {
          const part = rows.slice(offset, offset + chunk);
          const res = await r.transactions.bulkInsert(job.id, part, null);
          inserted += res.inserted;
          skipped += res.skipped;
          await r.importJobs.incrementRowsDone(job.id, part.length); // NFR-1: явц мөрөөр
        }
        // BSA-BR-5: хуулгаас уншсан данс/IBAN-ыг өөрийн дансанд нэмнэ (verifier-ээр баталгаажсан хуулга)
        if (own !== null) {
          const keys = ownAccountKeys([{ bank: own.bank, accountNo: own.accountNo, iban: own.iban, holderName: own.holderName }]);
          if (keys.length > 0) await r.analyses.addOwnAccounts(analysis.id, keys, null);
        }
        const allWarnings =
          skipped > 0 ? [...warnings, pipelineIssue('ROWS_SKIPPED_DUPLICATE', 'WARNING', `${PIPELINE_MESSAGES.ROWS_SKIPPED_DUPLICATE} (${skipped} мөр)`)] : warnings;
        await r.importJobs.update(job.id, {
          ...patch,
          status: 'COMPLETED',
          errors: [],
          warnings: allWarnings,
          rowsDone: rows.length,
          finishedAt: this.clock.now(),
        });
        // COMPLETED болсны ДАРАА: дахин ангилах (хуулга хоорондын own-transfer хос) + DTI. Хамрах хугацаа COMPLETED ажлуудаас гарна
        const recalculated = await this.recalc.run(r, { analysisId: analysis.id, actorId: null, reason: 'IMPORT', refreshClassification: true });
        await r.events.append({
          analysisId: analysis.id,
          action: BSA_EVENT.IMPORT_COMPLETED,
          actorId: null,
          at: this.clock.now(),
          detail: { jobId: job.id, rows: rows.length, inserted, skipped, reclassified: recalculated.reclassified, warnings: allWarnings.map((w) => w.code) },
        });
        await this.publisher.enqueue(
          tx,
          buildStatementImportedEvent(
            { analysisId: analysis.id, applicationId: analysis.applicationId, rows: inserted, status: 'COMPLETED', ctx: this.eventContext(analysis.orgId, job.id) },
            { now: () => this.clock.now() },
          ),
        );
        return { inserted, skipped, reclassified: recalculated.reclassified };
      });
    } catch (e) {
      // Тодорхой: мөр хадгалах шаардлага хангахгүй / ангиллын сан / ангилал-чиглэл зөрөх ⇒ дахин оролдсон ч ижил
      if (e instanceof BsaInvalidError) throw new DeterministicFailure([pipelineIssue('ROW_INVALID')], patch, warnings);
      if (e instanceof BsaException && e.bsaCode === 'CATALOG_INCOMPLETE') throw new DeterministicFailure([pipelineIssue('CATALOG_INCOMPLETE')], patch, warnings);
      if (e instanceof BsaException && e.bsaCode === 'AGGREGATION_FAILED') throw new DeterministicFailure([pipelineIssue('AGGREGATION_FAILED')], patch, warnings);
      throw e;
    }
    if (result === 'SKIPPED') {
      const latest = await this.repo.importJobs.getById(job.id);
      return { kind: 'SKIPPED', jobId: job.id, reason: latest?.status === 'FAILED' ? 'ALREADY_FAILED' : 'ALREADY_COMPLETED' };
    }
    return { kind: 'COMPLETED', jobId: job.id, ...result };
  }

  private eventContext(orgId: string, jobId: string): { orgId: string; correlationId: string; userId: null } {
    // Worker-т хүсэлтийн correlation id байхгүй: ажлын id-аар уях
    return { orgId, correlationId: `bsa-import-${jobId}`, userId: null };
  }

  // ───────────────────────── FAILED ─────────────────────────

  /** Нэг транзакцид: ажил FAILED + түүх + StatementImported{FAILED}. Идемпотент (аль хэдийн төгссөн бол алгасна) */
  private async fail(
    job: BsaImportJobRecord,
    analysis: BsaAnalysisRecord,
    errors: ImportIssue[],
    warnings: ImportIssue[],
    patch: BsaImportJobPatch,
  ): Promise<PipelineOutcome> {
    const codes = errors.map((e) => e.code);
    await this.repo.runInTransaction(async (r, tx) => {
      const current = await r.importJobs.getById(job.id);
      if (!current || current.status === 'COMPLETED' || current.status === 'FAILED') return;
      await r.importJobs.update(job.id, { ...patch, status: 'FAILED', errors, warnings, rowsDone: 0, finishedAt: this.clock.now() });
      await r.events.append({ analysisId: analysis.id, action: BSA_EVENT.IMPORT_FAILED, actorId: null, at: this.clock.now(), detail: { jobId: job.id, codes } });
      await this.publisher.enqueue(
        tx,
        buildStatementImportedEvent(
          { analysisId: analysis.id, applicationId: analysis.applicationId, rows: 0, status: 'FAILED', ctx: this.eventContext(analysis.orgId, job.id) },
          { now: () => this.clock.now() },
        ),
      );
    });
    return { kind: 'FAILED', jobId: job.id, codes };
  }
}
