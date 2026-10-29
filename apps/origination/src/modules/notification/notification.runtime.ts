import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DeliveryProcessor } from './delivery.processor';
import { NOTIFICATION_QUEUE, type NotificationQueue } from './notification.queue';
import { ReminderService } from './reminder.service';

/**
 * Queue-ийн worker + cron-ыг асаана, QUEUED мөрүүдийг сугалах `sweep()` timer-ийг ажиллуулна, унтрахад бүгдийг хаана.
 * `NOTIFICATION_SWEEP=off` бол timer ажиллахгүй (тестэд гараар дуудна). Интервал: `NOTIFICATION_SWEEP_INTERVAL_SEC` (анхдагч 60).
 */
@Injectable()
export class NotificationRuntime implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('NotificationRuntime');
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    @Inject(NOTIFICATION_QUEUE) private readonly queue: NotificationQueue,
    private readonly processor: DeliveryProcessor,
    private readonly reminders: ReminderService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.queue.start({ deliver: (id) => this.processor.process(id), runReminders: () => this.reminders.runAllOrgs() });
    if (process.env.NOTIFICATION_SWEEP === 'off') return;
    const sec = Math.max(5, Number(process.env.NOTIFICATION_SWEEP_INTERVAL_SEC) || 60);
    this.timer = setInterval(() => void this.sweepOnce(), sec * 1000);
    this.timer.unref();
  }

  async sweepOnce(): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    try { return await this.processor.sweep(); }
    catch (e) { this.logger.error(`Sweep алдаа: ${e instanceof Error ? e.message : 'үл мэдэгдэх'}`); return 0; }
    finally { this.sweeping = false; }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.queue.close();
  }
}
