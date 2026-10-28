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
}
export interface EventBus {
  publish(e: DomainEvent): Promise<void>;
  subscribe(group: string, types: DomainEvent['type'][], handler: (e: DomainEvent) => Promise<void>, opts?: SubscribeOptions): Promise<void>;
  close(): Promise<void>;
}

type StreamEntry = [id: string, fields: string[]];
const toMap = (f: string[]) => { const m: Record<string, string> = {}; for (let i = 0; i < f.length; i += 2) m[f[i]!] = f[i + 1]!; return m; };

export function createRedisEventBus(url: string, opts: { stream?: string; consumerName?: string; maxLen?: number } = {}): EventBus {
  const stream = opts.stream ?? EVENT_STREAM;
  const dlq = `${stream}:dlq`;
  const pub = new Redis(url, { maxRetriesPerRequest: 3 });
  const readers: Redis[] = [];
  let closed = false;

  async function ensureGroup(r: Redis, group: string) {
    try { await r.xgroup('CREATE', stream, group, '0', 'MKSTREAM'); } catch (e) { if (!String(e).includes('BUSYGROUP')) throw e; }
  }

  return {
    async publish(event) {
      const e = DomainEvent.parse(event);
      await pub.xadd(stream, 'MAXLEN', '~', String(opts.maxLen ?? 1_000_000), '*', 'eventId', e.eventId, 'type', e.type, 'payload', JSON.stringify(e));
    },

    async subscribe(group, types, handler, so = {}) {
      const reader = new Redis(url, { maxRetriesPerRequest: null });
      readers.push(reader);
      await ensureGroup(reader, group);
      const consumer = opts.consumerName ?? `${group}-${hostname()}-${process.pid}`;
      const wanted = new Set<string>(types);
      const maxDeliveries = so.maxDeliveries ?? 5;
      const retryAfterMs = so.retryAfterMs ?? 30_000;
      const blockMs = so.blockMs ?? 1000;

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
          if (deliveries >= maxDeliveries) {
            await reader.xadd(dlq, '*', 'group', group, 'id', id, 'error', String(err instanceof Error ? err.message : err).slice(0, 500), ...fields);
            await reader.xack(stream, group, id);
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
      await Promise.all(readers.map((r) => r.quit().catch(() => r.disconnect())));
      await pub.quit().catch(() => pub.disconnect());
    },
  };
}
