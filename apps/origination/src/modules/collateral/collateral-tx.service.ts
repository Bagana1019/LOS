import { Injectable } from '@nestjs/common';
import type { BorrowerRole, CollateralMutationResponse, RequestContext } from '@los/contracts';
import { recordAudit } from '@los/database';
import { Clock, DomainError } from '@los/nest-common';
import type { LoanApplication } from '.prisma/client-origination';
import type { Tx } from '../../prisma.service';
import type { CollateralRow } from './collateral-view';
import { DomainEvents } from '../../shared/domain-events';
import { isOwnerRole, bestRole } from './collateral-ownership';
import { planCollateralStepUpdate } from './collateral-steps';
import { CollateralGateService, type CollateralSnapshot } from './collateral-gate.service';
import { REGISTER_PLEDGOR_HINT } from './collateral.constants';

export type CollateralChange = 'ADDED' | 'UPDATED' | 'REMOVED' | 'VALUED' | 'OWNERSHIP_CHECKED' | 'ENCUMBRANCE_CHECKED' | 'DOCUMENT_CHANGED' | 'PLEDGE_REGISTERED' | 'RELEASED';

/** Төлөвийн дүрэм бүрийн 409 алдаа (тогтвортой код + монгол мессеж). */
export interface StatusRule { statuses: readonly string[]; code: string; message: string }

export const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 };

export interface FinishOptions {
  /** Мутаци хийсэн барьцаа (event, аудитын entityId). */
  collateralId?: string;
  assetType?: string;
  change?: CollateralChange;
  /** Аудитын үйлдэл (`COLLATERAL_CREATED` …). `change`-тэй хамт. */
  action?: string;
  before?: unknown;
  after?: unknown;
  /** Барьцааны бүрдэл/үнэлгээ өөрчлөгдсөн → `score` алхам STALE (planCollateralStepUpdate). */
  scoreAffected?: boolean;
  /** false → алхамд хүрэхгүй (ACTIVE зээлийн дахин үнэлгээ, ЭБ бүртгэл, чөлөөлөлт). */
  updateSteps: boolean;
  /** Алхам өөрчлөгдсөн үед л аудит бичнэ (recheck). */
  auditStepChangeOnly?: boolean;
}

/**
 * Барьцааны мутаци бүрийн ЗОРИУЛАЛТ: нэг транзакц { хүсэлтийн мөрийг FOR UPDATE-ээр түгжих → төлөв шалгах → бичих → G0 дахин тооцох → 5-р алхам шинэчлэх →
 * аудит + CollateralChanged outbox }. borrower модулийн `begin()`-тэй ижил загвар (docs/00-foundation.md §3).
 */
@Injectable()
export class CollateralTxService {
  constructor(private readonly gate: CollateralGateService, private readonly events: DomainEvents, private readonly clock: Clock) {}

  /** Хүсэлтийн мөрийг түгжиж сериалчилна (төлөв шалгахгүй); түгжээ авсны дараа дахин уншина (READ COMMITTED). */
  async lock(tx: Tx, orgId: string, applicationId: string): Promise<LoanApplication> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM origination.loan_application WHERE id = ${applicationId} AND org_id = ${orgId} FOR UPDATE`;
    if (!locked.length) throw new DomainError('APPLICATION_NOT_FOUND', 'Хүсэлт олдсонгүй', 404);
    return tx.loanApplication.findUniqueOrThrow({ where: { id: applicationId } });
  }

  /** `lock` + төлвийн дүрэм (хүсэлт өөрчлөгдсөн бол 409). */
  async begin(tx: Tx, ctx: RequestContext, applicationId: string, rule: StatusRule): Promise<LoanApplication> {
    const app = await this.lock(tx, ctx.orgId, applicationId);
    if (!rule.statuses.includes(app.status)) throw new DomainError(rule.code, rule.message, 409, { status: app.status });
    return app;
  }

  /** Хүсэлтийн барьцааг баримтын хамт уншина; олдохгүй бол 404 COLLATERAL_NOT_FOUND. */
  async row(db: Tx, applicationId: string, collateralId: string): Promise<CollateralRow> {
    const row = await db.collateral.findFirst({ where: { id: collateralId, applicationId }, include: { documents: true } });
    if (!row) throw new DomainError('COLLATERAL_NOT_FOUND', 'Барьцаа олдсонгүй', 404);
    return row;
  }

  /** Түгжээ аваагүй урьдчилсан шалгалт (гадны дуудлага хийхээс өмнө хурдан татгалзах). */
  assertStatus(app: Pick<LoanApplication, 'status'>, rule: StatusRule): void {
    if (!rule.statuses.includes(app.status)) throw new DomainError(rule.code, rule.message, 409, { status: app.status });
  }

  /**
   * Өмчлөгч нь хүсэлтийн оролцогч (PRIMARY / CO_BORROWER / PLEDGOR) байх ёстой (FR-6.5).
   * Оролцогч биш → 422 OWNER_NOT_ON_APPLICATION ("Барьцаалагч бүртгэнэ үү"); зөвхөн батлан даагч → 422 OWNER_NOT_PLEDGOR.
   */
  async requireOwner(db: Tx, applicationId: string, ownerCustomerId: string): Promise<BorrowerRole> {
    const rows = await db.loanApplicationBorrower.findMany({ where: { applicationId, customerId: ownerCustomerId }, select: { role: true } });
    const role = bestRole(rows.map((r) => r.role as BorrowerRole));
    if (!role) throw new DomainError('OWNER_NOT_ON_APPLICATION', `Өмчлөгч хүсэлтийн оролцогч биш байна. ${REGISTER_PLEDGOR_HINT}`, 422);
    if (!isOwnerRole(role)) {
      throw new DomainError('OWNER_NOT_PLEDGOR', 'Энэ хүн зөвхөн "Батлан даагч" дүрээр бүртгэгдсэн тул барьцаа хөрөнгийн өмчлөгч байж болохгүй. 1-р алхамд "Барьцаалагч" дүрээр нэмж бүртгэнэ үү', 422);
    }
    return role;
  }

  /** Бичилтийн дараа: G0 дахин тооцох, 5-р алхам (+ score) шинэчлэх, аудит, CollateralChanged. */
  async finish(tx: Tx, ctx: RequestContext, app: LoanApplication, o: FinishOptions): Promise<CollateralSnapshot> {
    const snap = await this.gate.snapshot(tx, app);
    let stepChanged = false;
    if (o.updateSteps) {
      const steps = await tx.loanApplicationStep.findMany({ where: { applicationId: app.id }, select: { id: true, stepKey: true, status: true, staleReason: true } });
      const updates = planCollateralStepUpdate(steps, { gateComplete: snap.evaluation.gate.complete, scoreAffected: o.scoreAffected ?? false }, this.clock.now());
      for (const u of updates) {
        await tx.loanApplicationStep.updateMany({
          where: { id: u.id, status: { not: 'LOCKED' } },
          data: { status: u.status, staleReason: u.staleReason, ...(u.completedAt !== undefined ? { completedAt: u.completedAt } : {}), updatedBy: ctx.userId },
        });
      }
      stepChanged = updates.length > 0;
    }
    if (o.change && o.collateralId) {
      await recordAudit(tx, { orgId: ctx.orgId, entity: 'COLLATERAL', entityId: o.collateralId, action: o.action ?? `COLLATERAL_${o.change}`, actorId: ctx.userId, beforeJson: o.before ?? null, afterJson: o.after ?? null, applicationId: app.id, correlationId: ctx.correlationId });
      await this.events.publish(tx, { type: 'CollateralChanged', applicationId: app.id, collateralId: o.collateralId, assetType: o.assetType ?? '', change: o.change }, ctx);
    } else if (o.auditStepChangeOnly && stepChanged) {
      await recordAudit(tx, { orgId: ctx.orgId, entity: 'COLLATERAL_GATE', entityId: app.id, action: 'COLLATERAL_GATE_RECHECKED', actorId: ctx.userId, beforeJson: null, afterJson: { complete: snap.evaluation.gate.complete, issues: snap.evaluation.gate.issues.map((i) => i.code) }, applicationId: app.id, correlationId: ctx.correlationId });
    }
    return snap;
  }

  /** Нэг барьцааны мутацийн хариу (CollateralMutationResponse). */
  mutation(snap: CollateralSnapshot, collateralId: string): CollateralMutationResponse {
    const collateral = snap.views.get(collateralId);
    if (!collateral) throw new DomainError('COLLATERAL_NOT_FOUND', 'Барьцаа олдсонгүй', 404);
    return { collateral, summary: snap.response.summary, gate: snap.response.gate, warnings: snap.response.warnings };
  }
}
