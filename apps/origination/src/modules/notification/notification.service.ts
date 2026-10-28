import { randomUUID } from 'node:crypto';
import { ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { MarkAllReadResponse, NotificationChannel, NotificationListQuery, NotificationListResponse, NotificationType, NotificationView, UnreadCountResponse } from '@los/contracts';
import { Clock } from '@los/nest-common';
import { PrismaService, Tx } from '../../prisma.service';
import type { RequestContext } from '@los/contracts';
import { SETTING_REGISTRY } from '@los/contracts';
import { OrgSettings } from '../../shared/org-settings';
import { normalizeEmail, normalizeMnPhone } from './phone';
import { NOTIFICATION_QUEUE, type NotificationQueue } from './notification.queue';
import { toNotificationView } from './notification.mapper';
import { TemplateService, type TemplateResolver } from './template.service';

type Db = PrismaService | Tx;

/** Загварт орох бизнес утгууд (хувийн мэдээлэл ОРУУЛАХГҮЙ — delivery.payloadJson-д хадгалагдана). borrowerName-ийг хүлээн авагч бүрээр өөрөө тавина. */
export interface NotifyPayload {
  applicationNo?: string | null;
  contractNo?: string | null;
  amount?: number | null;
  currency?: string | null;
  dueDate?: string | null;
  daysOverdue?: number | null;
  comment?: string | null;
  [key: string]: string | number | boolean | null | undefined;
}

export interface NotifyUsersInput { orgId: string; userIds: Array<string | null | undefined>; type: NotificationType; applicationId?: string | null; payload?: NotifyPayload }
export interface NotifyCustomersInput {
  orgId: string; customerIds: Array<string | null | undefined>; type: NotificationType; applicationId?: string | null; payload?: NotifyPayload;
  /** dedupeKey = `${dedupeBase}:${customerId}:${channel}` (PUSH-д төхөөрөмж бүрээр `:${deviceId}` нэмэгдэнэ) — ижил base-тэй дахин дуудахад давхар үүсэхгүй. */
  dedupeBase: string;
  /** true бол юу ч бичихгүй, юу болохыг тоолно. */
  dryRun?: boolean;
  /** Олон дуудлагад давтан ачаалахгүйн тулд (ReminderService): урьдчилан ачаалсан загвар, хүсэлтийн салбар. */
  templates?: TemplateResolver;
  /** `prepareCustomerNotify()`-ийн үр дүн: транзакц доторх дуудлага pool-оос дахин холболт авахгүйн тулд транзакцийн ӨМНӨ ачаална. */
  channels?: readonly NotificationChannel[];
  branchId?: string | null;
}
export interface CustomerNotifyContext { channels: readonly NotificationChannel[]; templates: TemplateResolver }
export interface NotifyCustomersResult {
  /** QUEUED болгон шинээр үүссэн (илгээгдэх) хүргэлт */
  queued: number;
  /** Хаяг буруу тул SKIPPED болгон шинээр үүссэн */
  skipped: number;
  /** dedupeKey аль хэдийн байсан тул алгассан */
  duplicates: number;
  /** Queue-д оруулах ёстой (QUEUED) delivery ID — `tx`-тэй дуудсан бол commit-ийн ДАРАА `dispatch(ids)` */
  deliveryIds: string[];
}

const CUSTOMER_CHANNELS = ['SMS', 'EMAIL', 'PUSH'] as const;
const MAX_DEVICES_PER_CUSTOMER = 3;

const displayName = (c: { firstName: string; lastName: string | null }) => c.firstName || c.lastName || '';

/**
 * FR-13.2 Мэдэгдлийн нийтийн API. Бусад модуль (approval, comment …) `notifyUsers` / `notifyCustomers`-ийг дуудна.
 * `tx` өгвөл тухайн транзакцид бичнэ (бизнес өөрчлөлттэй атомик); хүргэлтийг commit-ийн дараа `dispatch()`-ээр queue-д оруулна.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger('NotificationService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly settings: OrgSettings,
    private readonly templates: TemplateService,
    @Inject(NOTIFICATION_QUEUE) private readonly queue: NotificationQueue,
  ) {}

  // ── Ажилтны хонх (IN_APP) ────────────────────────────────────────────────────────

  /** Ажилтан бүрт нэг `Notification`. IN_APP-ийг унтраасан (NotificationPreference) ажилтныг алгасна. @returns үүссэн тоо */
  async notifyUsers(input: NotifyUsersInput, tx?: Tx): Promise<{ created: number }> {
    const db: Db = tx ?? this.prisma;
    const userIds = [...new Set(input.userIds.filter((u): u is string => !!u))];
    if (!userIds.length) return { created: 0 };
    const muted = await db.notificationPreference.findMany({ where: { orgId: input.orgId, subjectType: 'USER', subjectId: { in: userIds }, channel: 'IN_APP', enabled: false }, select: { subjectId: true } });
    const mutedIds = new Set(muted.map((m) => m.subjectId));
    const data = userIds.filter((u) => !mutedIds.has(u)).map((userId) => ({
      id: randomUUID(), orgId: input.orgId, userId, type: input.type, applicationId: input.applicationId ?? null, payloadJson: (input.payload ?? {}) as object, createdAt: this.clock.now(),
    }));
    if (!data.length) return { created: 0 };
    const res = await db.notification.createMany({ data });
    return { created: res.count };
  }

  async list(ctx: RequestContext, query: NotificationListQuery): Promise<NotificationListResponse> {
    const userId = this.requireUser(ctx);
    const where = { orgId: ctx.orgId, userId, ...(query.unreadOnly ? { readAt: null } : {}) };
    const [rows, total, unreadCount, resolver] = await Promise.all([
      this.prisma.notification.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { orgId: ctx.orgId, userId, readAt: null } }),
      this.templates.resolver(ctx.orgId),
    ]);
    const items = rows.map((r) => toNotificationView(r, resolver.render(r.type as NotificationType, 'IN_APP', 'mn', { ...(r.payloadJson as object) })));
    return { items, total, unreadCount, page: query.page, pageSize: query.pageSize };
  }

  async unreadCount(ctx: RequestContext): Promise<UnreadCountResponse> {
    const userId = this.requireUser(ctx);
    return { unreadCount: await this.prisma.notification.count({ where: { orgId: ctx.orgId, userId, readAt: null } }) };
  }

  /** Зөвхөн өөрийн мэдэгдэл; бусдынх/байхгүй → 404. Аль хэдийн уншсан бол idempotent (readAt өөрчлөгдөхгүй). */
  async markRead(ctx: RequestContext, id: string): Promise<NotificationView> {
    const userId = this.requireUser(ctx);
    await this.prisma.notification.updateMany({ where: { id, orgId: ctx.orgId, userId, readAt: null }, data: { readAt: this.clock.now() } });
    const row = await this.prisma.notification.findFirst({ where: { id, orgId: ctx.orgId, userId } });
    if (!row) throw new NotFoundException({ code: 'NOTIFICATION_NOT_FOUND', message: 'Мэдэгдэл олдсонгүй' });
    const rendered = await this.templates.render(ctx.orgId, row.type as NotificationType, 'IN_APP', 'mn', { ...(row.payloadJson as object) });
    return toNotificationView(row, rendered);
  }

  async markAllRead(ctx: RequestContext): Promise<MarkAllReadResponse> {
    const userId = this.requireUser(ctx);
    const res = await this.prisma.notification.updateMany({ where: { orgId: ctx.orgId, userId, readAt: null }, data: { readAt: this.clock.now() } });
    return { updated: res.count };
  }

  private requireUser(ctx: RequestContext): string {
    if (!ctx.userId) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Зөвхөн ажилтны хонхны мэдэгдэл' });
    return ctx.userId;
  }

  // ── Зээлдэгчид (SMS / Email / Push) ──────────────────────────────────────────────

  /** `notification.channels_customer` тохиргооноос зөвшөөрөгдсөн сувгууд. */
  async customerChannels(orgId: string): Promise<readonly NotificationChannel[]> {
    const setting = await this.settings.get(orgId, 'notification.channels_customer');
    const configured = Array.isArray(setting) ? setting : SETTING_REGISTRY['notification.channels_customer'].default as string[]; // эвдэрсэн тохиргоо → анхдагч
    return CUSTOMER_CHANNELS.filter((c) => configured.includes(c));
  }

  /**
   * Транзакц дотор `notifyCustomers`-ийг дуудахын өмнө (тохиргоо, загварыг транзакцийн гаднаас) ачаална: interactive транзакц нэг холболт
   * барьдаг тул дотроос `settings`/`templates`-ээр pool-д хандвал зэрэг ажиллаж буй транзакцуудын тоо pool-той тэнцэхэд бүгд хоорондоо хүлээж гацна.
   */
  async prepareCustomerNotify(orgId: string): Promise<CustomerNotifyContext> {
    const [channels, templates] = await Promise.all([this.customerChannels(orgId), this.templates.resolver(orgId)]);
    return { channels, templates };
  }

  /**
   * Зээлдэгч бүр × идэвхтэй суваг бүрт `NotificationDelivery` (QUEUED). Суваг = `notification.channels_customer` ∩ (opt-out-гүй) ∩ холбоо барих мэдээлэлтэй
   * (утас→SMS, имэйл→EMAIL, идэвхтэй PushDevice→PUSH). Утас/имэйл буруу бол SKIPPED + lastError='INVALID_ADDRESS' (алдаа шидэхгүй).
   * `tx` өгөөгүй бол өөрөө queue-д оруулна; өгсөн бол дуудагч commit-ийн дараа `dispatch(result.deliveryIds)` хийнэ (алдагдвал sweep нөхнө).
   */
  async notifyCustomers(input: NotifyCustomersInput, tx?: Tx): Promise<NotifyCustomersResult> {
    const db: Db = tx ?? this.prisma;
    const customerIds = [...new Set(input.customerIds.filter((c): c is string => !!c))];
    const empty: NotifyCustomersResult = { queued: 0, skipped: 0, duplicates: 0, deliveryIds: [] };
    if (!customerIds.length) return empty;

    const channels = input.channels ?? await this.customerChannels(input.orgId);
    if (!channels.length) return empty;

    const now = this.clock.now();
    const [customers, optOuts, devices, resolver, branchId] = await Promise.all([
      db.customer.findMany({ where: { id: { in: customerIds }, orgId: input.orgId }, select: { id: true, firstName: true, lastName: true, phone: true, email: true } }),
      db.notificationPreference.findMany({ where: { orgId: input.orgId, subjectType: 'CUSTOMER', subjectId: { in: customerIds }, enabled: false }, select: { subjectId: true, channel: true } }),
      channels.includes('PUSH')
        ? db.pushDevice.findMany({ where: { orgId: input.orgId, ownerType: 'CUSTOMER', ownerId: { in: customerIds }, isActive: true }, orderBy: [{ lastSeenAt: 'desc' }, { id: 'asc' }] })
        : Promise.resolve([]),
      input.templates ?? this.templates.resolver(input.orgId),
      this.branchOf(db, input),
    ]);
    const optedOut = new Set(optOuts.map((o) => `${o.subjectId}:${o.channel}`));
    const devicesByOwner = new Map<string, typeof devices>();
    for (const d of devices) {
      const list = devicesByOwner.get(d.ownerId) ?? [];
      if (list.length < MAX_DEVICES_PER_CUSTOMER) list.push(d);
      devicesByOwner.set(d.ownerId, list);
    }
    const byId = new Map(customers.map((c) => [c.id, c]));
    const payload = (input.payload ?? {}) as object;

    type Row = {
      id: string; orgId: string; type: string; channel: string; recipientType: string; recipientId: string; address: string | null; applicationId: string | null; branchId: string | null;
      subject: string | null; body: string; payloadJson: object; dedupeKey: string; status: 'QUEUED' | 'SKIPPED'; attempts: number; nextAttemptAt: Date | null; lastError: string | null; scheduledFor: Date;
    };
    const rows: Row[] = [];
    for (const customerId of customerIds) {
      const customer = byId.get(customerId);
      if (!customer) { this.logger.warn(`Зээлдэгч ${customerId} олдсонгүй — мэдэгдэл алгассан`); continue; }
      const vars = { ...(payload as Record<string, never>), borrowerName: displayName(customer) };
      for (const channel of channels as readonly NotificationChannel[]) {
        if (optedOut.has(`${customerId}:${channel}`)) continue;
        const message = resolver.render(input.type, channel, 'mn', vars);
        if (!message) continue;
        const targets: Array<{ address: string; valid: boolean; keySuffix: string }> = [];
        if (channel === 'SMS') {
          const raw = customer.phone?.trim();
          if (raw) { const phone = normalizeMnPhone(raw); targets.push({ address: phone ?? raw, valid: phone !== null, keySuffix: '' }); }
        } else if (channel === 'EMAIL') {
          const raw = customer.email?.trim();
          if (raw) { const email = normalizeEmail(raw); targets.push({ address: email ?? raw, valid: email !== null, keySuffix: '' }); }
        } else {
          // Түлхүүр төхөөрөмж бүрд ТОГТВОРТОЙ (device.id): lastSeenAt-ийн эрэмбэ өөрчлөгдсөн ч дахин ажиллуулахад давхар push явахгүй, шинэ төхөөрөмж өөр төхөөрөмжийн түлхүүрийг өвлөхгүй.
          (devicesByOwner.get(customerId) ?? []).forEach((d) => targets.push({ address: d.token, valid: true, keySuffix: `:${d.id}` }));
        }
        for (const t of targets) {
          rows.push({
            id: randomUUID(), orgId: input.orgId, type: input.type, channel, recipientType: 'CUSTOMER', recipientId: customerId, address: t.address,
            applicationId: input.applicationId ?? null, branchId, subject: message.subject, body: message.body, payloadJson: payload,
            dedupeKey: `${input.dedupeBase}:${customerId}:${channel}${t.keySuffix}`, status: t.valid ? 'QUEUED' : 'SKIPPED', attempts: 0,
            nextAttemptAt: t.valid ? now : null, lastError: t.valid ? null : 'INVALID_ADDRESS', scheduledFor: now,
          });
        }
      }
    }
    if (!rows.length) return empty;

    if (input.dryRun) {
      const existing = new Set((await db.notificationDelivery.findMany({ where: { dedupeKey: { in: rows.map((r) => r.dedupeKey) } }, select: { dedupeKey: true } })).map((e) => e.dedupeKey));
      const fresh = rows.filter((r) => !existing.has(r.dedupeKey));
      return { queued: fresh.filter((r) => r.status === 'QUEUED').length, skipped: fresh.filter((r) => r.status === 'SKIPPED').length, duplicates: rows.length - fresh.length, deliveryIds: [] };
    }

    // ON CONFLICT DO NOTHING: давхардал (өмнөх ажиллалт / зэрэгцээ worker) транзакцыг эвдэхгүй. ID нь шинэ тул хэн үүссэнийг нь ID-аар таньна.
    await db.notificationDelivery.createMany({ data: rows, skipDuplicates: true });
    const created = new Set((await db.notificationDelivery.findMany({ where: { id: { in: rows.map((r) => r.id) } }, select: { id: true } })).map((c) => c.id));
    const fresh = rows.filter((r) => created.has(r.id));
    const result: NotifyCustomersResult = {
      queued: fresh.filter((r) => r.status === 'QUEUED').length, skipped: fresh.filter((r) => r.status === 'SKIPPED').length,
      duplicates: rows.length - fresh.length, deliveryIds: fresh.filter((r) => r.status === 'QUEUED').map((r) => r.id),
    };
    if (!tx) await this.dispatch(result.deliveryIds);
    return result;
  }

  private async branchOf(db: Db, input: Pick<NotifyCustomersInput, 'orgId' | 'applicationId' | 'branchId'>): Promise<string | null> {
    if (input.branchId !== undefined) return input.branchId;
    if (!input.applicationId) return null;
    return (await db.loanApplication.findFirst({ where: { id: input.applicationId, orgId: input.orgId }, select: { branchId: true } }))?.branchId ?? null;
  }

  /**
   * Commit-ийн дараа queue-д оруулна. Алдаа шидэхгүй — QUEUED мөр DB-д байгаа тул sweep() дараа нь авна.
   * Queue (Redis) хүрэхгүй бол эхний алдаанаар зогсоно: үлдсэн бүрийг timeout хүртэл хүлээж дуудагчийг (HTTP хүсэлт, event handler) гацаахгүй.
   */
  async dispatch(deliveryIds: string[]): Promise<void> {
    for (let i = 0; i < deliveryIds.length; i++) {
      try { await this.queue.enqueue(deliveryIds[i]); }
      catch (e) {
        this.logger.warn(`Queue-д орсонгүй (sweep нөхнө): хүргэлт ${deliveryIds[i]}${deliveryIds.length - i > 1 ? ` ба үлдсэн ${deliveryIds.length - i - 1}` : ''} [${e instanceof Error ? e.name : 'үл мэдэгдэх'}]`);
        return;
      }
    }
  }
}
