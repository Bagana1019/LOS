// Sosco Score загвар (sosco_model): хувилбартай, байгууллага тутамд НЭГ идэвхтэй. Docs/05 §3.
// Хадгалах = шинэ хувилбар (өмнөх нь идэвхгүй, мөр устахгүй — sosco_result.model_id түүхийг заана) + SettingsChanged outbox (нэг транзакц).
import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma, SoscoModel } from '.prisma/client-scoring';
import { DEFAULT_SOSCO_CURVES, DEFAULT_SOSCO_GRADE_THRESHOLDS, DEFAULT_SOSCO_WEIGHTS, validateSoscoModel } from '@los/calc';
import { SaveSoscoModelRequest, type RequestContext, type SoscoModelView } from '@los/contracts';
import { buildEvent, enqueueOutbox } from '@los/database';
import { Clock } from '@los/nest-common';
import { PrismaService, type Tx } from '../../prisma.service';
import { scoringError, requireUserId, TX_OPTIONS } from '../underwriting/scoring-http';
import { curvesOf, toModelView, type ModelParams } from './sosco-model.mapper';

/** SettingsChanged.key (CLAUDE.md §3.2.8) */
export const SOSCO_MODEL_SETTING_KEY = 'sosco.model';

const INVALID_MODEL_MESSAGE = 'Sosco загвар буруу байна: жингийн нийлбэр 1, зэргийн босго чанд буурах (E = 0), муруй хүчинтэй байх ёстой';

/** Байгууллага тутмын нэг түгжээ: ensure/save зэрэг ажиллахад хоёр идэвхтэй загвар үүсэхгүй */
const lockOrg = (tx: Tx, orgId: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`sosco_model:${orgId}`}, 0))`;

const activeOf = (db: Pick<Tx, 'soscoModel'>, orgId: string): Promise<SoscoModel | null> =>
  db.soscoModel.findFirst({ where: { orgId, isActive: true }, orderBy: { version: 'desc' } });

const asJson = (v: unknown): Prisma.InputJsonValue => v as Prisma.InputJsonValue;

/** @los/calc-ийн RangeError → 422 INVALID_SOSCO_MODEL (мессеж монгол; техникийн шалтгаан `details.reason`-д, утгад PII байхгүй) */
export function assertValidModel(p: ModelParams): void {
  try {
    validateSoscoModel(p.weights, p.gradeThresholds, p.curves);
  } catch (e) {
    if (e instanceof RangeError) throw scoringError('INVALID_SOSCO_MODEL', INVALID_MODEL_MESSAGE, HttpStatus.UNPROCESSABLE_ENTITY, { reason: e.message });
    throw e;
  }
}

@Injectable()
export class SoscoModelService {
  constructor(private readonly db: PrismaService, private readonly clock: Clock) {}

  /**
   * Идэвхтэй загварыг буцаана; байгууллагад идэвхтэй загвар байхгүй бол DEMO v1-ийг (`@los/calc` DEFAULT_SOSCO_*) үүсгэнэ.
   * Race-safe: байгууллагын advisory lock дотор дахин шалгана — зэрэг эхний дуудлагууд яг НЭГ загвар үүсгэнэ.
   */
  async ensureActiveModel(orgId: string): Promise<SoscoModel> {
    const existing = await activeOf(this.db, orgId);
    if (existing) return existing;
    return this.db.$transaction(async (tx) => {
      await lockOrg(tx, orgId);
      const again = await activeOf(tx, orgId);
      if (again) return again;
      const { _max } = await tx.soscoModel.aggregate({ where: { orgId }, _max: { version: true } });
      return tx.soscoModel.create({
        data: {
          orgId, version: (_max.version ?? 0) + 1, isActive: true,
          weightsJson: asJson(DEFAULT_SOSCO_WEIGHTS), gradeThresholdsJson: asJson(DEFAULT_SOSCO_GRADE_THRESHOLDS), paramsJson: asJson(DEFAULT_SOSCO_CURVES),
          createdBy: 'system', updatedBy: 'system',
        },
      });
    }, TX_OPTIONS);
  }

  async getActive(ctx: RequestContext): Promise<SoscoModelView> {
    return toModelView(await this.ensureActiveModel(ctx.orgId));
  }

  /** Бүх хувилбар, шинэ нь эхэнд */
  async list(ctx: RequestContext): Promise<SoscoModelView[]> {
    const rows = await this.db.soscoModel.findMany({ where: { orgId: ctx.orgId }, orderBy: { version: 'desc' } });
    return rows.map(toModelView);
  }

  /**
   * Шинэ хувилбар үүсгэж идэвхжүүлнэ (`settings:manage` — controller). zod + `validateSoscoModel` → 422 INVALID_SOSCO_MODEL.
   * `curves` өгөөгүй бол идэвхтэй загварын муруйг хадгална (жин/босго засахад муруй алдагдахгүй), идэвхтэй загвар байхгүй бол DEMO.
   */
  async save(ctx: RequestContext, body: SaveSoscoModelRequest): Promise<SoscoModelView> {
    const actorId = requireUserId(ctx);
    const parsed = SaveSoscoModelRequest.safeParse(body);
    if (!parsed.success) {
      throw scoringError('INVALID_SOSCO_MODEL', INVALID_MODEL_MESSAGE, HttpStatus.UNPROCESSABLE_ENTITY, parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), code: i.code })));
    }
    const { weights, gradeThresholds } = parsed.data;
    const saved = await this.db.$transaction(async (tx) => {
      await lockOrg(tx, ctx.orgId);
      const active = await activeOf(tx, ctx.orgId);
      const curves = parsed.data.curves ?? (active ? curvesOf(active) : structuredClone(DEFAULT_SOSCO_CURVES));
      assertValidModel({ weights, gradeThresholds, curves });
      const { _max } = await tx.soscoModel.aggregate({ where: { orgId: ctx.orgId }, _max: { version: true } });
      await tx.soscoModel.updateMany({ where: { orgId: ctx.orgId, isActive: true }, data: { isActive: false, updatedBy: actorId } });
      const created = await tx.soscoModel.create({
        data: {
          orgId: ctx.orgId, version: (_max.version ?? 0) + 1, isActive: true,
          weightsJson: asJson(weights), gradeThresholdsJson: asJson(gradeThresholds), paramsJson: asJson(curves),
          createdBy: actorId, updatedBy: actorId,
        },
      });
      await enqueueOutbox(tx, buildEvent(ctx, 'SettingsChanged', { key: SOSCO_MODEL_SETTING_KEY, productId: null }, this.clock.now()));
      return created;
    }, TX_OPTIONS);
    return toModelView(saved);
  }
}
