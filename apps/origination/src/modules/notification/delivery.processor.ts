import { Inject, Injectable, Logger } from '@nestjs/common';
import type { NotificationChannel } from '@los/contracts';
import { Clock } from '@los/nest-common';
import { IntegrationNotConfiguredError } from '../../shared/integration-mode';
import { PrismaService } from '../../prisma.service';
import { OrgSettings } from '../../shared/org-settings';
import { ChannelError, IntegrationNotImplementedError } from '../../integrations/channel/channel-error';
import { EMAIL_GATEWAY } from '../../integrations/email/email.provider';
import type { EmailGateway } from '../../integrations/email/email.gateway';
import { PUSH_GATEWAY } from '../../integrations/push/push.provider';
import type { PushGateway } from '../../integrations/push/push.gateway';
import { SMS_GATEWAY } from '../../integrations/sms/sms.provider';
import type { SmsGateway } from '../../integrations/sms/sms.gateway';
import { NOTIFICATION_QUEUE, type NotificationQueue } from './notification.queue';
import { textToHtml } from './template.render';

/** Эхний дахин оролдлого 30с, дараа нь 60с, 120с … (30с · 2^(attempts-1)). */
export const BACKOFF_BASE_MS = 30_000;
/** Claim хийсэн worker унавал энэ хугацааны дараа sweep() дахин авна. */
export const LEASE_MS = 120_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const SWEEP_BATCH = 200;
/** Gateway амжилттай илгээсний дараах `SENT` бичилт унавал энэ завсраар дахин оролдоно (түр DB алдаа: connection reset, deadlock). */
export const DEFAULT_RECORD_RETRY_DELAYS_MS: readonly number[] = [100, 500, 2000];
/** Илгээгдсэн боловч DB-д бичигдээгүй хүргэлтийг энэ процесс дотор санах дээд хэмжээ. */
const MAX_UNRECORDED = 1000;

export type ProcessOutcome = 'SENT' | 'RETRY' | 'FAILED' | 'SKIPPED' | 'NOT_CLAIMED' | 'NOT_FOUND';

export const backoffMs = (attempts: number) => BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1);

interface Failure { code: string; retryable: boolean }

interface SentResult { attempt: number; providerMessageId: string; sentAt: Date }

/**
 * Мессеж gateway-ээр ИЛГЭЭГДСЭН боловч `SENT` төлөвийг DB-д бичиж чадаагүй. Gateway-н алдаа БИШ тул дахин илгээлт (retry) үүсгэхгүй:
 * мөр QUEUED (lease-тэй) үлдэж, дараагийн боловсруулалт энэ процесс дотор мессежийг дахин илгээлгүйгээр төлөвийг бичнэ.
 */
export class DeliveryRecordError extends Error {
  constructor(readonly deliveryId: string, readonly providerMessageId: string, options?: { cause?: unknown }) {
    super(`Хүргэлт ${deliveryId} gateway-ээр илгээгдсэн боловч SENT төлөвийг DB-д бичиж чадсангүй (providerMessageId=${providerMessageId})`, options);
    this.name = 'DeliveryRecordError';
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function classify(err: unknown): Failure {
  if (err instanceof ChannelError) return { code: err.code, retryable: err.retryable };
  if (err instanceof IntegrationNotConfiguredError) return { code: 'NOT_CONFIGURED', retryable: false };
  if (err instanceof IntegrationNotImplementedError) return { code: 'NOT_IMPLEMENTED', retryable: false };
  return { code: 'PROVIDER_ERROR', retryable: true };
}

/** FR-13.2: нэг хүргэлтийг gateway-ээр илгээж төлөвийг (SENT / дахин оролдлого / FAILED / SKIPPED) шинэчилнэ. */
@Injectable()
export class DeliveryProcessor {
  private readonly logger = new Logger('DeliveryProcessor');
  /** `SENT` бичилтийн завсар (мс). Тестэд багасгана. */
  recordRetryDelaysMs: readonly number[] = DEFAULT_RECORD_RETRY_DELAYS_MS;
  /** Илгээгдсэн боловч `SENT` бичилт нь унасан хүргэлтүүд (deliveryId → үр дүн): lease дуусаад дахин боловсруулахад ДАХИН ИЛГЭЭХГҮЙ, зөвхөн төлөвийг бичнэ. */
  private readonly unrecorded = new Map<string, SentResult>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly settings: OrgSettings,
    @Inject(SMS_GATEWAY) private readonly sms: SmsGateway,
    @Inject(EMAIL_GATEWAY) private readonly email: EmailGateway,
    @Inject(PUSH_GATEWAY) private readonly push: PushGateway,
    @Inject(NOTIFICATION_QUEUE) private readonly queue: NotificationQueue,
  ) {}

  /**
   * Зөвхөн QUEUED ба nextAttemptAt ≤ now. Claim: `updateMany` нь nextAttemptAt-ыг lease болгон ирээдүйд шилжүүлнэ — зэрэг ирсэн хоёр worker-ээс
   * нэг нь л count=1 авна (READ COMMITTED дээр хоёр дахь нь шинэчлэгдсэн мөрийг дахин шалгаад 0 болно).
   */
  async process(deliveryId: string): Promise<ProcessOutcome> {
    const now = this.clock.now();
    const claimed = await this.prisma.notificationDelivery.updateMany({
      where: { id: deliveryId, status: 'QUEUED', OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
      data: { nextAttemptAt: new Date(now.getTime() + LEASE_MS) },
    });
    if (claimed.count === 0) {
      const exists = await this.prisma.notificationDelivery.count({ where: { id: deliveryId } });
      return exists ? 'NOT_CLAIMED' : 'NOT_FOUND';
    }
    const d = await this.prisma.notificationDelivery.findUniqueOrThrow({ where: { id: deliveryId } });

    // Өмнөх оролдлогод мессеж явсан ч SENT бичилт унасан бол дахин ИЛГЭЭХГҮЙ — төлөвийг л бичнэ.
    const pending = this.unrecorded.get(d.id);
    if (pending) return this.recordSent(d.id, pending);

    const attempt = d.attempts + 1;
    let providerMessageId: string;
    try {
      providerMessageId = await this.send(d.channel as NotificationChannel, d);
    } catch (err) {
      return this.onFailure(d, attempt, classify(err), err);
    }
    // Энэ мөрөөс хойших DB алдаа gateway-н (retryable) алдаа БИШ: мессеж аль хэдийн явсан тул дахин илгээлт үүсгэж болохгүй.
    return this.recordSent(d.id, { attempt, providerMessageId, sentAt: this.clock.now() });
  }

  /** `SENT` төлөвийг бичнэ; түр DB алдаанд богино завсартай дахин оролдоно. Бүгд унавал үр дүнг санаад `DeliveryRecordError` шиднэ (gateway-г дахин дуудахгүй). */
  private async recordSent(id: string, r: SentResult): Promise<ProcessOutcome> {
    for (let i = 0; ; i++) {
      try {
        await this.prisma.notificationDelivery.update({
          where: { id }, data: { status: 'SENT', attempts: r.attempt, providerMessageId: r.providerMessageId, sentAt: r.sentAt, nextAttemptAt: null, lastError: null },
        });
        this.unrecorded.delete(id);
        return 'SENT';
      } catch (err) {
        const delay = this.recordRetryDelaysMs[i];
        if (delay === undefined) {
          this.remember(id, r);
          // Хаяг, текст лог-д бичихгүй: delivery ID + providerMessageId (хүлээн авагчийг тодорхойлохгүй) — гараар тулгахад хангалттай.
          this.logger.error(`Хүргэлт ${id} gateway-ээр ИЛГЭЭГДСЭН (providerMessageId=${r.providerMessageId}) боловч SENT бичилт ${i + 1} оролдлогод унав [${err instanceof Error ? err.name : 'үл мэдэгдэх'}] — дахин илгээхгүй`);
          throw new DeliveryRecordError(id, r.providerMessageId, { cause: err });
        }
        await sleep(delay);
      }
    }
  }

  private remember(id: string, r: SentResult): void {
    this.unrecorded.delete(id);
    this.unrecorded.set(id, r);
    if (this.unrecorded.size > MAX_UNRECORDED) this.unrecorded.delete(this.unrecorded.keys().next().value as string);
  }

  private async send(channel: NotificationChannel, d: { id: string; type: string; applicationId: string | null; address: string | null; subject: string | null; body: string }): Promise<string> {
    if (!d.address) throw new ChannelError('INVALID_ADDRESS', false);
    switch (channel) {
      case 'SMS': return (await this.sms.send({ to: d.address, text: d.body, reference: d.id })).providerMessageId;
      case 'EMAIL': return (await this.email.send({ to: d.address, subject: d.subject ?? '', text: d.body, html: textToHtml(d.body), reference: d.id })).providerMessageId;
      case 'PUSH': {
        const data: Record<string, string> = { type: d.type, ...(d.applicationId ? { applicationId: d.applicationId } : {}) };
        return (await this.push.send({ token: d.address, title: d.subject ?? '', body: d.body, data, reference: d.id })).providerMessageId;
      }
      default: throw new ChannelError('PROVIDER_ERROR', false, 'Энэ суваг gateway-ээр илгээгддэггүй');
    }
  }

  private async onFailure(d: { id: string; orgId: string; channel: string; address: string | null }, attempt: number, f: Failure, err: unknown): Promise<ProcessOutcome> {
    // Хаяг, текст лог-д бичихгүй: зөвхөн delivery ID, суваг, код.
    const known = err instanceof ChannelError || err instanceof IntegrationNotConfiguredError || err instanceof IntegrationNotImplementedError;
    this.logger.warn(`Хүргэлт ${d.id} (${d.channel}) ${attempt}-р оролдлого: ${f.code}${f.retryable ? ' (дахин оролдоно)' : ''}${known ? '' : ` [${err instanceof Error ? err.name : 'үл мэдэгдэх'}]`}`);

    if (f.code === 'INVALID_TOKEN') {
      if (d.address) await this.prisma.pushDevice.updateMany({ where: { token: d.address }, data: { isActive: false } });
      await this.prisma.notificationDelivery.update({ where: { id: d.id }, data: { status: 'SKIPPED', attempts: attempt, lastError: f.code, nextAttemptAt: null } });
      return 'SKIPPED';
    }
    if (f.retryable) {
      const max = await this.maxAttempts(d.orgId);
      if (attempt < max) {
        const delay = backoffMs(attempt);
        await this.prisma.notificationDelivery.update({
          where: { id: d.id }, data: { status: 'QUEUED', attempts: attempt, lastError: f.code, nextAttemptAt: new Date(this.clock.now().getTime() + delay) },
        });
        try { await this.queue.enqueue(d.id, delay); } catch { /* DB-д QUEUED тул sweep() нөхнө */ }
        return 'RETRY';
      }
    }
    await this.prisma.notificationDelivery.update({ where: { id: d.id }, data: { status: 'FAILED', attempts: attempt, lastError: f.code, nextAttemptAt: null } });
    return 'FAILED';
  }

  private async maxAttempts(orgId: string): Promise<number> {
    const v = Number(await this.settings.get(orgId, 'notification.max_attempts'));
    return Number.isInteger(v) && v >= 1 ? v : DEFAULT_MAX_ATTEMPTS;
  }

  /**
   * Queue-д алдагдсан QUEUED мөрүүдийг (nextAttemptAt + grace ≤ now) дахин оруулна. Нэг delivery давхар орсон ч process()-ийн claim нэгийг л нэвтрүүлнэ.
   * @returns queue-д амжилттай оруулсан тоо
   */
  async sweep(limit = SWEEP_BATCH): Promise<number> {
    const threshold = new Date(this.clock.now().getTime() - this.queue.sweepGraceMs);
    const stuck = await this.prisma.notificationDelivery.findMany({
      where: { status: 'QUEUED', OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: threshold } }] },
      orderBy: { nextAttemptAt: { sort: 'asc', nulls: 'first' } }, take: limit, select: { id: true },
    });
    let enqueued = 0;
    for (const s of stuck) {
      try { await this.queue.enqueue(s.id); enqueued++; }
      catch (e) {
        // Queue хүрэхгүй бол үлдсэнийг оролдохгүй: нэг бүр timeout хүртэл хүлээж sweep-ийг удаан гацаахаас сэргийлнэ (мөр QUEUED үлдэж дараагийн sweep авна).
        this.logger.warn(`Sweep: queue-д орсонгүй (${enqueued}/${stuck.length} орсон) [${e instanceof Error ? e.name : 'үл мэдэгдэх'}]`);
        break;
      }
    }
    return enqueued;
  }
}
