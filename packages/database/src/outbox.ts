// Transactional outbox (CLAUDE.md §3.2.4): domain event-ийг бизнес мөртэй НЭГ транзакцид `outbox` хүснэгтэд бичнэ,
// relay worker Redis Streams руу гаргана. Шууд publish хийхгүй.
import { randomUUID } from 'node:crypto';
import { DomainEvent, type RequestContext } from '@los/contracts';
import type { EventBus } from './event-bus';

export interface OutboxRow { id: string; type: string; payload: DomainEvent; createdAt: Date; publishedAt: Date | null }

/** Prisma interactive transaction (`prisma.$transaction(async (tx) => ...)`) — сервис бүрийн `outbox` загвартай. */
export interface OutboxTx {
  outbox: { create(args: { data: { id: string; type: string; payload: any } }): Promise<unknown> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Event-ийг схемээр шалгаад outbox руу бичнэ. `tx` нь бизнес бичлэгтэй ЯГ АДИЛ транзакц байх ёстой. */
export async function enqueueOutbox(tx: OutboxTx, event: DomainEvent): Promise<void> {
  const e = DomainEvent.parse(event);
  await tx.outbox.create({ data: { id: e.eventId, type: e.type, payload: e } });
}

type Fields<T extends DomainEvent['type']> = Omit<Extract<DomainEvent, { type: T }>, 'eventId' | 'occurredAt' | 'version' | 'orgId' | 'actorId' | 'correlationId'>;
/** Нийтлэг талбарыг (eventId, occurredAt, version, orgId, actorId, correlationId) контекстээс бөглөнө. */
export function buildEvent<T extends DomainEvent['type']>(ctx: Pick<RequestContext, 'orgId' | 'userId' | 'correlationId'>, type: T, fields: Omit<Fields<T>, 'type'>, now: Date = new Date()): Extract<DomainEvent, { type: T }> {
  return DomainEvent.parse({ ...fields, type, eventId: randomUUID(), occurredAt: now.toISOString(), version: 1, orgId: ctx.orgId, actorId: ctx.userId, correlationId: ctx.correlationId }) as Extract<DomainEvent, { type: T }>;
}

// ── Relay ──
interface RawDb {
  $transaction<T>(fn: (tx: RawTx) => Promise<T>): Promise<T>;
}
interface RawTx {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}
export interface OutboxRelayOptions {
  db: RawDb;
  /** Postgres schema (сервисийн нэр): origination, kyc, ... */
  schema: string;
  bus: Pick<EventBus, 'publish'>;
  batchSize?: number;
  pollMs?: number;
  log?: (level: 'info' | 'error', msg: string, extra?: unknown) => void;
}

/**
 * Нийтлээгүй мөрүүдийг `FOR UPDATE SKIP LOCKED`-ээр түгжиж (олон relay зэрэг ажиллаж болно), created_at дарааллаар
 * Redis Stream руу гаргаад `published_at` тавина. Нийтлэлт амжилтгүй болбол тэр мөрөөс эхлэн дараагийн удаа дахин оролдоно
 * (дараалал хадгалагдана; at-least-once — consumer idempotent байх ёстой).
 */
export class OutboxRelay {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private inflight: Promise<unknown> = Promise.resolve();
  private readonly batch: number;
  private readonly q: { select: string; mark: string };

  constructor(private readonly o: OutboxRelayOptions) {
    if (!/^[a-z_][a-z0-9_]*$/.test(o.schema)) throw new Error(`Invalid schema name "${o.schema}"`);
    this.batch = o.batchSize ?? 100;
    this.q = {
      select: `SELECT id, type, payload FROM "${o.schema}"."outbox" WHERE published_at IS NULL ORDER BY created_at, id LIMIT $1 FOR UPDATE SKIP LOCKED`,
      mark: `UPDATE "${o.schema}"."outbox" SET published_at = now() WHERE id = ANY($1::text[])`,
    };
  }

  /** Нэг багц гаргана; нийтэлсэн тоог буцаана. */
  async relayOnce(): Promise<number> {
    return this.o.db.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ id: string; type: string; payload: unknown }[]>(this.q.select, this.batch);
      const done: string[] = [];
      let failure: unknown;
      for (const r of rows) {
        try {
          await this.o.bus.publish(DomainEvent.parse(r.payload));
          done.push(r.id);
        } catch (e) { failure = e; break; }
      }
      if (done.length) await tx.$executeRawUnsafe(this.q.mark, done);
      if (failure) this.o.log?.('error', `outbox publish failed at ${rows[done.length]?.id}: ${failure instanceof Error ? failure.message : String(failure)}`);
      return done.length;
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = () => {
      if (!this.running) return;
      this.inflight = this.relayOnce()
        .then((n) => n >= this.batch)
        .catch((e) => { this.o.log?.('error', `outbox relay error: ${e instanceof Error ? e.message : String(e)}`); return false; })
        .then((more) => { if (this.running) this.timer = setTimeout(tick, more ? 0 : (this.o.pollMs ?? 500)); });
    };
    tick();
  }
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await this.inflight;
  }
}
