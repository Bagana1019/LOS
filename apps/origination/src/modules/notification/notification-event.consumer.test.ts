import { describe, expect, it, vi } from 'vitest';
import type { EventBus } from '@los/database';
import type { PrismaService } from '../../prisma.service';
import { NOTIFICATION_EVENT_GROUP, NOTIFICATION_REPLAY_LOOKBACK_MS, NotificationEventConsumer } from './notification-event.consumer';
import type { NotificationService } from './notification.service';

const fakeBus = () => {
  const subscribe = vi.fn<EventBus['subscribe']>().mockResolvedValue(undefined);
  return { bus: { publish: vi.fn(), subscribe, close: vi.fn() } as EventBus, subscribe };
};
const mk = (bus: EventBus | null) => new NotificationEventConsumer(bus, {} as PrismaService, {} as NotificationService);

describe('NotificationEventConsumer subscription (FR-13.2, C1)', () => {
  it("subscribes in its own group 'origination-notification', not the shared 'origination' group", async () => {
    const { bus, subscribe } = fakeBus();
    await mk(bus).onModuleInit();
    expect(subscribe).toHaveBeenCalledTimes(1);
    const [group, types] = subscribe.mock.calls[0]!;
    expect(NOTIFICATION_EVENT_GROUP).toBe('origination-notification');
    expect(group).toBe('origination-notification');
    expect(types).toEqual(['ApplicationApproved', 'ApplicationReturned', 'DisbursementApproved', 'PaymentReceived']);
  });

  it('a newly created group replays only the last 24h (no months-old customer notifications after deploy)', async () => {
    const { bus, subscribe } = fakeBus();
    const before = Date.now();
    await mk(bus).onModuleInit();
    const after = Date.now();
    const startId = subscribe.mock.calls[0]![3]?.startId;
    expect(startId).toMatch(/^\d+-0$/);
    const ms = Number(startId!.split('-')[0]);
    expect(NOTIFICATION_REPLAY_LOOKBACK_MS).toBe(24 * 60 * 60 * 1000);
    expect(ms).toBeGreaterThanOrEqual(before - NOTIFICATION_REPLAY_LOOKBACK_MS);
    expect(ms).toBeLessThanOrEqual(after - NOTIFICATION_REPLAY_LOOKBACK_MS);
  });

  it('subscribe failure propagates (service must not start silently deaf)', async () => {
    const { bus, subscribe } = fakeBus();
    subscribe.mockRejectedValue(new Error('consumer group "origination-notification" already has a subscriber'));
    await expect(mk(bus).onModuleInit()).rejects.toThrow(/already has a subscriber/);
  });

  it('no bus (REDIS_URL unset / OUTBOX_RELAY=off) → no subscription, boot continues', async () => {
    await expect(mk(null).onModuleInit()).resolves.toBeUndefined();
  });
});
