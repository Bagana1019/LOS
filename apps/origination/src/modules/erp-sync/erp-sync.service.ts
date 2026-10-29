// Бизнес модулиуд (олголт, төлбөр) ERP-д үйл явдал дамжуулах facade. LOS журнал бичдэггүй — ERP үйл явдлаас журналаа өөрөө гаргана (FIN-SYNC).
// Дуудагчийн транзакцид (tx) outbox мөр бичнэ — бизнес мөртэй хамт commit/rollback.
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { ErpDisbursementInput, ErpEventStatus, ErpFeeDeductionInput, ErpRepaymentInput } from '@los/contracts';
import { InvalidErpEventInputError } from './erp-sync.errors';
import { Clock, SystemClock } from '@los/nest-common';
import { buildErpPayload, contentHashOf } from './erp-payload';
import { ERP_EVENT_REPOSITORY, type ErpEventDraft, type ErpEventRepository, type ErpEventTx } from './erp-event.repository';
import { idempotencyKeyOf, planDisbursement, planFeeDeduction, planRepayment, type ErpEventPlan } from './event-plan';

// tx заавал: outbox бичилт бизнес мөртэй нэг транзакцид байх ёстой (CLAUDE.md §3.2-4). Скрипт/backfill-д л `standalone: true`.
export type EmitOptions = { tx: ErpEventTx } | { standalone: true };
export interface EmitResult { eventId: string; idempotencyKey: string; status: ErpEventStatus; created: boolean; }

@Injectable()
export class ErpSyncService {
  private readonly clock: Clock;

  constructor(
    @Inject(ERP_EVENT_REPOSITORY) private readonly repo: ErpEventRepository,
    @Optional() @Inject(Clock) clock?: Clock,
  ) { this.clock = clock ?? new SystemClock(); }

  // Зээл олгогдоход (disbursement_request APPROVED/SENT_TO_CORE). sourceId = disbursement_request.id
  async emitDisbursement(input: ErpDisbursementInput, opts: EmitOptions): Promise<EmitResult> { return this.emit(planDisbursement(input), opts); }
  // Шимтгэл суутгахад/хураахад. sourceId = шимтгэл суутгасан баримтын ID (олголтоор бол disbursement_request.id)
  async emitFeeDeduction(input: ErpFeeDeductionInput, opts: EmitOptions): Promise<EmitResult> { return this.emit(planFeeDeduction(input), opts); }
  // Эргэн төлөлт орж ирэхэд. sourceId = сувгийн гүйлгээний лавлах (QPAY:<txn>, банкны гүйлгээний ID)
  async emitRepayment(input: ErpRepaymentInput, opts: EmitOptions): Promise<EmitResult> { return this.emit(planRepayment(input), opts); }

  // JS дуудагч (төрлийн шалгалтгүй) tx мартвал outbox бичилт бизнес мөрөөс тусдаа commit болно — ингэж чимээгүй алдахгүй
  private txOf(opts: EmitOptions): ErpEventTx | undefined {
    const o = opts as { tx?: ErpEventTx; standalone?: unknown } | null | undefined;
    if (o && o.tx !== undefined && o.tx !== null) return o.tx;
    if (o?.standalone === true) return undefined;
    throw new InvalidErpEventInputError('emit*() requires { tx } (the caller transaction) or { standalone: true }');
  }

  private async emit(plan: ErpEventPlan, opts: EmitOptions): Promise<EmitResult> {
    const tx = this.txOf(opts);
    const draft: ErpEventDraft = {
      id: randomUUID(), idempotencyKey: idempotencyKeyOf(plan.eventType, plan.sourceId),
      contentHash: contentHashOf(plan.eventType, plan.sourceId, plan.header, plan.data),
      eventType: plan.eventType, sourceId: plan.sourceId, header: plan.header,
      correlationId: plan.header.correlationId ?? randomUUID(), amount: plan.amount, data: plan.data, now: this.clock.now(),
    };
    this.assertDeliverable(draft);
    const { event, created } = await this.repo.insert(draft, tx);
    return { eventId: event.id, idempotencyKey: event.idempotencyKey, status: event.status, created };
  }

  // Илгээх үеийн payload-ийн шалгалтыг бичих үед нь хийнэ: дараа нь DEAD болж тухайн зээлийн дарааллыг хориглох мөр үүсгэхгүй
  private assertDeliverable(d: ErpEventDraft): void {
    try {
      buildErpPayload({
        id: d.id, idempotencyKey: d.idempotencyKey, eventType: d.eventType, orgId: d.header.orgId, branchId: d.header.branchId,
        applicationId: d.header.applicationId, contractNo: d.header.contractNo, coreLoanId: d.header.coreLoanId, customerId: d.header.customerId,
        businessDate: d.header.businessDate, currency: d.header.currency, correlationId: d.correlationId, createdAt: d.now, data: d.data,
      });
    } catch (e) {
      const issues = (e as { issues?: Array<{ path: Array<string | number>; message: string }> }).issues?.map((i) => `${i.path.join('.')}: ${i.message}`) ?? [(e as Error).message];
      throw new InvalidErpEventInputError(`ERP event would not be deliverable — ${issues.join('; ')}`, issues);
    }
  }
}
