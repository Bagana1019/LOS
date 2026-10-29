import { Inject, Injectable, Logger } from '@nestjs/common';
import type { LoanApplication, Prisma } from '.prisma/client-origination';
import {
  MarkCalculationStaleRequest, hasPermission,
  type CalculationRecord, type MethodReason, type RequestContext, type ScoreOverview, type ScorePreviewRequest, type ScorePreviewResponse, type SelectMethodRequest, type SoscoSummary,
} from '@los/contracts';
import { recordAudit } from '@los/database';
import { Clock, DomainError } from '@los/nest-common';
import { PrismaService, type Tx } from '../../prisma.service';
import { ApplicationAccessService } from '../../shared/application-access.service';
import {
  ScoreInputAssembler, buildSoscoInput, limitViolations, type AssembledInput, type AssembledTerms,
} from './score-input.assembler';
import {
  buildSnapshot, isEditableStatus, overlayStale, planScoreStep, readSnapshot, toSoscoSummary, type CalcSnapshot, type SoscoFacts,
} from './score.rules';
import { SCORING_CLIENT, type ScoringClient } from './scoring.client';

const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 };
const SOSCO_DEGRADABLE = new Set(['SOSCO_MODEL_NOT_FOUND', 'INVALID_SOSCO_MODEL']);
const STALE_REASON_FALLBACK = 'Оролт өөрчлөгдсөн';

export interface MarkStaleResult {
  /** `score` алхам COMPLETED → STALE болсон */
  stepMarked: boolean;
  /** scoring-ийн тооцоолол `is_stale=true` болсон (scoring унасан бол false — алхам нь эцсийн эх сурвалж) */
  scoringMarked: boolean;
}

/**
 * FR-8 · origination фасад. Тооцоололыг scoring хийнэ (`@los/calc` underwrite); энд: оролт цуглуулах (assembler), scoring дуудах,
 * хүсэлтийн `selected_calc_method` / `calc_snapshot_json` / алхам `score` / аудитыг НЭГ транзакцид шинэчлэх, хүрээ/эрх (NFR-3).
 */
@Injectable()
export class ScoreService {
  private readonly logger = new Logger(ScoreService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ApplicationAccessService,
    private readonly assembler: ScoreInputAssembler,
    @Inject(SCORING_CLIENT) private readonly scoring: ScoringClient,
    private readonly clock: Clock,
  ) {}

  // ── унших ──────────────────────────────────────────────────────────────────────────

  /**
   * Нөхцөл, хязгаар, саад + сүүлийн тооцоолол + Sosco. Scoring унасан үед GET нь 503 болохгүй: нөхцөл/хязгаар/саадыг буцааж
   * `calculation`, `sosco` = null (best effort; contract-д "унасан" тэмдэг байхгүй, бичих үйлдэл нь 503 SCORING_UNAVAILABLE өгч тодорхой мэдэгдэнэ).
   */
  async overview(ctx: RequestContext, applicationId: string): Promise<ScoreOverview> {
    const app = await this.access.load(ctx, applicationId, 'read');
    const [base, customerId, step] = await Promise.all([this.assembler.terms(app), this.primaryCustomerId(app), this.scoreStep(app.id)]);
    const [calculation, sosco] = await Promise.all([
      this.bestEffort(ctx, 'latest', () => this.scoring.latest(ctx, app.id)),
      customerId ? this.bestEffort(ctx, 'latestSosco', () => this.scoring.latestSosco(ctx, app.id, customerId)) : Promise.resolve(null),
    ]);
    return this.view(ctx, app, base, overlayStale(calculation, step), sosco);
  }

  /** FR-8.3 · slider. Хадгалахгүй, event-гүй. Өгсөн талбар product-ийн хязгаараас гарвал 422 OUT_OF_PRODUCT_LIMITS (BR-6). */
  async preview(ctx: RequestContext, applicationId: string, overrides: ScorePreviewRequest): Promise<ScorePreviewResponse> {
    const app = await this.access.load(ctx, applicationId, 'read');
    const assembled = await this.assembler.assemble(ctx, app, overrides);
    if (!assembled.request || !assembled.terms) throw termsMissing(assembled.blockers);
    const violations = limitViolations(overrides, assembled.limits);
    if (violations.length) throw new DomainError('OUT_OF_PRODUCT_LIMITS', 'Зээлийн нөхцөл бүтээгдэхүүний хязгаараас гарсан байна', 422, violations);
    const result = await this.scoring.preview(ctx, assembled.request);
    return { terms: assembled.terms, result };
  }

  // ── бичих ──────────────────────────────────────────────────────────────────────────

  /**
   * FR-8.1/8.2 · оролт цуглуулж → Sosco (persist) → underwrite (persist) → хүсэлт + алхам + аудит нэг транзакцид.
   * Sosco нь underwrite-аас ӨМНӨ хадгалагдана: `ScoringCompleted.soscoScore` шинэ оноог агуулах ёстой. Sosco-д LTV/DTI хэрэгтэй тул
   * эхлээд хадгалахгүй `preview`-ээр үр дүнг авна (ижил оролт → ижил үр дүн).
   */
  async calculate(ctx: RequestContext, applicationId: string): Promise<ScoreOverview> {
    const app = await this.access.load(ctx, applicationId, 'write');
    assertEditable(app);
    const input = await this.assembler.assemble(ctx, app);
    if (!input.request) throw termsMissing(input.blockers);
    const customerId = input.customerId;
    if (!customerId) throw new DomainError('PRIMARY_BORROWER_MISSING', 'Үндсэн зээлдэгч сонгоогүй байна. 1-р алхамд сонгоно уу', 422);

    const [previous, preview] = await Promise.all([this.scoring.latest(ctx, app.id), this.scoring.preview(ctx, input.request)]);
    // Өмнөх ГАР сонголтыг (боломжтой хэвээр бол) хадгална; боломжгүй болсон бол автомат (BR-4)
    const carried = previous?.selection === 'MANUAL' && previous.selectedMethod && preview.methods.find((m) => m.method === previous.selectedMethod)?.applicable ? previous : null;
    const method = carried?.selectedMethod ?? preview.autoSelected;

    const soscoResponse = await this.scoreSosco(ctx, app.id, customerId, buildSoscoInput(input.credit, input.bsa, preview, method));
    const record = await this.scoring.calculate(ctx, {
      request: input.request, customerId,
      ...(carried ? { selectedMethod: carried.selectedMethod, selectionReason: carried.selectionReason } : {}),
    });

    const sosco = soscoResponse ? toSoscoSummary(soscoResponse, customerId) : null;
    const applied = await this.applyOutcome(ctx, app.id, record, sosco && { score: sosco.score, grade: sosco.grade }, 'CALCULATION_COMPUTED');
    // Зэрэгцээ тооцоолол илүү шинэ үр дүнг аль хэдийн бичсэн бол түүнийг буцаана
    return applied ? this.view(ctx, app, input, record, sosco) : this.overview(ctx, app.id);
  }

  /** FR-8.2 · гараар арга сонгох. Тооцоолол хуучирсан бол 409 CALCULATION_STALE, хэрэглэгдэхгүй арга бол 422 METHOD_NOT_APPLICABLE (scoring). */
  async select(ctx: RequestContext, applicationId: string, body: SelectMethodRequest): Promise<ScoreOverview> {
    const app = await this.access.load(ctx, applicationId, 'write');
    assertEditable(app);
    // Алхам STALE бол scoring-д хуучирсан гэж мэдэгдээгүй байсан ч (markStale унасан) сонгохыг зөвшөөрөхгүй
    const step = await this.scoreStep(app.id);
    if (step?.status === 'STALE') throw new DomainError('CALCULATION_STALE', 'Тооцоолол хуучирсан байна. Дахин тооцоолсны дараа арга сонгоно уу', 409, { reason: step.staleReason });

    const record = await this.scoring.select(ctx, app.id, body);
    const latestSosco = record.customerId ? await this.bestEffort(ctx, 'latestSosco', () => this.scoring.latestSosco(ctx, app.id, record.customerId!)) : null;
    const previous = readSnapshot(app.calcSnapshotJson);
    const carried: SoscoFacts | null = !latestSosco && previous?.calculationId === record.id ? { score: previous.soscoScore, grade: previous.soscoGrade } : null;
    const applied = await this.applyOutcome(ctx, app.id, record, latestSosco ? { score: latestSosco.score, grade: latestSosco.grade } : carried, 'CALCULATION_METHOD_SELECTED');
    if (!applied) return this.overview(ctx, app.id);
    return this.view(ctx, app, await this.assembler.terms(app), record, latestSosco);
  }

  /**
   * FR-7.3 · Зээлийн нөхцөл / ЭТХ / оролцогч өөрчлөгдсөн үед Loan-terms, Schedule модуль дуудна (өөрчлөлтөө commit хийсний дараа; эрхийг тэд шалгасан).
   * Алхам `score` COMPLETED бол STALE (шалтгаантай) болно; scoring-ийн тооцоолол `is_stale=true`. Идемпотент.
   * Scoring унасан ч шидэхгүй: origination-ийн алхам нь эцсийн эх сурвалж (BR-7 илгээхийг хаана, `overview` хуучирсан гэж харуулна).
   */
  async markStale(ctx: RequestContext, applicationId: string, reason: string): Promise<MarkStaleResult> {
    // 200 тэмдэгтээс уртыг таслана; хоосон шалтгаан дуудагчийг унагаахгүй (дотоод дуудлага — 500 болгохгүй)
    const { reason: staleReason } = MarkCalculationStaleRequest.parse({ reason: reason.trim().slice(0, 200) || STALE_REASON_FALLBACK });
    const app = await this.prisma.loanApplication.findFirst({ where: { id: applicationId, orgId: ctx.orgId } });
    if (!app) throw new DomainError('APPLICATION_NOT_FOUND', 'Хүсэлт олдсонгүй', 404);

    const stepMarked = await this.prisma.$transaction(async (tx) => {
      const marked = await tx.loanApplicationStep.updateMany({
        where: { applicationId: app.id, orgId: app.orgId, stepKey: 'score', status: 'COMPLETED' },
        data: { status: 'STALE', staleReason },
      });
      if (marked.count === 0) return false;
      const snapshot = readSnapshot(app.calcSnapshotJson);
      await recordAudit(tx, {
        orgId: app.orgId, entity: 'CALCULATION', entityId: snapshot?.calculationId ?? app.id, action: 'CALCULATION_MARKED_STALE', actorId: ctx.userId,
        beforeJson: { step: 'COMPLETED' }, afterJson: { step: 'STALE', reason: staleReason }, applicationId: app.id, correlationId: ctx.correlationId,
      });
      return true;
    });

    let scoringMarked = false;
    try {
      await this.scoring.markStale(ctx, app.id, { reason: staleReason });
      scoringMarked = true;
    } catch (e) {
      if (!(e instanceof DomainError && e.code === 'SCORING_UNAVAILABLE')) throw e;
      this.logger.warn({ msg: 'scoring could not be told the calculation is stale; the step is stale', applicationId: app.id, correlationId: ctx.correlationId });
    }
    return { stepMarked, scoringMarked };
  }

  // ── дотоод ──────────────────────────────────────────────────────────────────────────

  /**
   * Нэг транзакц: хүсэлтийн мөрийг түгжиж → хоцорч ирсэн хуучин үр дүнг дарахгүй → `selected_calc_method`, `calc_snapshot_json` →
   * алхам `score` → аудит (NFR-4). `false` = илүү шинэ үр дүн аль хэдийн бичигдсэн (юу ч өөрчлөөгүй).
   */
  private async applyOutcome(ctx: RequestContext, applicationId: string, record: CalculationRecord, sosco: SoscoFacts | null, action: 'CALCULATION_COMPUTED' | 'CALCULATION_METHOD_SELECTED'): Promise<boolean> {
    const snapshot = buildSnapshot(record, sosco);
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM origination.loan_application WHERE id = ${applicationId} AND org_id = ${ctx.orgId} FOR UPDATE`;
      if (!locked.length) throw new DomainError('APPLICATION_NOT_FOUND', 'Хүсэлт олдсонгүй', 404);
      const app = await tx.loanApplication.findUniqueOrThrow({ where: { id: applicationId } });
      assertEditable(app); // түгжээ авсны дараа дахин (READ COMMITTED): энэ завсар илгээгдсэн байж болно
      const existing = readSnapshot(app.calcSnapshotJson);
      if (existing && Date.parse(existing.syncedAt) > Date.parse(snapshot.syncedAt)) return false;

      await tx.loanApplication.update({
        where: { id: applicationId },
        data: { selectedCalcMethod: snapshot.selectedMethod, calcSnapshotJson: snapshot as unknown as Prisma.InputJsonValue, updatedBy: ctx.userId },
      });
      await this.writeStep(tx, app, snapshot);
      await recordAudit(tx, {
        orgId: app.orgId, entity: 'CALCULATION', entityId: record.id, action, actorId: ctx.userId,
        beforeJson: { calculationId: existing?.calculationId ?? null, selectedMethod: app.selectedCalcMethod, selection: existing?.selection ?? null },
        afterJson: snapshot, applicationId: app.id, correlationId: ctx.correlationId,
      });
      return true;
    }, TX_OPTIONS);
  }

  private async writeStep(tx: Tx, app: LoanApplication, snapshot: CalcSnapshot): Promise<void> {
    const step = await tx.loanApplicationStep.findUnique({ where: { applicationId_stepKey: { applicationId: app.id, stepKey: 'score' } }, select: { id: true, status: true } });
    const plan = planScoreStep(step, snapshot.selectedMethod, this.clock.now());
    if (plan.kind === 'update') await tx.loanApplicationStep.update({ where: { id: plan.id }, data: { status: plan.status, completedAt: plan.completedAt, staleReason: null } });
    else if (plan.kind === 'create') await tx.loanApplicationStep.create({ data: { orgId: app.orgId, applicationId: app.id, stepKey: 'score', status: plan.status, completedAt: plan.completedAt } });
  }

  /** Sosco нь A/B/C-г хаахгүй: загвар байхгүй / хүчингүй бол (домэйн алдаа) бүрэлдэхүүнгүйгээр үргэлжилнэ. Scoring унасан бол 503. */
  private async scoreSosco(ctx: RequestContext, applicationId: string, customerId: string, input: ReturnType<typeof buildSoscoInput>) {
    try {
      return await this.scoring.scoreSosco(ctx, { applicationId, customerId, input, persist: true });
    } catch (e) {
      if (e instanceof DomainError && SOSCO_DEGRADABLE.has(e.code)) {
        this.logger.warn({ msg: 'sosco score skipped', code: e.code, applicationId, correlationId: ctx.correlationId });
        return null;
      }
      throw e;
    }
  }

  private async bestEffort<T>(ctx: RequestContext, op: string, fn: () => Promise<T | null>): Promise<T | null> {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof DomainError && e.code === 'SCORING_UNAVAILABLE')) throw e;
      this.logger.warn({ msg: 'scoring unavailable; degrading the overview', op, correlationId: ctx.correlationId });
      return null;
    }
  }

  private async primaryCustomerId(app: LoanApplication): Promise<string | null> {
    const row = await this.prisma.loanApplicationBorrower.findFirst({ where: { applicationId: app.id, orgId: app.orgId, role: 'PRIMARY' }, select: { customerId: true } });
    return row?.customerId ?? null;
  }

  private scoreStep(applicationId: string) {
    return this.prisma.loanApplicationStep.findUnique({ where: { applicationId_stepKey: { applicationId, stepKey: 'score' } }, select: { id: true, status: true, staleReason: true, updatedAt: true } });
  }

  private async view(ctx: RequestContext, app: LoanApplication, base: AssembledTerms | AssembledInput, calculation: CalculationRecord | null, sosco: SoscoSummary | null): Promise<ScoreOverview> {
    // ADMIN бүх хүсэлтэд бичих хүрээтэй ч `application:write` эрхгүй тул тооцоолох боломжгүй
    const editable = isEditableStatus(app.status) && hasPermission(ctx.roles, 'application:write') && (await this.access.can(ctx, app, 'write'));
    return { applicationId: app.id, editable, terms: base.saved, limits: base.limits, blockers: base.blockers, calculation, sosco };
  }
}

const assertEditable = (app: Pick<LoanApplication, 'status'>): void => {
  if (!isEditableStatus(app.status)) {
    throw new DomainError('APPLICATION_NOT_EDITABLE', 'Хүсэлт "Шинэ" эсвэл "Буцаасан" төлөвт байх үед л тооцоолол хийнэ', 409, { status: app.status });
  }
};

const termsMissing = (blockers: MethodReason[]): DomainError =>
  new DomainError('LOAN_TERMS_MISSING', blockers[0]?.message ?? 'Зээлийн нөхцөл бөглөгдөөгүй байна', 422, blockers);
