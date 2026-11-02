// Модуль 8 — Тооцоолол (FR-8.1…8.6, BR-1…BR-5). Цэвэр логик `@los/calc` `underwrite`; энд зөвхөн хадгалалт, сонголт, event.
// Бүх бичилт НЭГ транзакцид: (org, application)-ийн advisory lock → мөр → ScoringCompleted outbox (CLAUDE.md §3.2.4).
// BR утга (ӨОХ/ӨТЧХ/LTV/жин, stress) энд HARDCODE БИШ — origination `setting`-ээс `ScoreRequest.policy`/`stress` болж ирнэ.
import { Injectable } from '@nestjs/common';
import type { Calculation } from '.prisma/client-scoring';
import { underwrite } from '@los/calc';
import {
  type CalcMethod, type CalculationRecord, type MarkCalculationStaleRequest, type RequestContext, type ScoreRequest, type SelectMethodRequest,
  type UnderwritePersistRequest, type UnderwriteResult,
} from '@los/contracts';
import { buildEvent, enqueueOutbox } from '@los/database';
import { Clock } from '@los/nest-common';
import { PrismaService, type Tx } from '../../prisma.service';
import { latestSoscoScore } from '../sosco/sosco-result.query';
import { resultOf, toCreateData, toRecord } from './calculation.mapper';
import { calculationNotFound, calculationStale, methodNotApplicable, requireUserId, TX_OPTIONS } from './scoring-http';

interface Selection { method: CalcMethod; manual: boolean; reason: string | null }

/** Сүүлийн тооцоолол: computed_at хамгийн шинэ, ижил бол id (FR-8). `persist` нь computed_at-ийг хатуу өсөх болгодог тул ихэнхдээ тэнцэхгүй */
const latestOf = (tx: Pick<Tx, 'calculation'>, orgId: string, applicationId: string): Promise<Calculation | null> =>
  tx.calculation.findFirst({ where: { orgId, applicationId }, orderBy: [{ computedAt: 'desc' }, { id: 'desc' }] });

/** (org, application) тутамд бичилтүүдийг цувуулна: зэрэг `persist` бүр амжилттай, "сүүлийн" нь тодорхой байна */
const lockApplication = (tx: Tx, orgId: string, applicationId: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`calculation:${orgId}:${applicationId}`}, 0))`;

/** FR-8.2: хэрэглэгчийн сонголт хэрэглэгдэх аргад л хүчинтэй (FR-8.6); өгөөгүй бол BR-4 автомат; орлого байхгүй бол сонголтгүй */
function chooseMethod(result: UnderwriteResult, requested: CalcMethod | null | undefined, reason: string | null | undefined): Selection | null {
  if (requested) {
    if (!result.methods.find((m) => m.method === requested)?.applicable) throw methodNotApplicable(requested);
    return { method: requested, manual: true, reason: reason ?? null };
  }
  const auto = result.autoSelected;
  if (auto && result.methods.find((m) => m.method === auto)?.applicable) return { method: auto, manual: false, reason: null };
  return null;
}

@Injectable()
export class UnderwritingService {
  constructor(private readonly db: PrismaService, private readonly clock: Clock) {}

  /** FR-8.3 · slider: хадгалахгүй, event-гүй, DB-д хүрэхгүй */
  preview(request: ScoreRequest): UnderwriteResult {
    return underwrite(request);
  }

  /**
   * FR-8.1/8.2 · Шинэ `calculation` мөр. `selectedMethod` өгсөн бөгөөд хэрэглэгдэх бол MANUAL, хэрэглэгдэхгүй бол 422 METHOD_NOT_APPLICABLE
   * (юу ч хадгалагдахгүй); өгөөгүй бол BR-4 автомат (AUTO). Арга сонгогдсон бол `ScoringCompleted` нэг транзакцид outbox-д.
   */
  async persist(ctx: RequestContext, body: UnderwritePersistRequest): Promise<CalculationRecord> {
    const actorId = requireUserId(ctx);
    const request = body.request;
    const result = underwrite(request);
    const selection = chooseMethod(result, body.selectedMethod, body.selectionReason);

    const row = await this.db.$transaction(async (tx) => {
      await lockApplication(tx, ctx.orgId, request.applicationId);
      // computed_at хатуу өснө (миллисекундын тэнцэл, цагийн хазайлтад "сүүлийн" нь сүүлд хадгалагдсан нь хэвээр)
      const previous = await latestOf(tx, ctx.orgId, request.applicationId);
      const now = this.clock.now();
      const computedAt = previous && now.getTime() <= previous.computedAt.getTime() ? new Date(previous.computedAt.getTime() + 1) : now;
      const created = await tx.calculation.create({ data: toCreateData({ orgId: ctx.orgId, customerId: body.customerId, computedAt, actorId, request, result, selection }) });
      if (selection) await this.announce(tx, ctx, created, result, selection.method);
      return created;
    }, TX_OPTIONS);
    return toRecord(row);
  }

  /** Сүүлийн тооцоолол · 404 CALCULATION_NOT_FOUND */
  async latest(ctx: RequestContext, applicationId: string): Promise<CalculationRecord> {
    const row = await latestOf(this.db, ctx.orgId, applicationId);
    if (!row) throw calculationNotFound();
    return toRecord(row);
  }

  /** FR-8.2 · гараар арга сонгох (MANUAL). 404 → 409 CALCULATION_STALE → 422 METHOD_NOT_APPLICABLE; амжилттай бол `ScoringCompleted` */
  async select(ctx: RequestContext, applicationId: string, body: SelectMethodRequest): Promise<CalculationRecord> {
    const actorId = requireUserId(ctx);
    const row = await this.db.$transaction(async (tx) => {
      await lockApplication(tx, ctx.orgId, applicationId);
      const latest = await latestOf(tx, ctx.orgId, applicationId);
      if (!latest) throw calculationNotFound();
      if (latest.isStale) throw calculationStale();
      const result = resultOf(latest);
      if (!result.methods.find((m) => m.method === body.method)?.applicable) throw methodNotApplicable(body.method);
      const updated = await tx.calculation.update({
        where: { id: latest.id },
        data: { selectedMethod: body.method, selectedBy: actorId, selectedReason: body.reason ?? null, selectedAt: this.clock.now(), updatedBy: actorId },
      });
      await this.announce(tx, ctx, updated, result, body.method);
      return updated;
    }, TX_OPTIONS);
    return toRecord(row);
  }

  /** FR-7.3 · нөхцөл өөрчлөгдөхөд сүүлийн тооцоолол хуучирна. Идемпотент: аль хэдийн хуучирсан бол өөрчлөхгүй (шалтгаан анхных хэвээр) */
  async markStale(ctx: RequestContext, applicationId: string, body: MarkCalculationStaleRequest): Promise<CalculationRecord> {
    const actorId = requireUserId(ctx);
    const row = await this.db.$transaction(async (tx) => {
      await lockApplication(tx, ctx.orgId, applicationId);
      const latest = await latestOf(tx, ctx.orgId, applicationId);
      if (!latest) throw calculationNotFound();
      if (latest.isStale) return latest;
      return tx.calculation.update({ where: { id: latest.id }, data: { isStale: true, staleReason: body.reason, updatedBy: actorId } });
    }, TX_OPTIONS);
    return toRecord(row);
  }

  /** `ScoringCompleted` (v1): soscoScore = үндсэн зээлдэгчийн сүүлийн sosco_result (байхгүй бол null); dtiPercent = сонгосон аргын burdenPercent */
  private async announce(tx: Tx, ctx: RequestContext, row: Calculation, result: UnderwriteResult, method: CalcMethod): Promise<void> {
    const soscoScore = await latestSoscoScore(tx, ctx.orgId, row.applicationId, row.customerId);
    const dtiPercent = result.methods.find((m) => m.method === method)?.burdenPercent ?? null;
    await enqueueOutbox(tx, buildEvent(ctx, 'ScoringCompleted', { applicationId: row.applicationId, selectedMethod: method, soscoScore, dtiPercent }, this.clock.now()));
  }
}
