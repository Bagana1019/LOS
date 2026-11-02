import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ApplicationStatus, type RequestContext, type StepKey } from '@los/contracts';
import { recordAudit } from '@los/database';
import { Clock, DomainError } from '@los/nest-common';
import type { LoanApplication } from '.prisma/client-origination';
import type { Tx } from '../../prisma.service';
import { DomainEvents } from '../../shared/domain-events';
import { OrgSettings } from '../../shared/org-settings';
import { canTransition, isUserTransition, missingRequiredSteps, STEP_ORDER, TIMESTAMP_FIELD, unlocksStage2 } from './application.rules';

export interface TransitionOptions {
  /** USER = ЗЭЗ/хэрэглэгчийн шилжилт (docs/01 §4 хүснэгтээр шалгана); SYSTEM = батлах урсгал, Core, олголт (өөр модуль). */
  via: 'USER' | 'SYSTEM';
  reason?: string | null;
}

/**
 * docs/01 §4 хүсэлтийн төлвийн машин. Шилжилт бүр нэг транзакцид: мөр түгжих → дүрэм шалгах → шинэчлэх → алхмын нээлт →
 * audit_log (`STATUS_CHANGED`) → `ApplicationStatusChanged` outbox (CLAUDE.md §3.2.4). Бусад модуль (батлах урсгал, олголт) төлөв солихдоо ЗӨВХӨН үүнийг дуудна.
 */
@Injectable()
export class ApplicationStateMachine {
  constructor(private readonly events: DomainEvents, private readonly settings: OrgSettings, private readonly clock: Clock) {}

  /** Мөрийг FOR UPDATE-ээр түгжиж, түгжээний дараах төлөвөөр уншина (READ COMMITTED). */
  async lock(tx: Tx, orgId: string, applicationId: string): Promise<LoanApplication> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM origination.loan_application WHERE id = ${applicationId} AND org_id = ${orgId} FOR UPDATE`;
    if (!rows.length) throw new NotFoundException({ code: 'APPLICATION_NOT_FOUND', message: 'Хүсэлт олдсонгүй' });
    return tx.loanApplication.findUniqueOrThrow({ where: { id: applicationId } });
  }

  async apply(tx: Tx, ctx: RequestContext, applicationId: string, to: ApplicationStatus, opts: TransitionOptions): Promise<LoanApplication> {
    if (!ApplicationStatus.includes(to)) throw new DomainError('INVALID_STATUS', `Үл мэдэгдэх төлөв: ${to}`, 400);
    const app = await this.lock(tx, ctx.orgId, applicationId);
    const from = app.status as ApplicationStatus;
    if (!canTransition(from, to)) throw new DomainError('INVALID_TRANSITION', `"${from}" төлвөөс "${to}" төлөвт шилжих боломжгүй`, 400, { from, to });
    if (opts.via === 'USER' && !isUserTransition(from, to)) throw new ForbiddenException({ code: 'TRANSITION_NOT_ALLOWED', message: `"${to}" төлөвт шилжүүлэх эрхгүй (системийн шилжилт)`, details: { from, to } });

    const now = this.clock.now();
    const data: Record<string, unknown> = { status: to, updatedBy: ctx.userId };
    const stamp = TIMESTAMP_FIELD[to];
    if (stamp) data[stamp] = now;

    if (to === 'SUBMITTED') {
      // G1 (BR-7): заавал алхам бүрдсэн байх.
      const [steps, required] = await Promise.all([tx.loanApplicationStep.findMany({ where: { applicationId } }), this.settings.getIn(tx, ctx.orgId, 'br7.required_steps')]);
      const missing = missingRequiredSteps(steps, required);
      if (missing.length) throw new DomainError('STEPS_INCOMPLETE', 'Заавал алхмууд бүрдээгүй тул илгээх боломжгүй', 422, { missing });
      if (app.productId == null || app.amount == null) throw new DomainError('LOAN_TERMS_MISSING', 'Бүтээгдэхүүн, дүн тодорхойгүй тул илгээх боломжгүй', 422);
      if (from === 'RETURNED') { data.version = app.version + 1; data.returnedAt = null; } // дахин илгээлт = шинэ хувилбар (FR-10)
    }

    // Давхар шилжилтээс хамгаалах: төлөв өөрчлөгдсөн бол 409 (түгжээ авсны дараах унших тул ердийн үед хүрэхгүй).
    const res = await tx.loanApplication.updateMany({ where: { id: applicationId, status: from }, data });
    if (res.count !== 1) throw new ConflictException({ code: 'STALE_STATE', message: 'Хүсэлтийн төлөв өөрчлөгдсөн байна, дахин ачаална уу' });

    if (unlocksStage2(to)) await tx.loanApplicationStep.updateMany({ where: { applicationId, status: 'LOCKED' }, data: { status: 'PENDING', updatedBy: ctx.userId } }); // G3

    await recordAudit(tx, {
      orgId: ctx.orgId, entity: 'LOAN_APPLICATION', entityId: applicationId, action: 'STATUS_CHANGED', actorId: ctx.userId,
      beforeJson: { status: from }, afterJson: { status: to, via: opts.via, reason: opts.reason ?? null }, applicationId, correlationId: ctx.correlationId,
    });
    await this.events.publish(tx, { type: 'ApplicationStatusChanged', applicationId, from, to }, ctx);
    if (to === 'SUBMITTED') await this.events.publish(tx, { type: 'ApplicationSubmitted', applicationId, amount: Number(app.amount), productId: app.productId as string }, ctx);

    return tx.loanApplication.findUniqueOrThrow({ where: { id: applicationId } });
  }
}

export const ALL_STEP_KEYS: readonly StepKey[] = STEP_ORDER;
