// Redis Streams (XADD/XREADGROUP) дээр суурилсан event bus. consumer group = сервисийн нэр; at-least-once; idempotency eventId-аар.
import { hostname } from 'node:os';
import { DomainEvent, EVENT_STREAM } from '@los/contracts';
import { Redis } from 'ioredis';

export const DEAD_LETTER_STREAM = `${EVENT_STREAM}:dlq`;

export interface SubscribeOptions {
  /** Нэг мессежийг хэдэн удаа хүргэсний дараа dead-letter руу шилжүүлэх (анхдагч 5). */
  maxDeliveries?: number;
  /** Баталгаажаагүй (pending) мессежийг дахин хүргэх хүртэл хүлээх ms (анхдагч 30000). */
  retryAfterMs?: number;
  blockMs?: number;
  onError?: (err: unknown, event?: DomainEvent) => void;
  /**
   * Stream ID the group starts after IF the group does not exist yet (anhdagch '0' = stream-д үлдсэн бүх түүх). Existing group-д нөлөөгүй.
   * `${ms}-0` хэлбэрээр шинэ group-ийн replay-г хугацаагаар хязгаарлана.
   */
  startId?: string;
  /**
   * Infrastructure fault (e.g. the subscriber's DB is unreachable) → `true`: the failure does NOT consume a delivery attempt, the message
   * stays pending and is redelivered after retryAfterMs (never dead-lettered for it). Omitted → every error counts (previous behaviour).
   * A throwing classifier counts as `false`.
   */
  isTransientError?: (err: unknown) => boolean;
  /** Called once when a message is moved to the dead-letter stream (after maxDeliveries counted failures). */
  onDeadLetter?: (err: unknown, event?: DomainEvent) => void;
}
export interface EventBus {
  publish(e: DomainEvent): Promise<void>;
  subscribe(group: string, types: DomainEvent['type'][], handler: (e: DomainEvent) => Promise<void>, opts?: SubscribeOptions): Promise<void>;
  close(): Promise<void>;
}

type StreamEntry = [id: string, fields: string[]];
const START_ID = /^(\$|\d+(-\d+)?)$/;

/**
 * C1: нэг group-д хоёр subscriber байвал Redis мессеж бүрийг зөвхөн НЭГ уншигчид өгдөг, тэр нь өөрт хамааралгүй төрлийг XACK хийж хаядаг —
 * нөгөө subscriber event-ээ чимээгүй алддаг. Тиймээс нэг процесст (url, stream, group) бүрт ганц subscriber; давхар бол subscribe шиднэ.
 */
const claimedGroups = new Set<string>();

const toMap = (f: string[]) => { const m: Record<string, string> = {}; for (let i = 0; i < f.length; i += 2) m[f[i]!] = f[i + 1]!; return m; };

export function createRedisEventBus(url: string, opts: { stream?: string; consumerName?: string; maxLen?: number } = {}): EventBus {
  const stream = opts.stream ?? EVENT_STREAM;
  const dlq = `${stream}:dlq`;
  const pub = new Redis(url, { maxRetriesPerRequest: 3 });
  const readers: Redis[] = [];
  const ownedGroups: string[] = [];
  let closed = false;

  async function ensureGroup(r: Redis, group: string, startId: string) {
    try { await r.xgroup('CREATE', stream, group, startId, 'MKSTREAM'); } catch (e) { if (!String(e).includes('BUSYGROUP')) throw e; }
  }

  return {
    async publish(event) {
      const e = DomainEvent.parse(event);
      await pub.xadd(stream, 'MAXLEN', '~', String(opts.maxLen ?? 1_000_000), '*', 'eventId', e.eventId, 'type', e.type, 'payload', JSON.stringify(e));
    },

    async subscribe(group, types, handler, so = {}) {
      const startId = so.startId ?? '0';
      if (!START_ID.test(startId)) throw new Error(`event bus: invalid startId "${startId}" (expected '0', '$' or '<ms>-<seq>')`);
      const key = `${url}\u0000${stream}\u0000${group}`;
      // await-аас ӨМНӨ эзэмшинэ: зэрэг дуудсан хоёр subscribe хоёулаа шалгалтыг давахгүй
      if (claimedGroups.has(key)) throw new Error(`event bus: consumer group "${group}" already has a subscriber on stream "${stream}" in this process — give each subscriber its own group, otherwise they drop each other's events`);
      claimedGroups.add(key);
      const reader = new Redis(url, { maxRetriesPerRequest: null });
      try {
        await ensureGroup(reader, group, startId);
      } catch (err) {
        claimedGroups.delete(key);
        reader.disconnect();
        throw err;
      }
      readers.push(reader);
      ownedGroups.push(key);
      const consumer = opts.consumerName ?? `${group}-${hostname()}-${process.pid}`;
      const wanted = new Set<string>(types);
      const maxDeliveries = so.maxDeliveries ?? 5;
      const retryAfterMs = so.retryAfterMs ?? 30_000;
      const blockMs = so.blockMs ?? 1000;
      const isTransient = (err: unknown) => { try { return so.isTransientError?.(err) === true; } catch { return false; } };

      const handle = async (id: string, fields: string[]) => {
        const m = toMap(fields);
        if (!m.type || !wanted.has(m.type)) { await reader.xack(stream, group, id); return; }
        let event: DomainEvent | undefined;
        try {
          event = DomainEvent.parse(JSON.parse(m.payload ?? 'null'));
          await handler(event);
          await reader.xack(stream, group, id);
        } catch (err) {
          so.onError?.(err, event);
          // хүргэлтийн тоо хэтэрвэл dead-letter; үгүй бол pending үлдээж retryAfterMs-ийн дараа дахин хүргэнэ
          const pend = (await reader.xpending(stream, group, id, id, 1)) as [string, string, number, number][];
          const deliveries = pend[0]?.[3] ?? 1;
          if (isTransient(err)) {
            // undo this delivery's increment (XCLAIM RETRYCOUNT sets the counter; JUSTID itself does not increment it)
            await reader.call('XCLAIM', stream, group, consumer, '0', id, 'RETRYCOUNT', String(Math.max(0, deliveries - 1)), 'JUSTID');
            return;
          }
          if (deliveries >= maxDeliveries) {
            await reader.xadd(dlq, '*', 'group', group, 'id', id, 'error', String(err instanceof Error ? err.message : err).slice(0, 500), ...fields);
            await reader.xack(stream, group, id);
            so.onDeadLetter?.(err, event);
          }
        }
      };

      const loop = async () => {
        let lastClaim = 0;
        while (!closed) {
          try {
            if (Date.now() - lastClaim > Math.min(retryAfterMs, 5000)) {
              lastClaim = Date.now();
              const claimed = (await reader.xautoclaim(stream, group, consumer, retryAfterMs, '0', 'COUNT', 20)) as [string, StreamEntry[]];
              for (const [id, f] of claimed[1] ?? []) if (f) await handle(id, f);
            }
            const res = (await reader.xreadgroup('GROUP', group, consumer, 'COUNT', 20, 'BLOCK', blockMs, 'STREAMS', stream, '>')) as [string, StreamEntry[]][] | null;
            for (const [, entries] of res ?? []) for (const [id, f] of entries) await handle(id, f);
          } catch (err) {
            if (closed) return;
            so.onError?.(err);
            await new Promise((r) => setTimeout(r, 500));
          }
        }
      };
      void loop();
    },

    async close() {
      closed = true;
      for (const key of ownedGroups) claimedGroups.delete(key);
      await Promise.all(readers.map((r) => r.quit().catch(() => r.disconnect())));
      await pub.quit().catch(() => pub.disconnect());
    },
  };
}
