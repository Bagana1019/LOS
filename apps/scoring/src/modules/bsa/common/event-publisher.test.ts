// PrismaEventPublisher (fake транзакцийн клиентээр) · InMemoryEventPublisher · buildStatementImportedEvent. Бүх id/нэр хуурмаг.
import { DomainEvent, StatementImported } from '@los/contracts';
import { describe, expect, it } from 'vitest';
import {
  buildStatementImportedEvent,
  InMemoryEventPublisher,
  InvalidDomainEventError,
  PrismaEventPublisher,
  validateDomainEvent,
  type EventContext,
} from './event-publisher';
import type { RequestContext } from './infra.ports';

const U1 = '6f1b2c3d-1111-4111-8111-000000000001';
const U2 = '6f1b2c3d-2222-4222-8222-000000000002';
const NOW = new Date('2026-10-28T03:04:05.678Z');
const ctx: EventContext = { orgId: 'org-1', correlationId: 'corr-1', userId: 'user-7' };

const imported = (over: Record<string, unknown> = {}) => ({
  eventId: U1, type: 'StatementImported', version: 1, occurredAt: NOW.toISOString(), orgId: 'org-1', actorId: 'user-7', correlationId: 'corr-1',
  analysisId: 'an-1', applicationId: 'app-1', rows: 12, status: 'COMPLETED', ...over,
}) as DomainEvent;

/** PostgreSQL-ийн outbox-ийн дүр: PK (id). skipDuplicates=false үед давхар id нь P2002-тэй адил алдаа (мөн транзакцийг "aborted" болгоно) */
class FakeOutboxTx {
  rows = new Map<string, { id: string; type: string; payload: unknown }>();
  aborted = false;
  calls: unknown[] = [];
  failWith: Error | null = null;
  outbox = {
    createMany: async (args: { data: Array<{ id: string; type: string; payload: unknown }>; skipDuplicates: boolean }) => {
      this.calls.push(args);
      if (this.failWith) throw this.failWith;
      if (this.aborted) throw new Error('current transaction is aborted');
      for (const row of args.data) {
        if (this.rows.has(row.id)) {
          if (args.skipDuplicates) continue;
          this.aborted = true;
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
        this.rows.set(row.id, row);
      }
      return { count: args.data.length };
    },
  };
}

describe('validateDomainEvent', () => {
  it('accepts every catalogue shape it is given and strips unknown keys', () => {
    const v = validateDomainEvent({ ...imported(), customerName: 'Бат-Эрдэнэ' });
    expect(v).toEqual(imported());
    expect(v).not.toHaveProperty('customerName');
  });
});

describe('PrismaEventPublisher', () => {
  const publisher = new PrismaEventPublisher();

  it('writes {id: eventId, type, payload} through the passed transaction client', async () => {
    const tx = new FakeOutboxTx();
    await publisher.enqueue(tx, imported());
    expect([...tx.rows.values()]).toEqual([{ id: U1, type: 'StatementImported', payload: imported() }]);
    expect(DomainEvent.parse(tx.rows.get(U1)!.payload)).toEqual(imported());
  });

  it('is idempotent for a duplicate eventId and does not poison the transaction (ON CONFLICT DO NOTHING)', async () => {
    const tx = new FakeOutboxTx();
    await publisher.enqueue(tx, imported());
    await expect(publisher.enqueue(tx, imported({ rows: 99 }))).resolves.toBeUndefined();
    expect(tx.rows.size).toBe(1);
    expect(tx.aborted).toBe(false);
    await publisher.enqueue(tx, imported({ eventId: U2 })); // дараагийн бичилт ажиллана
    expect(tx.rows.size).toBe(2);
    expect((tx.calls[1] as { skipDuplicates: boolean }).skipDuplicates).toBe(true);
  });

  it.each([
    ['non-uuid eventId', { eventId: 'abc' }],
    ['unknown version', { version: 2 }],
    ['bad status', { status: 'SECRET-STATUS' }],
    ['non-datetime occurredAt', { occurredAt: 'yesterday' }],
    ['missing analysisId', { analysisId: undefined }],
    ['rows as string', { rows: '12' }],
    ['unknown type', { type: 'StatementDeleted' }],
  ])('rejects an invalid event (%s) before touching the database', async (_n, over) => {
    const tx = new FakeOutboxTx();
    await expect(publisher.enqueue(tx, imported(over))).rejects.toBeInstanceOf(InvalidDomainEventError);
    expect(tx.calls).toEqual([]);
  });

  it('error issues name the path and zod code but never echo submitted values', async () => {
    const err = await publisher.enqueue(new FakeOutboxTx(), imported({ status: 'SECRET-STATUS', analysisId: 12345 })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidDomainEventError);
    const e = err as InvalidDomainEventError;
    expect(e.issues).toEqual(expect.arrayContaining([expect.stringMatching(/^status: invalid_enum_value/), expect.stringMatching(/^analysisId: invalid_type/)]));
    expect(e.message).not.toContain('SECRET-STATUS');
    expect(e.message).not.toContain('12345');
  });

  it('does not persist unknown properties (cannot smuggle PII into the outbox)', async () => {
    const tx = new FakeOutboxTx();
    await publisher.enqueue(tx, { ...imported(), registerNo: 'УА00000000' } as unknown as DomainEvent);
    expect(JSON.stringify([...tx.rows.values()])).not.toContain('УА00000000');
  });

  it('rejects a transaction handle without an outbox delegate', async () => {
    for (const tx of [undefined, null, {}, { outbox: {} }, 'tx', { outbox: { create: () => undefined } }]) {
      await expect(publisher.enqueue(tx, imported())).rejects.toThrow(TypeError);
    }
  });

  it('propagates database failures so the surrounding business transaction rolls back', async () => {
    const tx = new FakeOutboxTx();
    tx.failWith = new Error('connection terminated');
    await expect(publisher.enqueue(tx, imported())).rejects.toThrow('connection terminated');
  });
});

describe('InMemoryEventPublisher (immediate mode)', () => {
  it('records valid events, validates, and ignores duplicate eventIds like the outbox PK', async () => {
    const p = new InMemoryEventPublisher();
    await p.enqueue({ inMemoryTransaction: true }, imported());
    await p.enqueue(undefined, imported({ eventId: U2, status: 'FAILED', rows: 0 }));
    await p.enqueue(undefined, imported()); // давхар
    expect(p.events.map((e) => e.eventId)).toEqual([U1, U2]);
    expect(p.eventsOfType('StatementImported')).toHaveLength(2);
    expect(p.eventsOfType('ScoringCompleted')).toHaveLength(0);
    await expect(p.enqueue(undefined, imported({ eventId: 'nope' }))).rejects.toBeInstanceOf(InvalidDomainEventError);
    expect(p.events).toHaveLength(2);
  });

  it('clear() resets events and dedupe memory', async () => {
    const p = new InMemoryEventPublisher();
    await p.enqueue(undefined, imported());
    p.clear();
    expect(p.events).toHaveLength(0);
    await p.enqueue(undefined, imported());
    expect(p.events).toHaveLength(1);
  });

  it('returned snapshots cannot be used to mutate internal state', async () => {
    const p = new InMemoryEventPublisher();
    await p.enqueue(undefined, imported());
    (p.events as DomainEvent[]).length = 0;
    expect(p.events).toHaveLength(1);
  });
});

describe('InMemoryEventPublisher: transactions', () => {
  it('begin(): events are invisible until commit and vanish on rollback', async () => {
    const p = new InMemoryEventPublisher();
    const tx1 = p.begin();
    const tx2 = p.begin();
    await p.enqueue(tx1, imported());
    await p.enqueue(tx2, imported({ eventId: U2 }));
    expect(p.events).toHaveLength(0);
    expect(tx1.pending).toHaveLength(1);
    tx1.commit();
    tx2.rollback();
    expect(p.events.map((e) => e.eventId)).toEqual([U1]);
    expect(tx2.pending).toHaveLength(0);
  });

  it('a closed transaction rejects further use; rollback is idempotent; double commit throws', async () => {
    const p = new InMemoryEventPublisher();
    const tx = p.begin();
    await p.enqueue(tx, imported());
    tx.commit();
    expect(() => tx.commit()).toThrow(/committed/);
    await expect(p.enqueue(tx, imported({ eventId: U2 }))).rejects.toThrow(/committed/);
    const rolled = p.begin();
    rolled.rollback();
    expect(() => rolled.rollback()).not.toThrow();
    await expect(p.enqueue(rolled, imported())).rejects.toThrow(/rolledBack/);
    expect(p.events).toHaveLength(1);
  });

  it('runInTransaction commits on success and rolls back (rethrowing) on failure', async () => {
    const p = new InMemoryEventPublisher();
    await expect(
      p.runInTransaction(async (tx) => {
        await p.enqueue(tx, imported());
        throw new Error('business rule violated');
      }),
    ).rejects.toThrow('business rule violated');
    expect(p.events).toHaveLength(0);
    await expect(p.runInTransaction(async (tx) => { await p.enqueue(tx, imported()); return 'ok'; })).resolves.toBe('ok');
    expect(p.events).toHaveLength(1);
  });

  it('a validation failure inside a transaction rolls the whole thing back', async () => {
    const p = new InMemoryEventPublisher();
    await expect(
      p.runInTransaction(async (tx) => {
        await p.enqueue(tx, imported());
        await p.enqueue(tx, imported({ eventId: 'bad' }));
      }),
    ).rejects.toBeInstanceOf(InvalidDomainEventError);
    expect(p.events).toHaveLength(0);
  });

  it('buffered mode: foreign tx tokens (e.g. InMemoryBsaRepository) buffer until commit()/rollback()', async () => {
    const p = new InMemoryEventPublisher({ buffered: true });
    const token = Object.freeze({ inMemoryTransaction: true });
    await p.enqueue(token, imported());
    expect(p.events).toHaveLength(0);
    expect(p.pending).toHaveLength(1);
    p.rollback();
    expect(p.pending).toHaveLength(0);
    await p.enqueue(token, imported());
    p.commit();
    expect(p.events).toHaveLength(1);
    expect(p.pending).toHaveLength(0);
  });

  it('buffered mode scope(): simulates a repository transaction rolling back or committing', async () => {
    const p = new InMemoryEventPublisher({ buffered: true });
    const fakeRepoTx = async (fn: (tx: unknown) => Promise<void>) => fn(Object.freeze({ inMemoryTransaction: true }));
    await expect(
      p.scope(() => fakeRepoTx(async (tx) => {
        await p.enqueue(tx, imported());
        throw new Error('db down');
      })),
    ).rejects.toThrow('db down');
    expect(p.events).toHaveLength(0);
    expect(p.pending).toHaveLength(0);
    await p.scope(() => fakeRepoTx(async (tx) => p.enqueue(tx, imported())));
    expect(p.events).toHaveLength(1);
  });
});

describe('buildStatementImportedEvent', () => {
  const deps = { uuid: () => U1, now: () => NOW };

  it('builds a schema-valid StatementImported from injected uuid/clock', () => {
    const e = buildStatementImportedEvent({ analysisId: 'an-1', applicationId: 'app-1', rows: 2483, status: 'COMPLETED', ctx }, deps);
    expect(e).toEqual({
      eventId: U1, type: 'StatementImported', version: 1, occurredAt: '2026-10-28T03:04:05.678Z', orgId: 'org-1', actorId: 'user-7',
      correlationId: 'corr-1', analysisId: 'an-1', applicationId: 'app-1', rows: 2483, status: 'COMPLETED',
    });
    expect(StatementImported.parse(e)).toEqual(e);
    expect(DomainEvent.parse(e)).toEqual(e);
  });

  it('accepts a RequestContext directly and a system context without userId (actorId = null); FAILED with 0 rows', () => {
    const request: RequestContext = { orgId: 'o', userId: 'u1', roles: ['OFFICER'], branchId: 'b', correlationId: 'c' };
    const input = { analysisId: 'a', applicationId: 'p' } as const;
    expect(buildStatementImportedEvent({ ...input, rows: 0, status: 'FAILED', ctx: request }, deps)).toMatchObject({ actorId: 'u1', status: 'FAILED', rows: 0 });
    const system = { orgId: 'o', correlationId: 'c' };
    expect(buildStatementImportedEvent({ ...input, rows: 1, status: 'COMPLETED', ctx: system }, deps).actorId).toBeNull();
    expect(buildStatementImportedEvent({ ...input, rows: 1, status: 'COMPLETED', ctx: { ...system, userId: null } }, deps).actorId).toBeNull();
  });

  it('defaults to a real random uuid and the wall clock (unique per call)', () => {
    const input = { analysisId: 'a', applicationId: 'p', rows: 1, status: 'COMPLETED', ctx } as const;
    const a = buildStatementImportedEvent(input);
    const b = buildStatementImportedEvent(input);
    expect(a.eventId).not.toBe(b.eventId);
    expect(a.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Number.isNaN(Date.parse(a.occurredAt))).toBe(false);
  });

  it.each([
    ['negative rows', { rows: -1 }],
    ['fractional rows', { rows: 1.5 }],
    ['NaN rows', { rows: Number.NaN }],
    ['Infinity rows', { rows: Number.POSITIVE_INFINITY }],
    ['empty analysisId', { analysisId: '' }],
    ['empty applicationId', { applicationId: '' }],
    ['unknown status', { status: 'PENDING' }],
  ])('rejects %s', (_n, over) => {
    const input = { analysisId: 'a', applicationId: 'p', rows: 1, status: 'COMPLETED', ctx, ...over } as Parameters<typeof buildStatementImportedEvent>[0];
    expect(() => buildStatementImportedEvent(input, deps)).toThrow(InvalidDomainEventError);
  });

  it('rejects a context that makes the event invalid, and a broken uuid generator', () => {
    const base = { analysisId: 'a', applicationId: 'p', rows: 1, status: 'COMPLETED' } as const;
    const noOrg = { orgId: undefined as unknown as string, correlationId: 'c' };
    expect(() => buildStatementImportedEvent({ ...base, ctx: noOrg }, deps)).toThrow(InvalidDomainEventError);
    expect(() => buildStatementImportedEvent({ ...base, ctx }, { ...deps, uuid: () => 'not-a-uuid' })).toThrow(InvalidDomainEventError);
  });

  it('the built event is accepted by both publishers', async () => {
    const e = buildStatementImportedEvent({ analysisId: 'a', applicationId: 'p', rows: 3, status: 'COMPLETED', ctx }, deps);
    const tx = new FakeOutboxTx();
    await new PrismaEventPublisher().enqueue(tx, e);
    const mem = new InMemoryEventPublisher();
    await mem.enqueue(undefined, e);
    expect(tx.rows.get(U1)?.payload).toEqual(mem.events[0]);
  });
});
