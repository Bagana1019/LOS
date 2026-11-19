// HIGH/MEDIUM/LOW (C3) wiring: transient DWH failures are flagged to the bus (no delivery attempt consumed), dead letters are counted,
// and no group subscribes before the DWH schema is up to date (otherwise every event would fail against an old schema).
import type { EventBus, SubscribeOptions } from '@los/database';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DwhSchemaService } from '../etl/dwh-schema';
import { ConsumerStatusRegistry } from './consumer-status';
import { DWH_SUBSCRIPTIONS } from './decode';
import { DwhConsumersService } from './dwh-consumers.service';
import type { DwhProjector } from './dwh-projector';

const fakeBus = () => {
  const subs = new Map<string, SubscribeOptions>();
  const bus: EventBus = { publish: vi.fn(), close: vi.fn(async () => undefined), subscribe: vi.fn(async (group, _t, _h, opts) => { subs.set(group, opts ?? {}); }) };
  return { bus, subs };
};
const schemaWith = (results: boolean[]) => ({ ensure: vi.fn(async () => results.shift() ?? true) }) as unknown as DwhSchemaService;
const projector = { handle: vi.fn(async () => 'APPLIED') } as unknown as DwhProjector;

describe('DwhConsumersService', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('subscribes every group with a DWH transient-error classifier and a dead-letter counter', async () => {
    const { bus, subs } = fakeBus();
    const status = new ConsumerStatusRegistry();
    await new DwhConsumersService(bus, projector, status, schemaWith([true])).onModuleInit();
    expect([...subs.keys()].sort()).toEqual(DWH_SUBSCRIPTIONS.map((s) => s.group).sort());
    const opts = subs.get('dwh-sync-application')!;
    expect(opts.isTransientError?.(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }))).toBe(true);
    expect(opts.isTransientError?.(Object.assign(new Error('dup'), { code: '23505' }))).toBe(false);
    opts.onDeadLetter?.(new Error('poison'));
    expect(status.snapshot().groups['dwh-sync-application']).toMatchObject({ subscribed: true, deadLettered: 1 });
    expect(() => status.assertHealthy('dwh-sync-application')).not.toThrow();
  });

  it('a transient error is not recorded as a consumer failure; a deterministic one is', async () => {
    const { bus, subs } = fakeBus();
    const status = new ConsumerStatusRegistry();
    await new DwhConsumersService(bus, projector, status, schemaWith([true])).onModuleInit();
    const opts = subs.get('dwh-sync-scoring')!;
    opts.onError?.(Object.assign(new Error('Connection terminated unexpectedly'), {}));
    expect(status.snapshot().groups['dwh-sync-scoring']!.consecutiveFailures).toBe(0);
    opts.onError?.(Object.assign(new Error('bad'), { code: '22P02' }));
    expect(status.snapshot().groups['dwh-sync-scoring']!.consecutiveFailures).toBe(1);
  });

  it('does not subscribe while the DWH schema cannot be brought up to date, then subscribes once it can', async () => {
    vi.useFakeTimers();
    const { bus, subs } = fakeBus();
    const status = new ConsumerStatusRegistry();
    const schema = schemaWith([false, false, true]);
    const svc = new DwhConsumersService(bus, projector, status, schema);
    await svc.onModuleInit();
    expect(subs.size).toBe(0);
    expect(() => status.assertHealthy('dwh-sync-bsa')).toThrow(/not subscribed/);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(subs.size).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(subs.size).toBe(DWH_SUBSCRIPTIONS.length);
    expect(schema.ensure).toHaveBeenCalledTimes(3);
    await svc.onApplicationShutdown();
  });

  it('without an event bus it still brings the schema up and marks the bus disabled', async () => {
    const status = new ConsumerStatusRegistry();
    const schema = schemaWith([true]);
    await new DwhConsumersService(null, projector, status, schema).onModuleInit();
    expect(schema.ensure).toHaveBeenCalledTimes(1);
    expect(status.snapshot().busEnabled).toBe(false);
  });

  it('shutdown stops the schema retry loop', async () => {
    vi.useFakeTimers();
    const { bus, subs } = fakeBus();
    const schema = schemaWith([false, true]);
    const svc = new DwhConsumersService(bus, projector, new ConsumerStatusRegistry(), schema);
    await svc.onModuleInit();
    await svc.onApplicationShutdown();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(subs.size).toBe(0);
    expect(schema.ensure).toHaveBeenCalledTimes(1);
  });
});
