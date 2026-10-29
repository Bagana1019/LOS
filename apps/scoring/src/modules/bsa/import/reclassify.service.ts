// BSA-FR-3.3 / 3.4 / 3.5: гар ангилал өөрчлөх (бөөнөөр, «ижил утгатай бүгдэд»), дүрэм санал болгох/хадгалах, ангилал/дүрмийн сан унших.
//  - Гар засвар (manualOverride) автомат ангилалд хэзээ ч дарагдахгүй; хадгалсны дараа дахин ангилж DTI-г шинэчилнэ («Хадгалах → дахин тооцоолох»).
//  - FEEDBACK дүрмийг АВТОМАТААР хадгалахгүй: санал болгосон хэв гүйлгээний утгаас гарсан тул хувийн нэр орсон байж болно. Зөвхөн
//    буцаана; ADMIN хянаж баталгаажуулаад `createRule`-аар хадгална.
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { BsaCreateRuleRequest, BsaReclassifyRequest, type BsaSummary } from '@los/contracts';
import type { z } from 'zod';
import { BSA_REPOSITORY, BsaDuplicateError, BsaInvalidError, type BsaRepository } from '../common/persistence';
import type { RequestContext } from '../common/infra.ports';
import {
  ClassifierService, ReclassifyError, type BsaCategoryDef, type BsaRuleDef, type ClassifiableTxn,
} from '../classify';
import { assertRole, loadAnalysis } from './access';
import { BSA_CLOCK, type Clock } from './import.defaults';
import { BSA_EVENT } from './import.events';
import { badRequest, conflict, notFound, BsaException } from './import.errors';
import { parseInput } from './parse-input';
import { RecalculationService } from './recalculation.service';

export interface ReclassifyResult {
  /** Гар ангилалд шилжсэн гүйлгээний тоо (сонгосон + ижил) */
  affected: number;
  selected: number;
  similar: number;
  /** BSA-FR-3.4: хадгалагдаагүй САНАЛ. `createRule`-аар ADMIN баталгаажуулна */
  suggestedRule: BsaRuleDef | null;
  summary: BsaSummary | null;
  /** ANALYZED шинжилгээ өөрчлөгдсөн ⇒ LOS-д дахин «Системрүү татах» хэрэгтэй */
  repushRequired: boolean;
}

export interface CreateRuleResult {
  rule: BsaRuleDef & { id: string };
  /** `analysisId` өгсөн үед дахин тооцсон хураангуй */
  summary: BsaSummary | null;
}

@Injectable()
export class ReclassifyService {
  constructor(
    @Inject(BSA_REPOSITORY) private readonly repo: BsaRepository,
    @Inject(ClassifierService) private readonly classifier: ClassifierService,
    @Inject(RecalculationService) private readonly recalc: RecalculationService,
    @Inject(BSA_CLOCK) private readonly clock: Clock,
  ) {}

  /** BSA-FR-3.3 */
  async reclassify(ctx: RequestContext, analysisId: string, raw: z.input<typeof BsaReclassifyRequest>): Promise<ReclassifyResult> {
    const input = parseInput(BsaReclassifyRequest, raw);
    return this.repo.runInTransaction(async (r) => {
      const analysis = await loadAnalysis(r, ctx, analysisId, 'write');
      const [categories, rows] = await Promise.all([r.config.listCategories(analysis.orgId), r.transactions.loadAll(analysisId)]);
      const txns: ClassifiableTxn[] = rows.map((t) => ({
        key: t.id,
        statementKey: t.statementKey,
        bank: null,
        txnDate: t.txnDate,
        txnTime: t.txnTime,
        direction: t.direction,
        amount: t.amount,
        description: t.description,
        counterpartyAccount: t.counterpartyAccount,
        counterpartyName: t.counterpartyName,
        manualCategoryCode: t.manualOverride ? t.categoryCode : null,
      }));

      let plan;
      try {
        plan = this.classifier.planReclassification({
          txns,
          selectedKeys: input.transactionIds,
          targetCategoryCode: input.categoryCode,
          applyToSimilar: input.applyToSimilar,
          similarBy: input.similarBy,
          categories,
        });
      } catch (e) {
        if (e instanceof ReclassifyError) throw mapReclassifyError(e);
        throw e;
      }

      let affected: number;
      try {
        affected = await r.transactions.setManualCategory(analysisId, plan.affectedKeys, input.categoryCode, ctx.userId);
      } catch (e) {
        if (e instanceof BsaInvalidError) throw badRequest('CATEGORY_INVALID');
        throw e;
      }
      await r.events.append({
        analysisId,
        action: BSA_EVENT.RECLASSIFIED,
        actorId: ctx.userId,
        at: this.clock.now(),
        detail: {
          category: input.categoryCode,
          selected: plan.selectedKeys.length,
          similar: plan.similarKeys.length,
          affected,
          similarBy: input.applyToSimilar ? input.similarBy : null,
          ruleSuggested: plan.suggestedRule !== null,
        },
      });
      const recalculated = await this.recalc.run(r, { analysisId, actorId: ctx.userId, reason: 'RECLASSIFY', refreshClassification: true });
      return {
        affected,
        selected: plan.selectedKeys.length,
        similar: plan.similarKeys.length,
        suggestedRule: plan.suggestedRule,
        summary: recalculated.summary,
        repushRequired: analysis.status === 'ANALYZED' && recalculated.summary !== null,
      };
    });
  }

  /**
   * BSA-FR-3.5 / 3.4: ADMIN дүрэм хадгална (түлхүүр үг, данс/нэр, regex). `validateRules`-аар шалгана: үл мэдэгдэх ангилал, чиглэл зөрөх,
   * аюултай regex (ReDoS хамгаалалт) татгалзана. `options.analysisId` өгвөл тэр шинжилгээний түүхэнд бичиж, дүрмийг хэрэглэн дахин ангилна.
   */
  async createRule(ctx: RequestContext, raw: z.input<typeof BsaCreateRuleRequest>, options: { analysisId?: string } = {}): Promise<CreateRuleResult> {
    assertRole(ctx, ['ADMIN']);
    const input = parseInput(BsaCreateRuleRequest, raw);
    return this.repo.runInTransaction(async (r) => {
      if (options.analysisId !== undefined) await loadAnalysis(r, ctx, options.analysisId, 'write');
      const categories = await r.config.listCategories(ctx.orgId);
      const candidate: BsaRuleDef = { direction: input.direction, matchType: input.matchType, pattern: input.pattern, categoryCode: input.categoryCode, priority: input.priority, source: input.source };
      const issues = this.classifier.validateRules([candidate], categories);
      // Дүрмийн хэв (pattern) хувийн нэр агуулж болох тул алдаанд давтахгүй: зөвхөн код
      if (issues.length > 0) throw badRequest('RULE_INVALID', { issues: issues.map((i) => i.code) });
      let rule: BsaRuleDef & { id: string };
      try {
        rule = await r.config.createRule(ctx.orgId, candidate, ctx.userId);
      } catch (e) {
        if (e instanceof BsaDuplicateError) throw conflict('RULE_DUPLICATE');
        if (e instanceof BsaInvalidError) throw badRequest('RULE_INVALID');
        throw e;
      }
      let summary: BsaSummary | null = null;
      if (options.analysisId !== undefined) {
        await r.events.append({
          analysisId: options.analysisId,
          action: BSA_EVENT.RULE_CREATED,
          actorId: ctx.userId,
          at: this.clock.now(),
          detail: { ruleId: rule.id, matchType: rule.matchType, source: rule.source, category: rule.categoryCode, priority: rule.priority },
        });
        summary = (await this.recalc.run(r, { analysisId: options.analysisId, actorId: ctx.userId, reason: 'RULE_CREATED', refreshClassification: true })).summary;
      }
      return { rule, summary };
    });
  }

  /** BSA-FR-3.3: reclassify дэлгэцийн ангиллын сан (бүх үүрэг). Анхдагчаар зөвхөн идэвхтэй */
  async listCategories(ctx: RequestContext, options: { includeInactive?: boolean } = {}): Promise<BsaCategoryDef[]> {
    const all = await this.repo.config.listCategories(ctx.orgId);
    return options.includeInactive ? all : all.filter((c) => c.isActive);
  }

  /** BSA-FR-3.5: дүрмийн сан. Хэв нь гүйлгээний утгаас гарсан (нэр агуулж болох) тул ЗӨВХӨН ADMIN */
  async listRules(ctx: RequestContext): Promise<Array<BsaRuleDef & { id: string }>> {
    assertRole(ctx, ['ADMIN']);
    return this.repo.config.listRules(ctx.orgId);
  }
}

function mapReclassifyError(e: ReclassifyError): BsaException {
  switch (e.code) {
    case 'EMPTY_SELECTION':
      return badRequest('INVALID_REQUEST', { reason: e.code });
    case 'SELECTION_NOT_FOUND':
      return notFound('TRANSACTION_NOT_FOUND');
    default:
      // UNKNOWN_CATEGORY | CATEGORY_INACTIVE | DIRECTION_MISMATCH
      return new BsaException(HttpStatus.BAD_REQUEST, 'CATEGORY_INVALID', { reason: e.code });
  }
}

