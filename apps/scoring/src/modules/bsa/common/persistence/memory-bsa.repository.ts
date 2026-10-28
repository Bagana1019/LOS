// BsaRepository-ийн санах ойн хэрэгжүүлэлт: pipeline/controller-ийн unit тест, DB-гүй орчинд. PrismaBsaRepository-той ЯГ ИЖИЛ семантик
// (эрэмбэ, хувилбар олголт, dedupe, хуудаслалт, бөөрөнхийлөл, алдаа) — repository.contract.ts хоёуланг нэг тестээр шалгана.
// Ялгаа: шифрлэлтгүй (PII-г шууд хадгална), транзакцийн тусгаарлалтгүй (нэг transaction нэг дор ажиллана, алдаа гарвал snapshot-оор буцаана).
import { createHash, randomUUID } from 'node:crypto';
import type { BsaCategoryDef, BsaRuleDef } from '../../classify/classify.types';
import {
  BsaDuplicateError, BsaInvalidError, BsaNotFoundError, MANUAL_OVERRIDE_CONFIDENCE,
  type BsaAnalysisEventRecord, type BsaAnalysisRecord, type BsaAnalysisRepo, type BsaConfigRepo, type BsaEventRepo,
  type BsaImportJobFilter, type BsaImportJobRecord, type BsaImportJobRepo, type BsaRepository, type BsaRetentionRepo, type BsaTransactionCounts,
  type BsaTransactionRecord, type BsaTransactionRepo, type ImportJobStatus, type Page, type PageRequest, type TenantScope,
} from './bsa.repository';
import { matchesText, textNeedle, txnComparator } from './bsa.query';
import {
  analysisFilterSchema, analysisPatchSchema, classificationUpdateSchema, compareStrings, asArray, jobFilterSchema, jobPatchSchema, mergeAccounts,
  newAnalysisSchema, newEventSchema, newJobSchema, newRuleSchema, newTxnSchema, normalizeRegisterNo, resolvePage, toJson,
  txnFilterSchema, validate,
} from './bsa.validation';
import type { PiiCipher } from '../infra.ports';

export interface InMemoryBsaRepositoryOptions {
  /** Тестэд тогтмол цаг. Анхдагч: системийн цаг */
  now?: () => Date;
  /** register_no_hash-д; анхдагч нь тест-аас өөр ямар ч түлхүүргүй sha256 (PRODUCTION-д ашиглахгүй) */
  cipher?: Pick<PiiCipher, 'hash'>;
}

type TxnRow = BsaTransactionRecord & { orgId: string; branchId: string | null };
type EventRow = BsaAnalysisEventRecord & { orgId: string; branchId: string | null };
interface RuleRow { id: string; orgId: string; createdAt: Date; isActive: boolean; def: BsaRuleDef & { id: string } }

interface State {
  analyses: Map<string, BsaAnalysisRecord>;
  jobs: Map<string, BsaImportJobRecord>;
  txns: Map<string, TxnRow>;
  events: Map<string, EventRow>;
  categories: Map<string, BsaCategoryDef>; // түлхүүр: `${orgId}\u0000${code}`
  rules: Map<string, RuleRow>;
}
const emptyState = (): State => ({ analyses: new Map(), jobs: new Map(), txns: new Map(), events: new Map(), categories: new Map(), rules: new Map() });
const snapshot = (s: State): State => ({
  analyses: new Map(s.analyses), jobs: new Map(s.jobs), txns: new Map(s.txns), events: new Map(s.events), categories: new Map(s.categories), rules: new Map(s.rules),
});

const clone = <T>(v: T): T => structuredClone(v);
const sha256Hash = (plain: string): string => createHash('sha256').update(plain).digest('hex');
const catKey = (orgId: string, code: string): string => `${orgId}\u0000${code}`;
const paged = <T>(all: T[], page?: PageRequest): Page<T> => {
  const { limit, offset } = resolvePage(page);
  return { items: all.slice(offset, offset + limit), total: all.length, limit, offset };
};
const scoped = (r: { orgId: string; branchId: string | null }, scope?: TenantScope): boolean =>
  !scope || (r.orgId === scope.orgId && (!scope.branchId || r.branchId === scope.branchId));

export class InMemoryBsaRepository implements BsaRepository {
  private readonly now: () => Date;
  private readonly hash: (plain: string) => string;
  private lock: Promise<unknown> = Promise.resolve();

  /** `state`, `inTx` нь дотоод (transaction-ы хүүхэд repo үүсгэхэд) — гаднаас зөвхөн `opts` өгнө */
  constructor(private readonly opts: InMemoryBsaRepositoryOptions = {}, private readonly state: State = emptyState(), private readonly inTx = false) {
    this.now = opts.now ?? (() => new Date());
    this.hash = opts.cipher ? (p) => opts.cipher!.hash(p) : sha256Hash;
  }

  // ── Тест туслах (BsaRepository-д ороогүй): тохиргооны сан seed хийх ──
  seedConfig(orgId: string, cfg: { categories?: readonly BsaCategoryDef[]; rules?: readonly Omit<BsaRuleDef, 'id'>[] }): void {
    for (const c of cfg.categories ?? []) this.state.categories.set(catKey(orgId, c.code), { ...c });
    for (const r of cfg.rules ?? []) {
      const id = randomUUID();
      this.state.rules.set(id, { id, orgId, createdAt: this.now(), isActive: true, def: { ...r, id } });
    }
  }

  private analysisOrThrow(id: string): BsaAnalysisRecord {
    const a = this.state.analyses.get(id);
    if (!a) throw new BsaNotFoundError('analysis', id);
    return a;
  }
  private jobOrThrow(id: string): BsaImportJobRecord {
    const j = this.state.jobs.get(id);
    if (!j) throw new BsaNotFoundError('import_job', id);
    return j;
  }
  private txnRows(analysisId: string): TxnRow[] {
    return [...this.state.txns.values()].filter((t) => t.analysisId === analysisId);
  }

  // ───────────────────────── analyses ─────────────────────────
  readonly analyses: BsaAnalysisRepo = {
    create: async (input) => {
      const v = validate(newAnalysisSchema, input, 'analysis');
      const siblings = [...this.state.analyses.values()].filter((a) => a.orgId === v.orgId && a.applicationId === v.applicationId && a.customerId === v.customerId);
      const at = this.now();
      const rec: BsaAnalysisRecord = {
        id: randomUUID(), orgId: v.orgId, branchId: v.branchId, applicationId: v.applicationId, customerId: v.customerId, borrowerId: v.borrowerId,
        status: 'DRAFT', version: Math.max(0, ...siblings.map((a) => a.version)) + 1,
        periodFrom: v.periodFrom, periodTo: v.periodTo, periodMonths: v.periodMonths, proposedMonthlyPayment: v.proposedMonthlyPayment,
        costOfGoodsRate: v.costOfGoodsRate, summary: null, customer: v.customer, registerNoHash: this.registerHash(v.customer?.registerNo),
        ownAccounts: v.ownAccounts, analyzedAt: null, pushedToLosAt: null, createdAt: at, updatedAt: at, createdBy: v.createdBy, updatedBy: v.createdBy,
      };
      this.state.analyses.set(rec.id, rec);
      return clone(rec);
    },
    getById: async (id, scope) => {
      const a = this.state.analyses.get(id);
      return a && scoped(a, scope) ? clone(a) : null;
    },
    findLatest: async (orgId, applicationId, customerId) => {
      const all = [...this.state.analyses.values()].filter((a) => a.orgId === orgId && a.applicationId === applicationId && a.customerId === customerId);
      const top = all.sort((a, b) => b.version - a.version)[0];
      return top ? clone(top) : null;
    },
    listLatestByApplication: async (orgId, applicationId) => {
      const latest = new Map<string, BsaAnalysisRecord>();
      for (const a of this.state.analyses.values()) {
        if (a.orgId !== orgId || a.applicationId !== applicationId) continue;
        const cur = latest.get(a.customerId);
        if (!cur || a.version > cur.version) latest.set(a.customerId, a);
      }
      return [...latest.values()].sort((a, b) => compareStrings(a.customerId, b.customerId)).map(clone);
    },
    list: async (filter, page) => {
      const f = validate(analysisFilterSchema, filter, 'filter');
      const statuses = asArray(f.status);
      const regHash = f.registerNo ? this.registerHash(f.registerNo) : null;
      const rows = [...this.state.analyses.values()]
        .filter((a) => a.orgId === f.orgId)
        .filter((a) => !f.branchId || a.branchId === f.branchId)
        .filter((a) => !statuses || statuses.includes(a.status))
        .filter((a) => !f.applicationId || a.applicationId === f.applicationId)
        .filter((a) => !f.customerId || a.customerId === f.customerId)
        .filter((a) => regHash === null || a.registerNoHash === regHash)
        .filter((a) => !f.createdBy || a.createdBy === f.createdBy)
        .filter((a) => !f.createdFrom || a.createdAt >= f.createdFrom)
        .filter((a) => !f.createdTo || a.createdAt < f.createdTo)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.version - a.version || compareStrings(b.id, a.id));
      return clone(paged(rows, page));
    },
    update: async (id, patch, updatedBy) => {
      const p = validate(analysisPatchSchema, patch, 'patch');
      const cur = this.analysisOrThrow(id);
      const next: BsaAnalysisRecord = { ...cur, updatedAt: this.now(), updatedBy: updatedBy ?? null };
      for (const [k, val] of Object.entries(p)) if (val !== undefined) (next as unknown as Record<string, unknown>)[k] = val;
      if (p.customer !== undefined) next.registerNoHash = this.registerHash(p.customer?.registerNo);
      this.state.analyses.set(id, next);
      if (p.branchId !== undefined) this.moveChildren(id, p.branchId);
      return clone(next);
    },
    addOwnAccounts: async (id, accounts, updatedBy) => {
      const cur = this.analysisOrThrow(id);
      const merged = mergeAccounts(cur.ownAccounts, accounts);
      if (merged.length === cur.ownAccounts.length) return [...cur.ownAccounts];
      this.state.analyses.set(id, { ...cur, ownAccounts: merged, updatedAt: this.now(), updatedBy: updatedBy ?? null });
      return [...merged];
    },
  };

  /** branch_id хүүхдүүдэд давхар хадгалагддаг (Prisma хэрэгжүүлэлттэй ижил): салбар солигдвол хамт шилжүүлнэ */
  private moveChildren(analysisId: string, branchId: string | null): void {
    for (const [id, j] of this.state.jobs) if (j.analysisId === analysisId) this.state.jobs.set(id, { ...j, branchId });
    for (const [id, t] of this.state.txns) if (t.analysisId === analysisId) this.state.txns.set(id, { ...t, branchId });
    for (const [id, e] of this.state.events) if (e.analysisId === analysisId) this.state.events.set(id, { ...e, branchId });
  }

  private registerHash(registerNo: string | undefined | null): string | null {
    return registerNo ? this.hash(normalizeRegisterNo(registerNo)) : null;
  }

  // ───────────────────────── importJobs ─────────────────────────
  readonly importJobs: BsaImportJobRepo = {
    create: async (input) => {
      const v = validate(newJobSchema, input, 'job');
      const analysis = this.analysisOrThrow(v.analysisId);
      const dup = [...this.state.jobs.values()].find((j) => j.analysisId === v.analysisId && j.sha256 === v.sha256);
      if (dup) throw new BsaDuplicateError('IMPORT_FILE', dup.id);
      const at = this.now();
      const rec: BsaImportJobRecord = {
        id: randomUUID(), orgId: analysis.orgId, branchId: analysis.branchId, analysisId: v.analysisId, fileId: v.fileId, fileName: v.fileName,
        mimeType: v.mimeType, sizeBytes: v.sizeBytes, sha256: v.sha256, bankCode: v.bankCode, format: v.format, accountNo: null, iban: null,
        holderName: null, periodFrom: null, periodTo: null, status: 'PENDING', rowsTotal: 0, rowsDone: 0, errors: [], warnings: [], parserOk: null,
        verifierOk: null, qrVerified: null, attempts: 0, startedAt: null, finishedAt: null, createdAt: at, updatedAt: at, createdBy: v.createdBy,
        updatedBy: v.createdBy,
      };
      this.state.jobs.set(rec.id, rec);
      return clone(rec);
    },
    getById: async (id, scope) => {
      const j = this.state.jobs.get(id);
      return j && scoped(j, scope) ? clone(j) : null;
    },
    findBySha256: async (analysisId, sha256) => {
      const j = [...this.state.jobs.values()].find((x) => x.analysisId === analysisId && x.sha256 === sha256.toLowerCase());
      return j ? clone(j) : null;
    },
    list: async (filter, page) => clone(paged(this.filterJobs(filter), page)),
    countByStatus: async (filter) => {
      const out: Record<ImportJobStatus, number> = { PENDING: 0, PROCESSING: 0, COMPLETED: 0, FAILED: 0 };
      for (const j of this.filterJobs(filter)) out[j.status] += 1;
      return out;
    },
    update: async (id, patch, updatedBy) => {
      const p = validate(jobPatchSchema, patch, 'patch');
      const next: BsaImportJobRecord = { ...this.jobOrThrow(id), updatedAt: this.now(), updatedBy: updatedBy ?? null };
      for (const [k, val] of Object.entries(p)) if (val !== undefined) (next as unknown as Record<string, unknown>)[k] = k === 'errors' || k === 'warnings' ? toJson(val) : val;
      this.state.jobs.set(id, next);
      return clone(next);
    },
    incrementRowsDone: async (id, delta) => {
      if (!Number.isInteger(delta) || delta < 0) throw new BsaInvalidError('delta', 'invalid_type');
      const cur = this.jobOrThrow(id);
      const next = { ...cur, rowsDone: cur.rowsDone + delta, updatedAt: this.now() };
      this.state.jobs.set(id, next);
      return clone(next);
    },
  };

  private filterJobs(filter: Omit<BsaImportJobFilter, 'status'> & { status?: BsaImportJobFilter['status'] }): BsaImportJobRecord[] {
    const f = validate(jobFilterSchema, filter, 'filter');
    const statuses = asArray(f.status);
    return [...this.state.jobs.values()]
      .filter((j) => !f.orgId || j.orgId === f.orgId)
      .filter((j) => !f.branchId || j.branchId === f.branchId)
      .filter((j) => !f.analysisId || j.analysisId === f.analysisId)
      .filter((j) => !statuses || statuses.includes(j.status))
      .filter((j) => !f.bankCode || j.bankCode === f.bankCode)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || compareStrings(b.id, a.id));
  }

  // ───────────────────────── transactions ─────────────────────────
  readonly transactions: BsaTransactionRepo = {
    bulkInsert: async (importJobId, rows) => {
      const parsed = rows.map((r, i) => validate(newTxnSchema, r, `rows.${i}`));
      const job = this.jobOrThrow(importJobId);
      const known = new Set(this.txnRows(job.analysisId).map((t) => t.dedupeKey));
      let inserted = 0;
      for (const r of parsed) {
        if (known.has(r.dedupeKey)) continue;
        known.add(r.dedupeKey);
        const id = randomUUID();
        this.state.txns.set(id, {
          id, analysisId: job.analysisId, importJobId, orgId: job.orgId, branchId: job.branchId, ...r, manualOverride: false, overrideBy: null,
        });
        inserted += 1;
      }
      return { inserted, skipped: parsed.length - inserted };
    },
    list: async (filter, page) => {
      const f = validate(txnFilterSchema, filter, 'filter');
      const needle = textNeedle(f.text);
      const channels = asArray(f.channel);
      const rows = this.txnRows(f.analysisId)
        .filter((t) => !f.importJobId || t.importJobId === f.importJobId)
        .filter((t) => !f.dateFrom || t.txnDate >= f.dateFrom)
        .filter((t) => !f.dateTo || t.txnDate <= f.dateTo)
        .filter((t) => !f.direction || t.direction === f.direction)
        .filter((t) => !f.categoryCodes || (t.categoryCode !== null && f.categoryCodes.includes(t.categoryCode)))
        .filter((t) => !channels || channels.includes(t.channel))
        .filter((t) => f.ownTransfer === undefined || t.isOwnTransfer === f.ownTransfer)
        .filter((t) => f.manualOverride === undefined || t.manualOverride === f.manualOverride)
        .filter((t) => f.amountMin === undefined || t.amount >= f.amountMin)
        .filter((t) => f.amountMax === undefined || t.amount <= f.amountMax)
        .filter((t) => needle === null || matchesText(t, needle))
        .sort(txnComparator(f.sort));
      return clone(paged(rows.map(toTxnRecord), page));
    },
    loadAll: async (analysisId) => clone(this.txnRows(analysisId).sort(txnComparator('DATE_ASC')).map(toTxnRecord)),
    updateClassifications: async (analysisId, updates) => {
      const byId = new Map(updates.map((u, i) => [u.id, validate(classificationUpdateSchema, u, `updates.${i}`)]));
      let updated = 0;
      for (const u of byId.values()) {
        const cur = this.state.txns.get(u.id);
        if (!cur || cur.analysisId !== analysisId || cur.manualOverride) continue;
        const { id: _id, ...fields } = u;
        this.state.txns.set(u.id, { ...cur, ...fields });
        updated += 1;
      }
      return { updated, skipped: byId.size - updated };
    },
    setManualCategory: async (analysisId, ids, categoryCode, by) => {
      const analysis = this.analysisOrThrow(analysisId);
      const cat = this.state.categories.get(catKey(analysis.orgId, categoryCode));
      if (!cat || !cat.isActive) throw new BsaInvalidError('categoryCode', 'unknown_category');
      const wanted = new Set(ids);
      const rows = this.txnRows(analysisId).filter((t) => wanted.has(t.id));
      if (rows.some((t) => t.direction !== cat.direction)) throw new BsaInvalidError('categoryCode', 'direction_mismatch');
      for (const t of rows) {
        this.state.txns.set(t.id, {
          ...t, categoryCode, categoryGroup: cat.groupCode, confidence: MANUAL_OVERRIDE_CONFIDENCE, isOwnTransfer: false, manualOverride: true, overrideBy: by,
        });
      }
      return rows.length;
    },
    deleteByJob: async (importJobId) => {
      let n = 0;
      for (const [id, t] of this.state.txns) if (t.importJobId === importJobId && this.state.txns.delete(id)) n += 1;
      return n;
    },
    counts: async (analysisId): Promise<BsaTransactionCounts> => {
      const rows = this.txnRows(analysisId);
      const cat = new Map<string, { categoryCode: string; direction: BsaTransactionRecord['direction']; count: number }>();
      const job = new Map<string, number>();
      for (const t of rows) {
        job.set(t.importJobId, (job.get(t.importJobId) ?? 0) + 1);
        if (t.categoryCode === null) continue;
        const k = `${t.categoryCode}\u0000${t.direction}`;
        const e = cat.get(k) ?? { categoryCode: t.categoryCode, direction: t.direction, count: 0 };
        e.count += 1;
        cat.set(k, e);
      }
      return {
        total: rows.length,
        income: rows.filter((t) => t.direction === 'INCOME').length,
        expense: rows.filter((t) => t.direction === 'EXPENSE').length,
        ownTransfers: rows.filter((t) => t.isOwnTransfer).length,
        manualOverrides: rows.filter((t) => t.manualOverride).length,
        unclassified: rows.filter((t) => t.categoryCode === null).length,
        byCategory: [...cat.values()].sort((a, b) => compareStrings(a.categoryCode, b.categoryCode) || compareStrings(a.direction, b.direction)),
        byImportJob: [...job.entries()].map(([importJobId, count]) => ({ importJobId, count })).sort((a, b) => compareStrings(a.importJobId, b.importJobId)),
      };
    },
  };

  // ───────────────────────── events ─────────────────────────
  readonly events: BsaEventRepo = {
    append: async (input) => {
      const v = validate(newEventSchema, input, 'event');
      const a = this.analysisOrThrow(v.analysisId);
      const rec: EventRow = { id: randomUUID(), analysisId: v.analysisId, at: v.at ?? this.now(), actorId: v.actorId, action: v.action, detail: v.detail, orgId: a.orgId, branchId: a.branchId };
      this.state.events.set(rec.id, rec);
      return clone(toEventRecord(rec));
    },
    list: async (analysisId, page) => {
      const rows = [...this.state.events.values()]
        .filter((e) => e.analysisId === analysisId)
        .sort((a, b) => b.at.getTime() - a.at.getTime() || compareStrings(b.id, a.id));
      return clone(paged(rows.map(toEventRecord), page));
    },
  };

  // ───────────────────────── config ─────────────────────────
  readonly config: BsaConfigRepo = {
    listCategories: async (orgId) =>
      [...this.state.categories.entries()].filter(([k]) => k.startsWith(`${orgId}\u0000`)).map(([, c]) => ({ ...c })).sort((a, b) => compareStrings(a.code, b.code)),
    listRules: async (orgId) =>
      [...this.state.rules.values()]
        .filter((r) => r.orgId === orgId && r.isActive)
        .sort((a, b) => b.def.priority - a.def.priority || a.createdAt.getTime() - b.createdAt.getTime() || compareStrings(a.id, b.id))
        .map((r) => ({ ...r.def })),
    createRule: async (orgId, rule) => {
      const v = validate(newRuleSchema, rule, 'rule');
      const cat = this.state.categories.get(catKey(orgId, v.categoryCode));
      if (!cat || cat.direction !== v.direction) throw new BsaInvalidError('categoryCode', cat ? 'direction_mismatch' : 'unknown_category');
      const same = [...this.state.rules.values()].some(
        (r) => r.orgId === orgId && r.def.direction === v.direction && r.def.matchType === v.matchType && r.def.pattern === v.pattern &&
          r.def.categoryCode === v.categoryCode && r.def.source === v.source,
      );
      if (same) throw new BsaDuplicateError('RULE');
      const id = randomUUID();
      this.state.rules.set(id, { id, orgId, createdAt: this.now(), isActive: true, def: { ...v, id } });
      return { ...v, id };
    },
    setRuleActive: async (orgId, ruleId, isActive) => {
      const r = this.state.rules.get(ruleId);
      if (!r || r.orgId !== orgId) throw new BsaNotFoundError('rule', ruleId);
      this.state.rules.set(ruleId, { ...r, isActive });
    },
  };

  // ───────────────────────── retention ─────────────────────────
  readonly retention: BsaRetentionRepo = {
    findExpired: async (cutoff, limit, orgId) => {
      if (!Number.isInteger(limit) || limit < 1) throw new BsaInvalidError('limit', 'invalid_type');
      return [...this.state.analyses.values()]
        .filter((a) => a.createdAt < cutoff && (!orgId || a.orgId === orgId))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || compareStrings(a.id, b.id))
        .slice(0, limit)
        .map((a) => ({ id: a.id, orgId: a.orgId, applicationId: a.applicationId, createdAt: new Date(a.createdAt) }));
    },
    purge: async (analysisId) => {
      this.analysisOrThrow(analysisId);
      const jobs = [...this.state.jobs.values()].filter((j) => j.analysisId === analysisId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || compareStrings(a.id, b.id));
      const counts = { importJobs: jobs.length, transactions: 0, events: 0 };
      for (const [id, t] of this.state.txns) if (t.analysisId === analysisId && this.state.txns.delete(id)) counts.transactions += 1;
      for (const [id, e] of this.state.events) if (e.analysisId === analysisId && this.state.events.delete(id)) counts.events += 1;
      for (const j of jobs) this.state.jobs.delete(j.id);
      this.state.analyses.delete(analysisId);
      return { analysisId, objectKeys: jobs.map((j) => j.fileId), counts };
    },
  };

  // ───────────────────────── transaction ─────────────────────────
  async runInTransaction<T>(fn: (repo: BsaRepository, tx: unknown) => Promise<T>): Promise<T> {
    if (this.inTx) return fn(this, TX_TOKEN);
    const run = async (): Promise<T> => {
      const before = snapshot(this.state);
      try {
        return await fn(new InMemoryBsaRepository(this.opts, this.state, true), TX_TOKEN);
      } catch (e) {
        Object.assign(this.state, before);
        throw e;
      }
    };
    // Зэрэгцээ transaction-ыг дарааллуулна (snapshot буцаалт бусдыг устгахаас сэргийлнэ)
    const result = this.lock.then(run);
    this.lock = result.catch(() => undefined);
    return result;
  }
}

/** DomainEventPublisher.enqueue(tx, …)-д өгөх тэмдэг; in-memory publisher тест өөрийнхөөрөө тайлбарлана */
const TX_TOKEN = Object.freeze({ inMemoryTransaction: true });

function toTxnRecord(t: TxnRow): BsaTransactionRecord {
  const { orgId: _o, branchId: _b, ...rec } = t;
  return rec;
}
function toEventRecord(e: EventRow): BsaAnalysisEventRecord {
  const { orgId: _o, branchId: _b, ...rec } = e;
  return rec;
}
