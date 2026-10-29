import request from 'supertest';
import { vi } from 'vitest';
import type { TestingModuleBuilder } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import type { DomainEvent } from '@los/contracts';
import { MockEmailGateway } from '../../integrations/email/email.mock';
import { EMAIL_GATEWAY } from '../../integrations/email/email.provider';
import { MockPushGateway } from '../../integrations/push/push.mock';
import { PUSH_GATEWAY } from '../../integrations/push/push.provider';
import { MockSmsGateway } from '../../integrations/sms/sms.mock';
import { SMS_GATEWAY } from '../../integrations/sms/sms.provider';
import { ORG, resetDb } from '../../test-utils/factories';
import { createTestApp, TestApp } from '../../test-utils/test-app';
import { DeliveryProcessor } from './delivery.processor';
import { NotificationEventConsumer } from './notification-event.consumer';
import { NOTIFICATION_QUEUE, type NotificationQueue, type QueueHandlers } from './notification.queue';
import { NotificationModule } from './notification.module';
import { NotificationService } from './notification.service';
import { ReminderService } from './reminder.service';

/** Тестэд queue-г гараар удирдана: enqueue-г бүртгэнэ, `flush()` дуудах хүртэл боловсруулахгүй. */
export class ManualQueue implements NotificationQueue {
  readonly mode = 'inline' as const;
  sweepGraceMs = 0;
  readonly enqueued: Array<{ id: string; delayMs: number }> = [];
  handlers: QueueHandlers | null = null;
  async enqueue(id: string, delayMs = 0) { this.enqueued.push({ id, delayMs }); }
  async start(h: QueueHandlers) { this.handlers = h; }
  async close() { this.handlers = null; }
  reset() { this.enqueued.length = 0; }
  /** Бүртгэгдсэн (delay=0) ID-уудыг боловсруулна. */
  async flush() { const ids = this.enqueued.filter((e) => e.delayMs === 0).map((e) => e.id); this.reset(); for (const id of ids) await this.handlers!.deliver(id); }
}

export interface NotificationEnv {
  t: TestApp; sms: MockSmsGateway; email: MockEmailGateway; push: MockPushGateway;
  service: NotificationService; processor: DeliveryProcessor; reminders: ReminderService; consumer: NotificationEventConsumer;
  queue: NotificationQueue; manual: ManualQueue | null;
  http: () => ReturnType<typeof request>;
}

/** NotificationModule-ийг mock интеграцитай босгоно. `manual=true` бол queue-г ManualQueue-ээр сольж, QUEUED төлөвийг ажиглана; үгүй бол inline (шууд илгээнэ). */
export async function bootNotification(opts: { manual?: boolean; customize?: (b: TestingModuleBuilder) => TestingModuleBuilder } = {}): Promise<NotificationEnv> {
  process.env.NOTIFICATION_QUEUE = 'inline';
  process.env.NOTIFICATION_SWEEP = 'off';
  const manual = opts.manual ? new ManualQueue() : null;
  const t = await createTestApp([NotificationModule], (b) => {
    const base = manual ? b.overrideProvider(NOTIFICATION_QUEUE).useValue(manual) : b;
    return opts.customize ? opts.customize(base) : base;
  });
  return {
    t, sms: t.app.get(SMS_GATEWAY), email: t.app.get(EMAIL_GATEWAY), push: t.app.get(PUSH_GATEWAY),
    service: t.app.get(NotificationService), processor: t.app.get(DeliveryProcessor), reminders: t.app.get(ReminderService), consumer: t.app.get(NotificationEventConsumer),
    queue: t.app.get(NOTIFICATION_QUEUE), manual, http: () => request(t.app.getHttpServer()),
  };
}

export async function resetNotification(env: NotificationEnv): Promise<void> {
  vi.restoreAllMocks();
  await resetDb(env.t.prisma);
  env.t.clock.set('2026-10-28T02:00:00Z');
  for (const g of [env.sms, env.email, env.push] as Array<{ reset?: () => void }>) g.reset?.(); // Real gateway-д reset байхгүй
  env.manual?.reset();
  env.t.bus.published.length = 0;
}

export async function setSetting(env: NotificationEnv, key: string, valueJson: unknown): Promise<void> {
  await env.t.prisma.setting.upsert({ where: { orgId_key: { orgId: ORG, key } }, create: { orgId: ORG, key, valueJson: valueJson as never }, update: { valueJson: valueJson as never } });
}

type EventBody = { [K in DomainEvent['type']]: Omit<Extract<DomainEvent, { type: K }>, 'eventId' | 'occurredAt' | 'version' | 'orgId' | 'actorId' | 'correlationId'> }[DomainEvent['type']];

/** In-memory bus-д event publish хийнэ (handler-ууд шууд, дарааллаар ажиллана). */
export async function publish(env: NotificationEnv, body: EventBody, eventId: string = randomUUID()): Promise<DomainEvent> {
  const event = { ...body, eventId, occurredAt: env.t.clock.now().toISOString(), version: 1, orgId: ORG, actorId: null, correlationId: 'test-corr' } as DomainEvent;
  await env.t.bus.publish(event);
  return event;
}

export const deliveries = (env: NotificationEnv, where: object = {}) => env.t.prisma.notificationDelivery.findMany({ where, orderBy: [{ channel: 'asc' }, { dedupeKey: 'asc' }] });

/**
 * `notificationDelivery.update`-ийг DB-ийн түр алдаагаар (connection reset) унагана — `shouldFail(args)` үнэн бол `times` удаа хүртэл.
 * Prisma-ийн model delegate нь `vi.spyOn`-д тохирохгүй (restore хийхэд арга нь алдагддаг) тул шууд солиод буцаана.
 * @returns `{ calls, failed, restore }` — `restore()` заавал дуудна.
 */
export function failDeliveryUpdates(env: NotificationEnv, shouldFail: (args: { data?: { status?: string } }) => boolean, times = Infinity) {
  const delegate = env.t.prisma.notificationDelivery as unknown as { update: (args: never) => unknown };
  const original = delegate.update;
  const state = { calls: 0, failed: 0 };
  delegate.update = ((args: { data?: { status?: string } }) => {
    state.calls++;
    if (state.failed < times && shouldFail(args)) { state.failed++; return Promise.reject(new Error('connection reset by peer')); }
    return original.call(delegate, args as never);
  }) as never;
  return { state, restore: () => { delegate.update = original; } };
}
