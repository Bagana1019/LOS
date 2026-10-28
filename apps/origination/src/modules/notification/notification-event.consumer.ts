import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { DomainEvent } from '@los/contracts';
import { consumeOnce, type EventBus } from '@los/database';
import { EVENT_BUS } from '@los/nest-common';
import { PrismaService, type Tx } from '../../prisma.service';
import { NotificationService, type CustomerNotifyContext, type NotifyPayload } from './notification.service';

type Handled = Extract<DomainEvent, { type: 'ApplicationApproved' | 'ApplicationReturned' | 'DisbursementApproved' | 'PaymentReceived' }>;
const HANDLED = ['ApplicationApproved', 'ApplicationReturned', 'DisbursementApproved', 'PaymentReceived'] as const;

const num = (d: { toString(): string } | null | undefined): number | null => (d === null || d === undefined ? null : Number(d.toString()));

/**
 * FR-13.2: домэйн event → мэдэгдэл. Consumer idempotent (`consumeOnce` + `processed_events`, CLAUDE.md §3.2.6), мэдэгдлийг тухайн транзакцид бичиж,
 * commit-ийн ДАРАА queue-д оруулна. Хүсэлт/зээлдэгч олдохгүй бол алдаа шидэхгүй (bus дахин хүргэлтийг дэмий давтахгүй).
 */
@Injectable()
export class NotificationEventConsumer implements OnModuleInit {
  private readonly logger = new Logger('NotificationEventConsumer');

  /** `bus` нь `REDIS_URL` байхгүй (эсвэл `OUTBOX_RELAY=off`) үед `null` — тэгвэл сонсохгүй. */
  constructor(@Inject(EVENT_BUS) private readonly bus: EventBus | null, private readonly db: PrismaService, private readonly notifications: NotificationService) {}

  async onModuleInit(): Promise<void> {
    await this.bus?.subscribe('origination', [...HANDLED], (event) => this.handle(event));
  }

  async handle(event: DomainEvent): Promise<void> {
    if (!(HANDLED as readonly string[]).includes(event.type)) return;
    let deliveryIds: string[] = [];
    // Тохиргоо/загварыг транзакцийн ГАДНА ачаална: транзакц дотроос pool-д хандвал зэрэг ирсэн event-үүд pool дүүрч гацна.
    const prepared = event.type === 'ApplicationReturned' ? null : await this.notifications.prepareCustomerNotify(event.orgId);
    const ran = await consumeOnce(this.db, 'notification', event, async (tx) => { deliveryIds = await this.apply(tx, event as Handled, prepared); });
    if (ran) await this.notifications.dispatch(deliveryIds);
  }

  /** @returns commit-ийн дараа queue-д оруулах delivery ID-ууд */
  private async apply(tx: Tx, event: Handled, prepared: CustomerNotifyContext | null): Promise<string[]> {
    const app = await tx.loanApplication.findFirst({ where: { id: event.applicationId, orgId: event.orgId } });
    if (!app) { this.logger.warn(`${event.type} ${event.eventId}: хүсэлт ${event.applicationId} олдсонгүй — алгасав`); return []; }
    const borrowers = await tx.loanApplicationBorrower.findMany({ where: { applicationId: app.id, role: { in: ['PRIMARY', 'CO_BORROWER'] } }, orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }], select: { customerId: true } });
    const customerIds = borrowers.map((b) => b.customerId);
    const base: NotifyPayload = { applicationNo: app.appNo, currency: app.currency };
    const toCustomers = (type: 'APPROVED' | 'DISBURSEMENT_APPROVED' | 'PAYMENT_RECEIVED', payload: NotifyPayload) =>
      this.notifications.notifyCustomers({ orgId: event.orgId, customerIds, type, applicationId: app.id, payload, dedupeBase: `event:${event.eventId}`, channels: prepared?.channels, templates: prepared?.templates }, tx);
    const toOfficer = (type: 'APPROVED' | 'RETURNED' | 'DISBURSEMENT_APPROVED', payload: NotifyPayload) =>
      this.notifications.notifyUsers({ orgId: event.orgId, userIds: [app.officerId], type, applicationId: app.id, payload }, tx); // officerId=null → "Систем" (BR-12): мэдэгдэх хүнгүй

    switch (event.type) {
      case 'ApplicationApproved': {
        const payload = { ...base, contractNo: event.contractNo, amount: num(app.amount) };
        const res = await toCustomers('APPROVED', payload);
        await toOfficer('APPROVED', payload);
        return res.deliveryIds;
      }
      case 'ApplicationReturned':
        await toOfficer('RETURNED', { ...base, comment: event.comment, levelNo: event.levelNo });
        return [];
      case 'DisbursementApproved': {
        const payload = { ...base, contractNo: app.contractNo, amount: event.amount };
        const res = await toCustomers('DISBURSEMENT_APPROVED', payload);
        await toOfficer('DISBURSEMENT_APPROVED', payload);
        return res.deliveryIds;
      }
      case 'PaymentReceived':
        return (await toCustomers('PAYMENT_RECEIVED', { ...base, contractNo: app.contractNo, amount: event.amount, currency: event.currency })).deliveryIds;
    }
  }
}
