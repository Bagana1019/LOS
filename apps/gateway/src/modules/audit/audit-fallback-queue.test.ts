import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MemoryAuditQueue, RedisAuditQueue, type AuditFallbackQueue, type AuditRow } from './audit-fallback-queue';

// M10 security review: drain-ийн устгал lock-ийн эзэмшил + толгойн яг таарах эсэхээр (Lua), DLQ хязгаартай, replay боломжтой.
const row = (action = 'A'): AuditRow => ({
  id: randomUUID(), orgId: null, entity: 'E', entityId: 'x', action, actorId: null, at: new Date('2026-11-19T00:00:00.123Z'),
  beforeJson: null, afterJson: { a: 1 }, applicationId: null, correlationId: null, ip: null, userAgent: null,
});

function contract(name: string, make: (opts: { dlqMax: number; now?: () => number }) => AuditFallbackQueue, wait: (ms: number) => Promise<void>) {
  describe(name, () => {
    it('round-trips a row (Date → ISO → Date)', async () => {
      const q = make({ dlqMax: 10 });
      const r = row();
      await q.push(r);
      const [item] = await q.peek(1);
      expect(item!.row).toEqual(r);
      expect(typeof item!.raw).toBe('string');
    });

    it('removeHead removes exactly the peeked items while the lease is held', async () => {
      const q = make({ dlqMax: 10 });
      const [a, b, c] = [row(), row(), row()];
      for (const r of [a, b, c]) await q.push(r);
      const token = (await q.acquire(5_000))!;
      expect(token).toBeTruthy();
      const items = await q.peek(2);
      expect(await q.removeHead(items.map((i) => i.raw), token)).toBe(true);
      expect((await q.peek(10)).map((i) => i.row!.id)).toEqual([c.id]);
      await q.release(token);
    });

    it('removeHead refuses (removes nothing) with a stale token or when the head changed', async () => {
      const q = make({ dlqMax: 10 });
      const [a, b] = [row(), row()];
      await q.push(a);
      await q.push(b);
      const token = (await q.acquire(5_000))!;
      const items = await q.peek(1);
      expect(await q.removeHead(items.map((i) => i.raw), 'not-the-owner')).toBe(false);
      const [, second] = await q.peek(2);
      expect(await q.removeHead([second!.raw], token)).toBe(false); // not the head
      expect(await q.size()).toBe(2);
      await q.release(token);
    });

    it('an expired lease can be taken by another pod and the old token no longer removes anything', async () => {
      let t = 0;
      const q = make({ dlqMax: 10, now: () => t });
      await q.push(row());
      const old = (await q.acquire(100))!;
      expect(await q.acquire(100)).toBeNull();
      t += 200;
      await wait(200);
      const fresh = (await q.acquire(5_000))!;
      expect(fresh).toBeTruthy();
      const items = await q.peek(1);
      expect(await q.removeHead(items.map((i) => i.raw), old)).toBe(false);
      expect(await q.renew(old, 5_000)).toBe(false);
      expect(await q.renew(fresh, 5_000)).toBe(true);
      expect(await q.removeHead(items.map((i) => i.raw), fresh)).toBe(true);
      await q.release(fresh);
    });

    it('dead letters are bounded (newest kept), every trimmed entry is returned to the caller, and can be replayed', async () => {
      const q = make({ dlqMax: 3 });
      const rows = [row(), row(), row(), row(), row()];
      const trimmed: (string | null)[] = [];
      for (const r of rows) {
        const res = await q.deadLetter({ raw: JSON.stringify(r), id: r.id, errorClass: 'P2000', failedAt: '2026-11-19T00:00:00.000Z' });
        trimmed.push(...res.trimmed.map((d) => d.id));
        expect(res.size).toBeLessThanOrEqual(3);
      }
      expect(trimmed).toEqual([rows[0]!.id, rows[1]!.id]);
      const dl = await q.deadLetters(10);
      expect(dl.map((d) => d.id)).toEqual(rows.slice(2).map((r) => r.id));
      expect(await q.replayDeadLetters(2)).toBe(2);
      expect((await q.peek(10)).map((i) => i.row!.id)).toEqual(rows.slice(2, 4).map((r) => r.id));
      expect((await q.deadLetters(10)).map((d) => d.id)).toEqual([rows[4]!.id]);
    });
  });
}

contract('MemoryAuditQueue', (o) => new MemoryAuditQueue(o), async () => undefined);

const REDIS_URL = process.env.REDIS_URL;
describe.skipIf(!REDIS_URL)('RedisAuditQueue (real Redis, Lua)', () => {
  let redis: Redis;
  const keys: string[] = [];
  beforeAll(() => { redis = new Redis(REDIS_URL!, { maxRetriesPerRequest: 1 }); });
  afterEach(async () => { if (keys.length) await redis.del(...keys.splice(0).flatMap((k) => [k, `${k}:drain-lock`, `${k}:dlq`])); });
  afterAll(() => { redis.disconnect(); });
  contract('RedisAuditQueue', (o) => {
    const key = `los:test:audit:${randomUUID()}`;
    keys.push(key);
    return new RedisAuditQueue(redis, { key, dlqKey: `${key}:dlq`, dlqMax: o.dlqMax });
  }, (ms) => new Promise((r) => setTimeout(r, ms)));
});
