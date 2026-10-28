import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Global, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DomainEvent } from '@los/contracts';
import { createRedisEventBus } from '@los/database';
import { describe, expect, it } from 'vitest';
import { EVENT_BUS, EventsModule } from './events.module';

@Injectable()
class FakeDb {
  published: string[] = [];
  private rows: { id: string; type: string; payload: unknown }[] = [];
  seed(e: unknown, id: string) { this.rows.push({ id, type: 'SettingsChanged', payload: e }); }
  async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    return fn({
      $queryRawUnsafe: async () => this.rows.filter((r) => !this.published.includes(r.id)),
      $executeRawUnsafe: async (_q: string, ids: string[]) => { this.published.push(...ids); return ids.length; },
    });
  }
}
@Global()
@Module({ providers: [FakeDb], exports: [FakeDb] })
class FakeDbModule {}

const REDIS_URL = process.env.REDIS_URL;
const event = (id: string) => DomainEvent.parse({ type: 'SettingsChanged', eventId: id, occurredAt: new Date().toISOString(), version: 1, orgId: 'org', actorId: 'u', correlationId: 'c', key: 'br1.dti_max', productId: null });

describe('EventsModule', () => {
  it('without REDIS_URL the bus is null and the app still boots (no relay)', async () => {
    const saved = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    try {
      const mod = await Test.createTestingModule({ imports: [FakeDbModule, EventsModule.forRoot({ schema: 'test', db: FakeDb })] }).compile();
      await mod.init();
      expect(mod.get(EVENT_BUS)).toBeNull();
      await mod.close();
    } finally { if (saved) process.env.REDIS_URL = saved; }
  });

  it.skipIf(!REDIS_URL)('relays outbox rows to the Redis stream and stops cleanly on shutdown', async () => {
    const saved = { url: process.env.REDIS_URL, poll: process.env.OUTBOX_POLL_MS };
    process.env.OUTBOX_POLL_MS = '20';
    // EventsModule анхдагч stream-д бичнэ → тестийн consumer мөн анхдагч stream-ийг сонсоно
    const defaultBus = createRedisEventBus(REDIS_URL!);
    const got: string[] = [];
    const id = randomUUID();
    try {
      await defaultBus.subscribe(`events-module-test-${Date.now()}`, ['SettingsChanged'], async (e) => { got.push(e.eventId); });
      const mod = await Test.createTestingModule({ imports: [FakeDbModule, EventsModule.forRoot({ schema: 'test', db: FakeDb })] }).compile();
      mod.get(FakeDb).seed(event(id), id);
      await mod.init();
      for (let i = 0; i < 100 && !got.includes(id); i++) await new Promise((r) => setTimeout(r, 50));
      expect(got).toContain(id);
      expect(mod.get(FakeDb).published).toEqual([id]);
      await mod.close();
    } finally {
      process.env.OUTBOX_POLL_MS = saved.poll as string;
      if (saved.poll === undefined) delete process.env.OUTBOX_POLL_MS;
      await defaultBus.close();
    }
  });
});
