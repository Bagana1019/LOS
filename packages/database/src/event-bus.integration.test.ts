// C1: one consumer group = one subscriber. Requires real Redis (REDIS_URL); skipped otherwise.
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createRedisEventBus, type EventBus } from './event-bus';
import { buildEvent } from './outbox';

const REDIS_URL = process.env.REDIS_URL;
const ctx = { orgId: 'o1', userId: 'u1', correlationId: 'corr' };
const settings = () => buildEvent(ctx, 'SettingsChanged', { key: 'k', productId: null });
const kyc = () => buildEvent(ctx, 'KycCompleted', { applicationId: 'a1', customerId: 'c1', blacklisted: false });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 8000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('timeout waiting for condition'); await sleep(25); } };
const newStream = () => `test:c1:${randomUUID()}`;

describe.skipIf(!REDIS_URL)('event bus: consumer group ownership (C1)', () => {
  const buses: EventBus[] = [];
  const mk = (stream: string) => { const b = createRedisEventBus(REDIS_URL!, { stream }); buses.push(b); return b; };
  afterAll(async () => { await Promise.all(buses.map((b) => b.close())); });

  it('refuses a second subscriber in the same group (it would split the stream and XACK-drop the other one\'s events)', async () => {
    const bus = mk(newStream());
    const seen: string[] = [];
    await bus.subscribe('shared', ['SettingsChanged'], async (e) => { seen.push(e.eventId); });
    await expect(bus.subscribe('shared', ['KycCompleted'], async () => undefined)).rejects.toThrow(/consumer group "shared" already has a subscriber/);
    // the first subscription is unaffected and receives every event of its type
    const events = [settings(), settings(), settings()];
    for (const e of events) await bus.publish(e);
    await until(() => seen.length === events.length);
    expect(seen).toEqual(events.map((e) => e.eventId));
  });

  it('refuses the same group across two bus instances in one process', async () => {
    const stream = newStream();
    await mk(stream).subscribe('dup', ['SettingsChanged'], async () => undefined);
    await expect(mk(stream).subscribe('dup', ['SettingsChanged'], async () => undefined)).rejects.toThrow(/already has a subscriber/);
  });

  it('allows the same group name on a different stream', async () => {
    await mk(newStream()).subscribe('same-name', ['SettingsChanged'], async () => undefined);
    await expect(mk(newStream()).subscribe('same-name', ['SettingsChanged'], async () => undefined)).resolves.toBeUndefined();
  });

  it('releases the group on close so a restarted bus can subscribe again', async () => {
    const stream = newStream();
    const first = createRedisEventBus(REDIS_URL!, { stream });
    await first.subscribe('restart', ['SettingsChanged'], async () => undefined);
    await first.close();
    const got: string[] = [];
    const second = mk(stream);
    await second.subscribe('restart', ['SettingsChanged'], async (e) => { got.push(e.eventId); });
    const e = settings(); await second.publish(e);
    await until(() => got.includes(e.eventId));
  });

  it('separate groups each receive every event of their types (notification + contract layout)', async () => {
    const bus = mk(newStream());
    const a: string[] = []; const b: string[] = [];
    await bus.subscribe('svc-notification', ['SettingsChanged'], async (e) => { a.push(e.eventId); });
    await bus.subscribe('svc-contract', ['KycCompleted'], async (e) => { b.push(e.eventId); });
    const s = Array.from({ length: 10 }, settings); const k = Array.from({ length: 10 }, kyc);
    for (let i = 0; i < 10; i++) { await bus.publish(s[i]!); await bus.publish(k[i]!); }
    await until(() => a.length === 10 && b.length === 10);
    expect(a).toEqual(s.map((e) => e.eventId));
    expect(b).toEqual(k.map((e) => e.eventId));
  });

  it('startId: a newly created group starts after the given id and skips older events', async () => {
    const stream = newStream();
    const bus = mk(stream);
    const old = settings(); await bus.publish(old);
    // Redis assigns IDs from its own clock — use the stored ID of `old`, not local Date.now()
    const { Redis } = await import('ioredis');
    const r = new Redis(REDIS_URL!);
    const startId = await r.xrange(stream, '-', '+').then((rows) => rows[0]![0]).finally(() => r.disconnect());
    const fresh = settings(); await bus.publish(fresh);
    const got: string[] = [];
    await bus.subscribe('from-now', ['SettingsChanged'], async (e) => { got.push(e.eventId); }, { startId });
    await until(() => got.includes(fresh.eventId));
    await sleep(200);
    expect(got).toEqual([fresh.eventId]);
  });

  it('startId is ignored when the group already exists (no skipped backlog on restart)', async () => {
    const stream = newStream();
    const first = createRedisEventBus(REDIS_URL!, { stream });
    await first.subscribe('existing', ['SettingsChanged'], async () => undefined);
    await first.close();
    const pending = settings(); await mk(stream).publish(pending); // published while no subscriber runs
    await sleep(5);
    const got: string[] = [];
    await mk(stream).subscribe('existing', ['SettingsChanged'], async (e) => { got.push(e.eventId); }, { startId: `${Date.now()}-0` });
    await until(() => got.includes(pending.eventId));
  });

  it('rejects a malformed startId', async () => {
    await expect(mk(newStream()).subscribe('bad-start', ['SettingsChanged'], async () => undefined, { startId: 'yesterday' })).rejects.toThrow(/startId/);
  });
});
