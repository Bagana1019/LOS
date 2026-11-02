// Sosco Score (дотоод, 0–1000, A–E): идэвхтэй загвараар `@los/calc` soscoScore. Docs/05 §3. FR-5.5 (оноо → үнэ тогтоолт).
// INSUFFICIENT_DATA нь 200-аар буцна, ХАДГАЛАГДАХГҮЙ (шатлал default-аар явна). Хадгалагдсан оноо загварын хувилбарыг (model_id) заана.
import { Injectable } from '@nestjs/common';
import type { Prisma } from '.prisma/client-scoring';
import { soscoScore } from '@los/calc';
import type { RequestContext, SoscoComponentBreakdown, SoscoScoreRequest, SoscoScoreResponse, SoscoSummary } from '@los/contracts';
import { Clock, notFound } from '@los/nest-common';
import { PrismaService } from '../../prisma.service';
import { requireUserId } from '../underwriting/scoring-http';
import { paramsOf } from './sosco-model.mapper';
import { assertValidModel, SoscoModelService } from './sosco-model.service';
import { latestResult } from './sosco-result.query';

/** `breakdown_json`: тайлбарт зориулсан задрал + coverage */
interface Breakdown { components: SoscoComponentBreakdown[]; coverage: number }

/**
 * Prisma Json-ийн бичилт (query engine) 17 оронтой float-ийг 1 ULP хазайлгаж болдог тул (жишээ нь 3/14: 0.21428571428571427 → 0.2142857142857143),
 * задралын бутархай утгыг 15 оноот цифрт тогтворжуулж хадгална ба хариуд ч ЯГ ТЭГЭЭР буцаана — POST /sosco/score ба GET /sosco/results/latest ижил байна.
 */
const stable = (n: number): number => Number(n.toPrecision(15));
export const stableComponents = (components: SoscoComponentBreakdown[]): SoscoComponentBreakdown[] =>
  components.map((c) => ({ ...c, normalized: c.normalized === null ? null : stable(c.normalized), effectiveWeight: stable(c.effectiveWeight) }));

@Injectable()
export class SoscoService {
  constructor(private readonly db: PrismaService, private readonly models: SoscoModelService, private readonly clock: Clock) {}

  /** `persist` (анхдагч true) ба status SCORED үед `sosco_result` мөр үүсгэнэ. Хадгалагдаагүй бол `resultId: null` */
  async score(ctx: RequestContext, body: SoscoScoreRequest): Promise<SoscoScoreResponse> {
    const actorId = body.persist ? requireUserId(ctx) : null;
    const model = await this.models.ensureActiveModel(ctx.orgId);
    const params = paramsOf(model);
    // Хадгалсан загвар эвдэрсэн бол (гараар засварласан) 500 биш 422 INVALID_SOSCO_MODEL — origination оноог "мэдэгдэхгүй" гэж үзнэ
    assertValidModel(params);
    const scored = soscoScore(body.input, params.weights, params.gradeThresholds, params.curves, model.version);
    const result = { ...scored, components: stableComponents(scored.components) };
    const computedAt = this.clock.now();

    let resultId: string | null = null;
    if (result.status === 'SCORED' && body.persist) {
      const breakdown: Breakdown = { components: result.components, coverage: result.coverage };
      const row = await this.db.soscoResult.create({
        data: {
          orgId: ctx.orgId, applicationId: body.applicationId, customerId: body.customerId, modelId: model.id,
          score: result.score as number, grade: result.grade as string,
          inputsJson: body.input as unknown as Prisma.InputJsonValue, breakdownJson: breakdown as unknown as Prisma.InputJsonValue,
          computedAt, createdBy: actorId, updatedBy: actorId,
        },
      });
      resultId = row.id;
    }
    return { ...result, resultId, modelId: model.id, computedAt: computedAt.toISOString() };
  }

  /** Үндсэн зээлдэгчийн сүүлийн оноо · 404 NOT_FOUND (оноо хараахан байхгүй — origination үүнийг "null" гэж ойлгоно) */
  async latest(ctx: RequestContext, applicationId: string, customerId: string): Promise<SoscoSummary> {
    const row = await latestResult(this.db, ctx.orgId, applicationId, customerId);
    if (!row) throw notFound('Sosco оноо');
    const breakdown = (row.breakdownJson ?? { components: [], coverage: 0 }) as unknown as Breakdown;
    return {
      resultId: row.id,
      customerId: row.customerId,
      status: 'SCORED',
      score: row.score,
      grade: row.grade as SoscoSummary['grade'],
      coverage: breakdown.coverage,
      components: breakdown.components,
      modelVersion: row.model.version,
      computedAt: row.computedAt.toISOString(),
    };
  }
}
