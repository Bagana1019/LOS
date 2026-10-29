// BSA-ийн persistence port. Pipeline/controller-ууд ЗӨВХӨН энэ интерфэйсийг мэднэ (Prisma-ийн төрөл энд ил гарахгүй).
// Хэрэгжүүлэлт: PrismaBsaRepository (PostgreSQL), InMemoryBsaRepository (тест) — хоёр нь нэг гэрээний тестээр (repository.contract.ts) шалгагдсан.
//
// Гэрээний ерөнхий дүрэм:
//  - Мөнгө `number` (2 оронд бөөрөнхийлж хадгална), огноо `YYYY-MM-DD` мөр, timestamp `Date`. PII талбарууд (утга, данс, нэр, регистр…)
//    энд ШИФРЛЭЛТГҮЙ (decrypted) — шифрлэлт/тайлалт repository дотор PiiCipher-ээр хийгдэнэ (NFR-3).
//  - `undefined` = «өөрчлөхгүй», `null` = «хоослох» (patch-д).
//  - Жагсаалт бүр тогтвортой, бүрэн эрэмбэтэй (сүүлийн tie-break нь id) → хуудаслалт давхардахгүй/алдахгүй.
//  - Алдаа: BsaNotFoundError / BsaDuplicateError / BsaInvalidError (доор). Алдааны мессежид PII орохгүй.
//  - `runInTransaction`: callback шидвэл бүх бичилт буцна; `tx` нь DomainEventPublisher.enqueue(tx, event)-д өгөх объект
//    (CLAUDE.md §3.2(4): event-ийг бизнес бичилттэй НЭГ транзакцид outbox-д бичнэ).
import type { BsaStatus, BsaSummary, ImportFormat, ImportStatus, BsaChannel, TxnDirection } from '@los/contracts';
import type { BsaCategoryDef, BsaRuleDef } from '../../classify/classify.types';

export const BSA_REPOSITORY = Symbol('BSA_REPOSITORY');

/** `YYYY-MM-DD` (хуулгын огноо, хугацаа) */
export type IsoDate = string;
export type BsaAnalysisStatus = (typeof BsaStatus)[number];
export type ImportJobStatus = (typeof ImportStatus)[number];
/** Нэг эх сурвалж: @los/contracts/bsa.ts (REST DTO-той хуваалцана). Өмнөх импорт (`from './bsa.repository'`) хэвээр ажиллана */
export { ImportFormat } from '@los/contracts';

// ───────────────────────── Нийтлэг ─────────────────────────

/** Хуудаслалтын хүсэлт. `limit` нь MAX_PAGE_SIZE-аар хязгаарлагдана (хариунд бодит утга нь `limit`-д) */
export interface PageRequest {
  limit?: number;
  offset?: number;
}
export interface Page<T> {
  items: T[];
  /** Шүүлтэнд таарсан нийт мөр (хуудаслахаас өмнө) */
  total: number;
  limit: number;
  offset: number;
}
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 1000;

/**
 * Тенант/салбарын хязгаар (CLAUDE.md §3.2(9)): өгвөл org (болон branch)-д харьяалагдаагүй мөр «олдсонгүй» (null) болно — оршихыг ил гаргахгүй.
 * `branchId` null/undefined = салбарын хязгаарлалтгүй (батлагч/админ).
 */
export interface TenantScope {
  orgId: string;
  branchId?: string | null;
}

/** BSA-FR-5.2 дараах аудит бичлэгийн `actor` гэх мэт — хэрэглэгчийн id (PII биш), системийн ажилд null */
export type ActorId = string | null | undefined;

// ───────────────────────── Алдаа ─────────────────────────

export type BsaRepositoryErrorCode = 'NOT_FOUND' | 'DUPLICATE' | 'INVALID';
export type BsaUniqueConstraint = 'ANALYSIS_VERSION' | 'IMPORT_FILE' | 'CATEGORY_CODE' | 'RULE';

export class BsaRepositoryError extends Error {
  constructor(readonly code: BsaRepositoryErrorCode, message: string) {
    super(message);
    this.name = new.target.name;
  }
}
export class BsaNotFoundError extends BsaRepositoryError {
  constructor(readonly entity: 'analysis' | 'import_job' | 'rule' | 'category', readonly id: string) {
    super('NOT_FOUND', `${entity} ${id} not found`);
  }
}
/** BSA-FR-2.2/2.6: ижил файл (sha256) нэг шинжилгээнд дахин оруулах гэхэд `existingId` = өмнөх импортын ажил */
export class BsaDuplicateError extends BsaRepositoryError {
  constructor(readonly constraint: BsaUniqueConstraint, readonly existingId?: string) {
    super('DUPLICATE', `unique constraint ${constraint} violated`);
  }
}
/** Буруу оролт (enum, огноо, мөнгө, үл мэдэгдэх ангилал…). `field` нь зөвхөн талбарын нэр — утга оруулахгүй */
export class BsaInvalidError extends BsaRepositoryError {
  constructor(readonly field: string, message: string) {
    super('INVALID', `${field}: ${message}`);
  }
}

// ───────────────────────── Шинжилгээ (bsa_analysis) ─────────────────────────

/** BSA-FR-1.1: харилцагчийн хураангуй (шифрлэгдэж хадгалагдана) */
export interface BsaDeclaredAccount {
  bankCode: string | null;
  accountNo: string;
  iban: string | null;
  holderName: string | null;
  /** docs/03 customer_bank_account.source */
  source: 'MANUAL' | 'STATEMENT';
}
export interface BsaCustomerSnapshot {
  registerNo: string;
  lastName: string | null;
  firstName: string | null;
  phone: string | null;
  gender: string | null;
  note: string | null;
  declaredAccounts: BsaDeclaredAccount[];
}

export interface BsaAnalysisRecord {
  id: string;
  orgId: string;
  branchId: string | null;
  applicationId: string;
  customerId: string;
  /** INT-1: LOS-ын borrower id */
  borrowerId: string | null;
  status: BsaAnalysisStatus;
  /** INT-7: (org, application, customer) тутамд 1-ээс эхэлж автоматаар нэмэгдэнэ; хамгийн өндөр = идэвхтэй */
  version: number;
  periodFrom: IsoDate | null;
  periodTo: IsoDate | null;
  periodMonths: number | null;
  proposedMonthlyPayment: number | null;
  /** ББӨ 0..1; null = тохиргооны анхдагч */
  costOfGoodsRate: number | null;
  /** INT-4 гэрээ */
  summary: BsaSummary | null;
  customer: BsaCustomerSnapshot | null;
  /** PiiCipher.hash(нормчилсон регистр) — регистрийг өөрийг нь ХАРЖ БОЛОХГҮЙ */
  registerNoHash: string | null;
  /** BSA-BR-5: өөрийн дансны дугаар/IBAN (нормчилсон: хоосон зайгүй, том үсэг) */
  ownAccounts: string[];
  analyzedAt: Date | null;
  pushedToLosAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
  updatedBy: string | null;
}

export interface NewBsaAnalysis {
  orgId: string;
  branchId?: string | null;
  applicationId: string;
  customerId: string;
  borrowerId?: string | null;
  periodFrom?: IsoDate | null;
  periodTo?: IsoDate | null;
  periodMonths?: number | null;
  proposedMonthlyPayment?: number | null;
  costOfGoodsRate?: number | null;
  customer?: BsaCustomerSnapshot | null;
  ownAccounts?: string[];
  createdBy?: string | null;
}

export type BsaAnalysisPatch = Partial<
  Pick<
    BsaAnalysisRecord,
    | 'branchId' | 'borrowerId' | 'status' | 'periodFrom' | 'periodTo' | 'periodMonths' | 'proposedMonthlyPayment' | 'costOfGoodsRate'
    | 'summary' | 'customer' | 'ownAccounts' | 'analyzedAt' | 'pushedToLosAt'
  >
>;

export interface BsaAnalysisFilter {
  orgId: string;
  /** Салбарын хязгаар (ЗЭЗ/салбарын захирал) */
  branchId?: string | null;
  status?: BsaAnalysisStatus | BsaAnalysisStatus[];
  applicationId?: string;
  customerId?: string;
  /** Регистрээр хайх (BSA-FR-1.2) — repository өөрөө hash хийж register_no_hash-аар тулгана */
  registerNo?: string;
  createdBy?: string;
  createdFrom?: Date;
  /** exclusive */
  createdTo?: Date;
}

export interface BsaAnalysisRepo {
  /** Дараагийн хувилбарыг (INT-7) зэрэгцээ дуудлагад ч давхардуулалгүй олгоно; status = DRAFT */
  create(input: NewBsaAnalysis): Promise<BsaAnalysisRecord>;
  getById(id: string, scope?: TenantScope): Promise<BsaAnalysisRecord | null>;
  /** Хамгийн өндөр хувилбар (идэвхтэй шинжилгээ) */
  findLatest(orgId: string, applicationId: string, customerId: string): Promise<BsaAnalysisRecord | null>;
  /** Хүсэлтийн зээлдэгч бүрийн хамгийн сүүлийн хувилбар (BSA-BR-9 нэгтгэл, INT-6), customerId өсөхөөр */
  listLatestByApplication(orgId: string, applicationId: string): Promise<BsaAnalysisRecord[]>;
  /** Эрэмбэ: createdAt ↓, version ↓, id ↓ */
  list(filter: BsaAnalysisFilter, page?: PageRequest): Promise<Page<BsaAnalysisRecord>>;
  update(id: string, patch: BsaAnalysisPatch, updatedBy?: ActorId): Promise<BsaAnalysisRecord>;
  /**
   * BSA-BR-5: хуулгаас уншсан данс/IBAN-ыг өөрийн дансны жагсаалтад АТОМААР нэмнэ (зэрэгцээ импорт алдагдуулахгүй).
   * Буцаах нь нэгтгэсэн бүтэн жагсаалт (давхардалгүй, нэмэгдсэн дарааллаар).
   */
  addOwnAccounts(id: string, accounts: readonly string[], updatedBy?: ActorId): Promise<string[]>;
}

// ───────────────────────── Импортын ажил (bsa_import_job) ─────────────────────────

/** errors_json / warnings_json-ийн нэг мөр. АНХААР: PII (гүйлгээний утга, нэр, данс) оруулахгүй — зөвхөн код, мөр/хуудасны дугаар */
export interface ImportIssue {
  code: string;
  message: string;
  severity?: 'ERROR' | 'WARNING';
  seq?: number;
  page?: number;
  line?: number;
}

export interface BsaImportJobRecord {
  id: string;
  orgId: string;
  branchId: string | null;
  analysisId: string;
  /** Object store-ийн түлхүүр (нэр/PII агуулахгүй) */
  fileId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** жижиг hex, 64 тэмдэгт */
  sha256: string;
  bankCode: string | null;
  format: ImportFormat;
  accountNo: string | null;
  iban: string | null;
  holderName: string | null;
  periodFrom: IsoDate | null;
  periodTo: IsoDate | null;
  status: ImportJobStatus;
  rowsTotal: number;
  rowsDone: number;
  errors: ImportIssue[];
  warnings: ImportIssue[];
  parserOk: boolean | null;
  verifierOk: boolean | null;
  /** null = шалгаагүй */
  qrVerified: boolean | null;
  attempts: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
  updatedBy: string | null;
}

export interface NewBsaImportJob {
  analysisId: string;
  fileId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  format: ImportFormat;
  bankCode?: string | null;
  createdBy?: string | null;
}

export type BsaImportJobPatch = Partial<
  Pick<
    BsaImportJobRecord,
    | 'status' | 'bankCode' | 'format' | 'accountNo' | 'iban' | 'holderName' | 'periodFrom' | 'periodTo' | 'rowsTotal' | 'rowsDone'
    | 'errors' | 'warnings' | 'parserOk' | 'verifierOk' | 'qrVerified' | 'attempts' | 'startedAt' | 'finishedAt'
  >
>;

export interface BsaImportJobFilter {
  /** Орхивол org-ын хязгаар үгүй — ЗӨВХӨН систем (worker сэргээлт) */
  orgId?: string;
  branchId?: string | null;
  analysisId?: string;
  status?: ImportJobStatus | ImportJobStatus[];
  bankCode?: string;
}

export interface BsaImportJobRepo {
  /** (analysis, sha256) давхцвал BsaDuplicateError('IMPORT_FILE', existingId); шинжилгээ байхгүй бол BsaNotFoundError */
  create(input: NewBsaImportJob): Promise<BsaImportJobRecord>;
  getById(id: string, scope?: TenantScope): Promise<BsaImportJobRecord | null>;
  /** Файл object store-д хадгалахаас өмнө давхардлыг шалгахад */
  findBySha256(analysisId: string, sha256: string): Promise<BsaImportJobRecord | null>;
  /** Эрэмбэ: createdAt ↓, id ↓ */
  list(filter: BsaImportJobFilter, page?: PageRequest): Promise<Page<BsaImportJobRecord>>;
  /** BSA-FR-2.6 «Импорт ажлууд» дэлгэцийн тоолуур (нийт/боловсруулж буй/дууссан/алдаатай); бүх төлөв байна (0 хамт) */
  countByStatus(filter: Omit<BsaImportJobFilter, 'status'>): Promise<Record<ImportJobStatus, number>>;
  update(id: string, patch: BsaImportJobPatch, updatedBy?: ActorId): Promise<BsaImportJobRecord>;
  /** Явц (NFR-1): rows_done += delta атомаар, шинэчлэгдсэн ажлыг буцаана */
  incrementRowsDone(id: string, delta: number): Promise<BsaImportJobRecord>;
}

// ───────────────────────── Гүйлгээ (bsa_transaction) ─────────────────────────

/** Хуулгаас уншсан (мөн ангилагдсан бол) гүйлгээ. Ангилал өгөөгүй бол category=null, channel=OTHER, confidence=0 */
export interface NewBsaTransaction {
  seq: number;
  txnDate: IsoDate;
  /** HH:mm | HH:mm:ss */
  txnTime: string | null;
  direction: TxnDirection;
  /** Эерэг дүн */
  amount: number;
  balanceAfter: number | null;
  description: string;
  counterpartyAccount: string | null;
  counterpartyName: string | null;
  channel?: BsaChannel;
  categoryCode?: string | null;
  categoryGroup?: string | null;
  /** 0..100 */
  confidence?: number;
  isOwnTransfer?: boolean;
  /** Хуулга/дансны тодорхойлогч — PiiCipher.hash хэлбэртэй байх (дансны дугаар ил хадгалахгүй) */
  statementKey: string;
  /** Давхцсан хуулгын ижил мөрийг таних түлхүүр (dedupe-key.ts) */
  dedupeKey: string;
}

export interface BsaTransactionRecord {
  id: string;
  analysisId: string;
  importJobId: string;
  seq: number;
  txnDate: IsoDate;
  txnTime: string | null;
  direction: TxnDirection;
  amount: number;
  balanceAfter: number | null;
  description: string;
  counterpartyAccount: string | null;
  counterpartyName: string | null;
  channel: BsaChannel;
  categoryCode: string | null;
  categoryGroup: string | null;
  confidence: number;
  isOwnTransfer: boolean;
  /** BSA-FR-3.3: гар засвар — автомат ангилал дахин өөрчлөхгүй */
  manualOverride: boolean;
  overrideBy: string | null;
  statementKey: string;
  dedupeKey: string;
}

export type BsaTransactionSort = 'DATE_ASC' | 'DATE_DESC' | 'AMOUNT_ASC' | 'AMOUNT_DESC';

/** BSA-FR-4.6: шүүлт. Бүх нөхцөл AND. Хоёр захыг оролцуулна */
export interface BsaTransactionFilter {
  analysisId: string;
  importJobId?: string;
  dateFrom?: IsoDate;
  dateTo?: IsoDate;
  direction?: TxnDirection;
  categoryCodes?: string[];
  channel?: BsaChannel | BsaChannel[];
  ownTransfer?: boolean;
  manualOverride?: boolean;
  amountMin?: number;
  amountMax?: number;
  /**
   * Утга/харьцсан нэр/дансанд том-жижиг үсэг үл ялгах дэд мөрөөр хайх. Талбарууд шифрлэгдсэн тул хайлт програмд хийгддэг
   * (нэг шинжилгээний мөрүүд дээр, SQL-д биш) — зөвхөн энэ шүүлт өгөгдсөн үед өртөг нэмэгдэнэ.
   */
  text?: string;
  /** Анхдагч DATE_ASC: txnDate, txnTime (хоосон түрүүлж), seq, id */
  sort?: BsaTransactionSort;
}

export interface BulkInsertResult {
  inserted: number;
  /** dedupeKey нь шинжилгээнд аль хэдийн байсан (эсвэл багцад давхардсан) тул алгассан мөр */
  skipped: number;
}

/** classifier-ийн ClassificationResult-ийн хадгалагдах хэсэг */
export interface ClassificationUpdate {
  id: string;
  categoryCode: string;
  categoryGroup: string;
  /** 0..100 */
  confidence: number;
  channel: BsaChannel;
  isOwnTransfer: boolean;
}

export interface BsaTransactionCounts {
  total: number;
  income: number;
  expense: number;
  ownTransfers: number;
  manualOverrides: number;
  unclassified: number;
  /** Ангилагдсан мөрүүд, categoryCode ↑, direction ↑ */
  byCategory: Array<{ categoryCode: string; direction: TxnDirection; count: number }>;
  /** importJobId ↑ */
  byImportJob: Array<{ importJobId: string; count: number }>;
}

/** setManualCategory-д оноох итгэл % (classifier-ийн CLASSIFY_CONFIDENCE.MANUAL-тай ижил) */
export const MANUAL_OVERRIDE_CONFIDENCE = 100;

export interface BsaTransactionRepo {
  /**
   * Нэг импортын ажлын мөрүүдийг ХАМТ (атомаар) нэмнэ. (analysis, dedupeKey) аль хэдийн байгаа мөр (өөр файлаас) болон багц доторх
   * давхардлыг АЛГАСНА (эхнийх ялна) — алдаа биш. Ажил байхгүй бол BsaNotFoundError, мөр буруу бол BsaInvalidError (юу ч хадгалагдахгүй).
   */
  bulkInsert(importJobId: string, rows: readonly NewBsaTransaction[], createdBy?: ActorId): Promise<BulkInsertResult>;
  list(filter: BsaTransactionFilter, page?: PageRequest): Promise<Page<BsaTransactionRecord>>;
  /** Дахин тооцоолол/ангилалд: шинжилгээний БҮХ гүйлгээ, DATE_ASC эрэмбээр */
  loadAll(analysisId: string): Promise<BsaTransactionRecord[]>;
  /**
   * Автомат ангиллын үр дүнг хадгална. Гар засвартай (manualOverride) мөрийг ӨӨРЧИЛӨХГҮЙ; ижил id давтвал сүүлийнх. Өөр шинжилгээний
   * id-г үл тоомсорлоно. Буцаах: updated = өөрчлөгдсөн, skipped = (өвөрмөц id) − updated.
   */
  updateClassifications(analysisId: string, updates: readonly ClassificationUpdate[], updatedBy?: ActorId): Promise<{ updated: number; skipped: number }>;
  /**
   * BSA-FR-3.3: гар ангилал (category_group-ийг ангиллын сангаас авна; итгэл %=MANUAL_OVERRIDE_CONFIDENCE, isOwnTransfer=false).
   * Ангилал байхгүй/идэвхгүй эсвэл чиглэл таарахгүй гүйлгээ байвал BsaInvalidError (юу ч өөрчлөгдөхгүй). Буцаах: өөрчлөгдсөн мөр.
   */
  setManualCategory(analysisId: string, ids: readonly string[], categoryCode: string, by: string): Promise<number>;
  /** Дахин импорт: ажлын гүйлгээг устгана, устгасан тоог буцаана (ажил өөрөө үлдэнэ) */
  deleteByJob(importJobId: string): Promise<number>;
  counts(analysisId: string): Promise<BsaTransactionCounts>;
}

// ───────────────────────── Түүх, тохиргоо, retention ─────────────────────────

/** NFR-4: өөрчлөлтийн түүх. detail нь PII агуулахгүй (тоо, код, id) */
export interface BsaAnalysisEventRecord {
  id: string;
  analysisId: string;
  at: Date;
  actorId: string | null;
  action: string;
  detail: Record<string, unknown> | null;
}
export interface NewBsaAnalysisEvent {
  analysisId: string;
  action: string;
  actorId?: ActorId;
  detail?: Record<string, unknown> | null;
  /** Орхивол repository-ийн цаг */
  at?: Date;
}
export interface BsaEventRepo {
  append(input: NewBsaAnalysisEvent): Promise<BsaAnalysisEventRecord>;
  /** Шинэ нь түрүүлж: at ↓, id ↓ */
  list(analysisId: string, page?: PageRequest): Promise<Page<BsaAnalysisEventRecord>>;
}

export interface BsaConfigRepo {
  /** Идэвхтэй/идэвхгүй БҮХ ангилал (isActive-аар), code ↑ */
  listCategories(orgId: string): Promise<BsaCategoryDef[]>;
  /** ЗӨВХӨН идэвхтэй дүрэм (`id` үргэлж байна — setRuleActive-д хэрэгтэй): priority ↓, createdAt ↑, id ↑ */
  listRules(orgId: string): Promise<Array<BsaRuleDef & { id: string }>>;
  /** BSA-FR-3.4 feedback, BSA-FR-3.5 admin. Ижил (чиглэл, төрөл, хэв, ангилал, source) байвал BsaDuplicateError('RULE') */
  createRule(orgId: string, rule: Omit<BsaRuleDef, 'id'>, createdBy?: ActorId): Promise<BsaRuleDef & { id: string }>;
  setRuleActive(orgId: string, ruleId: string, isActive: boolean, updatedBy?: ActorId): Promise<void>;
}

export interface ExpiredAnalysisRef {
  id: string;
  orgId: string;
  applicationId: string;
  createdAt: Date;
}
export interface PurgeResult {
  analysisId: string;
  /** Дуудагч DB commit-ийн ДАРАА object store-оос устгана (import job бүрийн fileId) */
  objectKeys: string[];
  counts: { importJobs: number; transactions: number; events: number };
}
export interface BsaRetentionRepo {
  /** BSA-BR-8: createdAt < cutoff шинжилгээнүүд (хуучин нь түрүүлж), org-оор хязгаарлаж болно */
  findExpired(cutoff: Date, limit: number, orgId?: string): Promise<ExpiredAnalysisRef[]>;
  /** Шинжилгээ + ажил + гүйлгээ + түүхийг бүрэн устгана (ноорог устгахад ч мөн). Байхгүй бол BsaNotFoundError */
  purge(analysisId: string): Promise<PurgeResult>;
}

// ───────────────────────── Нэгдсэн port ─────────────────────────

export interface BsaRepository {
  readonly analyses: BsaAnalysisRepo;
  readonly importJobs: BsaImportJobRepo;
  readonly transactions: BsaTransactionRepo;
  readonly events: BsaEventRepo;
  readonly config: BsaConfigRepo;
  readonly retention: BsaRetentionRepo;
  /**
   * Callback дотор өгөгдсөн `repo`-оор хийсэн бүх бичилт нэг транзакцид; callback шидвэл бүгд буцна. `tx`-ийг
   * DomainEventPublisher.enqueue(tx, event)-д дамжуулж event-ийг ижил транзакцид outbox-д бичнэ. Доторх дуудлага (nested) гадаад
   * транзакцдаа нэгдэнэ. Урт callback-д (том импорт) транзакцийн timeout-ыг repository-ийн тохиргооноос авна.
   */
  runInTransaction<T>(fn: (repo: BsaRepository, tx: unknown) => Promise<T>): Promise<T>;
}
