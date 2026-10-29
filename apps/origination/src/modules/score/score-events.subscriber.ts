import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { Prisma } from '.prisma/client-origination';
import { CalcMethodCode, type DomainEvent } from '@los/contracts';
import { idempotentHandler, type EventBus } from '@los/database';
import { Clock, EVENT_BUS, runWithContext, systemContext } from '@los/nest-common';
import { PrismaService, type Tx } from '../../prisma.service';
import { isEditableStatus, planScoreStep, readSnapshot, reconcileSnapshot } from './score.rules';

/** Consumer group = сервисийн нэр (CLAUDE.md §3.1) */
export const EVENT_GROUP = 'origination';
const SUBSCRIBED_TYPES: DomainEvent['type'][] = ['ScoringCompleted'];

type ScoringCompleted = Extract<DomainEvent, { type: 'ScoringCompleted' }>;

/**
 * FR-8 · scoring өөрийн тооцооллыг бичсэн ч origination-ий хүсэлт/алхмыг шинэчилж амжаагүй (унасан) тохиолдолд `ScoringCompleted`-ээр тулгаж засна:
 * `loan_application.selected_calc_method` ба алхам `score`. `idempotentHandler` нь `processed_events(origination, eventId)`-ээр давхар хүргэлтийг хаана.
 */
@Injectable()
export class ScoreEventsSubscriber implements OnApplicationBootstrap {
  private readonly logger = new Logger(ScoreEventsSubscriber.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: EventBus | null,
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(Clock) private readonly clock: Clock,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.bus) {
      this.logger.warn('event bus disabled — ScoringCompleted will not be consumed');
      return;
    }
    // subscribe амжилтгүй бол сервис асахгүй (чимээгүй алдвал тулгалт хийгдэхгүй). Handler-ийн алдааг барихгүй — bus (at-least-once) дахин хүргэнэ.
    const once = idempotentHandler(this.db, EVENT_GROUP, (tx, event) => this.handle(tx, event));
    await this.bus.subscribe(EVENT_GROUP, SUBSCRIBED_TYPES, (event) => runWithContext(systemContext(event.orgId, event.correlationId), () => once(event)));
    this.logger.log(`subscribed group=${EVENT_GROUP} types=${SUBSCRIBED_TYPES.join(',')}`);
  }

  async handle(tx: Tx, event: DomainEvent): Promise<void> {
    if (event.type !== 'ScoringCompleted') return;
    await this.reconcile(tx, event);
  }

  private async reconcile(tx: Tx, event: ScoringCompleted): Promise<void> {
    const method = CalcMethodCode.safeParse(event.selectedMethod);
    if (!method.success) {
      this.logger.warn({ msg: 'ScoringCompleted ignored: unknown method', applicationId: event.applicationId, correlationId: event.correlationId });
      return;
    }
    const app = await tx.loanApplication.findFirst({ where: { id: event.applicationId, orgId: event.orgId } });
    if (!app) {
      this.logger.warn({ msg: 'ScoringCompleted ignored: unknown application', applicationId: event.applicationId, correlationId: event.correlationId });
      return;
    }
    // Илгээгдсэн / шийдвэрлэгдсэн хүсэлтийн сонголтыг хоцорсон event-ээр өөрчлөхгүй
    if (!isEditableStatus(app.status)) {
      this.logger.log({ msg: 'ScoringCompleted ignored: application is not editable', applicationId: app.id, status: app.status, correlationId: event.correlationId });
      return;
    }
    const existing = readSnapshot(app.calcSnapshotJson);
    // Хоцорч ирсэн хуучин event шинэ төлөвийг дарахгүй
    if (existing && Date.parse(existing.syncedAt) > Date.parse(event.occurredAt)) {
      this.logger.log({ msg: 'ScoringCompleted ignored: older than the applied state', applicationId: app.id, correlationId: event.correlationId });
      return;
    }

    if (app.selectedCalcMethod !== method.data) {
      const snapshot = reconcileSnapshot(existing, { selectedMethod: method.data, soscoScore: event.soscoScore, occurredAt: event.occurredAt });
      await tx.loanApplication.update({ where: { id: app.id }, data: { selectedCalcMethod: method.data, calcSnapshotJson: snapshot as unknown as Prisma.InputJsonValue } });
    }

    const step = await tx.loanApplicationStep.findUnique({ where: { applicationId_stepKey: { applicationId: app.id, stepKey: 'score' } }, select: { id: true, status: true, updatedAt: true } });
    // Тооцоолол хуучирсан гэж тэмдэглэснээс ӨМНӨХ event алхмыг дахин COMPLETED болгохгүй
    if (step?.status === 'STALE' && Date.parse(event.occurredAt) <= step.updatedAt.getTime()) return;
    if (step?.status === 'COMPLETED') return;
    const plan = planScoreStep(step, method.data, this.clock.now());
    if (plan.kind === 'update') await tx.loanApplicationStep.update({ where: { id: plan.id }, data: { status: plan.status, completedAt: plan.completedAt, staleReason: null } });
    else if (plan.kind === 'create') await tx.loanApplicationStep.create({ data: { orgId: app.orgId, applicationId: app.id, stepKey: 'score', status: plan.status, completedAt: plan.completedAt } });
  }
}
