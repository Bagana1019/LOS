// BSA-FR-5.1/5.2: сэжигтэй дохионы жагсаалт, нэг/бөөнөөр шийдвэрлэх.
//  - Унших: шинжилгээг харах эрхтэй хэн ч; шийдвэрлэх: бичих эрхтэй (хариуцсан ЗЭЗ; салбарын захирал; админ) — APPROVER шийдвэрлэхгүй.
//  - APPROVE: гүйлгээг өөрчлөхгүй. EXCLUDE: орлого → SUSPICIOUS_INCOME (0%, дайчлахгүй), зардал → SUSPICIOUS_EXPENSE. RECLASSIFY: сонгосон ангилал
//    (чиглэл таарсан гүйлгээнд л). Гар ангилал (manualOverride) нь дараагийн автомат ангилалд дарагдахгүй.
//  - Бүгд НЭГ транзакцид: гүйлгээний ангилал → дохио шийдвэрлэх → дахин тооцоо (summary.pendingSuspiciousCount шинэчлэгдэнэ) → түүх.
import { Inject, Injectable } from '@nestjs/common';
import { BsaResolveSuspicionsRequest, BsaSuspicionListQuery, type BsaResolveSuspicionsResponse, type BsaSuspicionCounts, type BsaSuspicionListResponse, type BsaSuspicionView, type SuspicionFlag } from '@los/contracts';
import type { z } from 'zod';
import { BSA_REPOSITORY, BsaInvalidError, type BsaAnalysisRecord, type BsaRepository, type BsaSuspicionRecord, type BsaTransactionRecord } from '../common/persistence';
import type { RequestContext } from '../common/infra.ports';
import { loadAnalysis } from '../import/access';
import { BSA_CLOCK, type Clock } from '../import/import.defaults';
import { BSA_EVENT } from '../import/import.events';
import { notFound, unprocessable, conflict } from '../import/import.errors';
import { parseInput } from '../import/parse-input';
import { RecalculationService } from '../import/recalculation.service';
import { toTransactionView } from '../import/views';

export const EXCLUDE_INCOME_CATEGORY = 'SUSPICIOUS_INCOME';
export const EXCLUDE_EXPENSE_CATEGORY = 'SUSPICIOUS_EXPENSE';

/** Хариуны гэрээ нь `@los/contracts` дахь цорын ганц схем (web мөн тэрийг уншина) */
export type ResolveResult = BsaResolveSuspicionsResponse;

/** Ангилал солих алхмын үр дүн: `changed` = setManualCategory-ийн үнэхээр шинэчилсэн мөр; `unchanged` = чиглэл таарахгүй тул хэвээр үлдсэн */
interface CategoryImpact { changed: number; unchanged: number }
const NO_IMPACT: CategoryImpact = { changed: 0, unchanged: 0 };

const ALL_FLAGS: readonly SuspicionFlag[] = ['OWN_ACCOUNT', 'CIRCULAR', 'INTER_ACCOUNT_FRAUD', 'QUICK_CASH', 'SPLIT_WITHDRAWAL', 'COLLUSION', 'STRUCTURING', 'GAMBLING'];

export function buildCounts(rows: ReadonlyArray<{ flag: SuspicionFlag; status: 'PENDING' | 'RESOLVED'; count: number }>): BsaSuspicionCounts {
  const byFlag = Object.fromEntries(ALL_FLAGS.map((f) => [f, { total: 0, pending: 0 }])) as BsaSuspicionCounts['byFlag'];
  let pending = 0;
  let resolved = 0;
  for (const r of rows) {
    const f = byFlag[r.flag] as { total: number; pending: number };
    f.total += r.count;
    if (r.status === 'PENDING') {
      f.pending += r.count;
      pending += r.count;
    } else resolved += r.count;
  }
  return { total: pending + resolved, pending, resolved, byFlag };
}

@Injectable()
export class SuspicionReviewService {
  constructor(
    @Inject(BSA_REPOSITORY) private readonly repo: BsaRepository,
    @Inject(RecalculationService) private readonly recalc: RecalculationService,
    @Inject(BSA_CLOCK) private readonly clock: Clock,
  ) {}

  /** docs/02 §2 «Сэжигтэй гүйлгээ»: тоолуур + бүлэглэсэн жагсаалт */
  async list(ctx: RequestContext, analysisId: string, raw: z.input<typeof BsaSuspicionListQuery>): Promise<BsaSuspicionListResponse> {
    const q = parseInput(BsaSuspicionListQuery, raw);
    await loadAnalysis(this.repo, ctx, analysisId, 'read');
    const [page, counts, txns] = await Promise.all([
      this.repo.suspicions.list(analysisId, { status: q.status, flag: q.flag }, { limit: q.limit, offset: q.offset }),
      this.repo.suspicions.counts(analysisId),
      this.repo.transactions.loadAll(analysisId),
    ]);
    const byId = new Map(txns.map((t) => [t.id, t]));
    return { items: page.items.map((s) => toView(s, byId)), total: page.total, offset: page.offset, limit: page.limit, counts: buildCounts(counts) };
  }

  async resolve(ctx: RequestContext, analysisId: string, raw: z.input<typeof BsaResolveSuspicionsRequest>): Promise<ResolveResult> {
    const input = parseInput(BsaResolveSuspicionsRequest, raw);
    return this.repo.runInTransaction(async (r) => {
      const analysis = await loadAnalysis(r, ctx, analysisId, 'write');
      const found = await r.suspicions.getMany(analysisId, input.ids);
      if (found.length === 0) throw notFound('SUSPICION_NOT_FOUND');
      const open = found.filter((s) => s.status === 'PENDING');
      if (open.length === 0) throw conflict('SUSPICION_ALREADY_RESOLVED');

      const txns = new Map((await r.transactions.loadAll(analysisId)).map((t) => [t.id, t]));
      const touched = [...new Set(open.flatMap((s) => s.transactionIds))].map((id) => txns.get(id)).filter((t): t is BsaTransactionRecord => t !== undefined && !t.isOwnTransfer);

      const impact = await this.applyCategories(r, analysis, input, touched, ctx.userId);

      const resolved = await r.suspicions.resolve(analysisId, open.map((s) => s.id), {
        action: input.action, newCategoryCode: input.categoryCode ?? null, comment: input.comment ?? null, by: ctx.userId, at: this.clock.now(),
      });
      await r.events.append({
        analysisId,
        action: BSA_EVENT.SUSPICIONS_RESOLVED,
        actorId: ctx.userId,
        at: this.clock.now(),
        detail: { resolved, action: input.action, categoryCode: input.categoryCode ?? null, flags: [...new Set(open.map((s) => s.flag))] },
      });
      const result = await this.recalc.run(r, { analysisId, actorId: ctx.userId, reason: 'SUSPICION_REVIEW', refreshClassification: false });
      return {
        resolved,
        skipped: input.ids.length - resolved,
        pending: await r.suspicions.countPending(analysisId),
        changedTransactions: impact.changed,
        unchangedTransactions: impact.unchanged,
        summary: result.summary,
        repushRequired: analysis.status === 'ANALYZED',
      };
    });
  }

  /** `touched` = хүлээгдэж буй дохионы өөрийн дансных биш гүйлгээ. EXCLUDE хоёр чиглэлийг, RECLASSIFY зөвхөн ангиллын чиглэлтэйг солино; APPROVE юуг ч биш. */
  private async applyCategories(r: BsaRepository, analysis: BsaAnalysisRecord, input: BsaResolveSuspicionsRequest, touched: BsaTransactionRecord[], by: string): Promise<CategoryImpact> {
    if (input.action === 'EXCLUDE') {
      const income = await this.setCategory(r, analysis.id, touched.filter((t) => t.direction === 'INCOME'), EXCLUDE_INCOME_CATEGORY, by);
      const expense = await this.setCategory(r, analysis.id, touched.filter((t) => t.direction === 'EXPENSE'), EXCLUDE_EXPENSE_CATEGORY, by);
      return { changed: income + expense, unchanged: 0 };
    }
    if (input.action === 'RECLASSIFY') {
      const code = input.categoryCode as string;
      const cat = (await r.config.listCategories(analysis.orgId)).find((c) => c.code === code && c.isActive);
      if (!cat) throw unprocessable('CATEGORY_INVALID');
      const matching = touched.filter((t) => t.direction === cat.direction);
      if (matching.length === 0) throw unprocessable('CATEGORY_INVALID');
      return { changed: await this.setCategory(r, analysis.id, matching, code, by), unchanged: touched.length - matching.length };
    }
    return NO_IMPACT;
  }

  /** Буцаах: репозиторийн үнэхээр шинэчилсэн мөрийн тоо */
  private async setCategory(r: BsaRepository, analysisId: string, rows: BsaTransactionRecord[], code: string, by: string): Promise<number> {
    if (rows.length === 0) return 0;
    try {
      return await r.transactions.setManualCategory(analysisId, rows.map((t) => t.id), code, by);
    } catch (e) {
      if (e instanceof BsaInvalidError) throw unprocessable('CATEGORY_INVALID');
      throw e;
    }
  }
}

function toView(s: BsaSuspicionRecord, byId: ReadonlyMap<string, BsaTransactionRecord>): BsaSuspicionView {
  const txns = s.transactionIds.map((id) => byId.get(id)).filter((t): t is BsaTransactionRecord => t !== undefined).map(toTransactionView);
  txns.sort((a, b) => a.txnDate.localeCompare(b.txnDate) || (a.txnTime ?? '').localeCompare(b.txnTime ?? ''));
  return {
    id: s.id,
    flag: s.flag,
    status: s.status,
    action: s.action,
    confidence: s.confidence,
    comment: s.comment,
    resolvedBy: s.resolvedBy,
    resolvedAt: s.resolvedAt ? s.resolvedAt.toISOString() : null,
    firstDate: txns[0]?.txnDate ?? '',
    totalAmount: Math.round(txns.reduce((a, t) => a + t.amount, 0) * 100) / 100,
    transactionIds: s.transactionIds,
    transactions: txns.map((t) => ({
      id: t.id, txnDate: t.txnDate, txnTime: t.txnTime, direction: t.direction, amount: t.amount, description: t.description,
      counterpartyAccount: t.counterpartyAccount, categoryCode: t.categoryCode,
    })),
  };
}
