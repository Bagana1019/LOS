import { HttpStatus, Logger, ServiceUnavailableException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAuditQueue, type AuditFallbackQueue, type AuditRow } from './audit-fallback-queue';
import { AuditService, type AuditRecord } from './audit.service';

// M10: gateway аудит fire-and-forget биш — bounded retry → durable fallback queue → (critical) fail closed 503.
const rec = (over: Partial<AuditRecord> = {}): AuditRecord => ({ orgId: 'org-1', entity: 'USER', entityId: 'u-1', action: 'LOGIN_SUCCESS', actorId: 'u-1', correlationId: 'c-1', ...over });
const known = (code: string, message = `prisma ${code}`) => Object.assign(new Error(message), { name: 'PrismaClientKnownRequestError', code });
const transient = () => new Error('Connection terminated unexpectedly');

type Row = Record<string, unknown>;
/** Fake iam.audit_log: id нь PK (skipDuplicates), `bad` гэсэн action-тай мөр байнгын алдаа (P2000) өгнө. */
function fakePrisma(plan: Array<'ok' | 'fail' | 'dup'> = []) {
  const rows: Row[] = [];
  const many: Array<'fail' | ((data: Row[]) => Promise<void>)> = [];
  const create = vi.fn(async ({ data }: { data: Row }) => {
    const step = plan.shift() ?? 'ok';
    if (step === 'fail') throw transient();
    if (data.action === 'BAD') throw known('P2000', 'value too long for column "entity_id": SECRET-VALUE');
    if (step === 'dup' || rows.some((r) => r.id === data.id)) { if (!rows.some((r) => r.id === data.id)) rows.push(data); throw known('P2002'); }
    rows.push(data);
    return data;
  });
  const createMany = vi.fn(async ({ data }: { data: Row[] }) => {
    const step = many.shift();
    if (step === 'fail') throw transient();
    if (typeof step === 'function') await step(data);
    if (data.some((d) => d.action === 'BAD')) throw known('P2000', 'value too long: SECRET-VALUE');
    const fresh = data.filter((d) => !rows.some((r) => r.id === d.id));
    rows.push(...fresh);
    return { count: fresh.length };
  });
  return { rows, many, create, createMany, prisma: { auditLog: { create, createMany } } };
}

const failingQueue = (): AuditFallbackQueue => Object.assign(new MemoryAuditQueue(), { push: vi.fn(async () => { throw new Error('redis down'); }) });

const make = (prisma: unknown, queue: AuditFallbackQueue = new MemoryAuditQueue()) =>
  new AuditService(prisma as never, queue, { attempts: 3, backoffMs: [0, 0], sleep: async () => undefined, drainIntervalMs: 0 });

let seq = 0;
const row = (action = 'LOGIN_SUCCESS'): AuditRow => ({
  id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`, orgId: 'org-1', entity: 'USER', entityId: 'u-1', action, actorId: null,
  at: new Date('2026-11-19T00:00:00.000Z'), beforeJson: null, afterJson: null, applicationId: null, correlationId: null, ip: null, userAgent: null,
});
const ids = (rows: Row[]) => rows.map((r) => r.id as string);

describe('AuditService durability (M10)', () => {
  let errors: string[];
  beforeEach(() => {
    errors = [];
    vi.spyOn(Logger.prototype, 'error').mockImplementation((m: unknown) => { errors.push(String(m)); });
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  describe('write path', () => {
    it('writes once with a client-generated id so a retry is idempotent', async () => {
      const f = fakePrisma();
      const svc = make(f.prisma);
      await svc.record(rec());
      expect(f.create).toHaveBeenCalledTimes(1);
      expect(f.rows[0]).toMatchObject({ entity: 'USER', action: 'LOGIN_SUCCESS', actorId: 'u-1' });
      expect(f.rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(f.rows[0]!.at).toBeInstanceOf(Date);
      expect(svc.metrics()).toMatchObject({ written: 1, retried: 0, queued: 0, lost: 0 });
    });

    it('retries a transient failure with the SAME id and does not lose the record', async () => {
      const f = fakePrisma(['fail', 'fail']);
      const svc = make(f.prisma);
      await svc.record(rec());
      expect(f.create).toHaveBeenCalledTimes(3);
      expect(new Set(f.create.mock.calls.map((c) => c[0].data.id)).size).toBe(1);
      expect(f.rows).toHaveLength(1);
      expect(svc.metrics()).toMatchObject({ written: 1, retried: 2, queued: 0 });
    });

    it('treats a duplicate-id error on retry as already written (ambiguous commit)', async () => {
      const f = fakePrisma(['fail', 'dup']);
      const svc = make(f.prisma);
      await expect(svc.record(rec())).resolves.toBeUndefined();
      expect(f.rows).toHaveLength(1);
      expect(svc.metrics()).toMatchObject({ written: 1, queued: 0, lost: 0 });
    });

    it('after the bounded retries it parks the row in the durable fallback queue and logs loudly', async () => {
      const f = fakePrisma(['fail', 'fail', 'fail']);
      const queue = new MemoryAuditQueue();
      const svc = make(f.prisma, queue);
      await expect(svc.record(rec())).resolves.toBeUndefined();
      expect(await queue.size()).toBe(1);
      expect((await queue.peek(1))[0]!.row).toMatchObject({ action: 'LOGIN_SUCCESS', entityId: 'u-1' });
      expect(svc.metrics()).toMatchObject({ written: 0, queued: 1, lost: 0 });
      expect(errors.some((e) => e.includes('AUDIT_QUEUED'))).toBe(true);
    });

    it('fails CLOSED (503) for a critical record when neither the DB nor the fallback queue can persist it', async () => {
      const f = fakePrisma(['fail', 'fail', 'fail']);
      const svc = make(f.prisma, failingQueue());
      const err = await svc.record(rec()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect((err as ServiceUnavailableException).getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect((err as ServiceUnavailableException).getResponse()).toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
      expect(svc.metrics()).toMatchObject({ lost: 1 });
      expect(errors.some((e) => e.includes('AUDIT_LOST'))).toBe(true);
    });

    it('recordSafe (non-critical HTTP trail) never throws but counts and logs a lost record', async () => {
      const f = fakePrisma(['fail', 'fail', 'fail']);
      const svc = make(f.prisma, failingQueue());
      expect(() => svc.recordSafe(rec({ entity: 'HTTP', action: 'HTTP_POST' }))).not.toThrow();
      await vi.waitFor(() => expect(svc.metrics().lost).toBe(1));
      expect(errors.some((e) => e.includes('AUDIT_LOST'))).toBe(true);
    });

    it('recordSafe also retries and queues instead of dropping', async () => {
      const f = fakePrisma(['fail', 'fail', 'fail']);
      const queue = new MemoryAuditQueue();
      make(f.prisma, queue).recordSafe(rec({ entity: 'HTTP', action: 'HTTP_POST' }));
      await vi.waitFor(async () => expect(await queue.size()).toBe(1));
    });

    it('a permanent error is not retried and the row is not queued forever: it goes to the DLQ', async () => {
      const f = fakePrisma();
      const queue = new MemoryAuditQueue();
      const svc = make(f.prisma, queue);
      await expect(svc.record(rec({ action: 'BAD' }))).resolves.toBeUndefined();
      expect(f.create).toHaveBeenCalledTimes(1);
      expect(await queue.size()).toBe(0);
      const [dl] = await queue.deadLetters(10);
      expect(dl).toMatchObject({ errorClass: 'P2000' });
      expect(JSON.stringify(dl)).not.toContain('SECRET-VALUE');
      expect(svc.metrics()).toMatchObject({ deadLettered: 1, lost: 0 });
    });

    it('redacts secret-like keys from payloads (no PII / secrets in audit rows)', async () => {
      const f = fakePrisma();
      await make(f.prisma).record(rec({ afterJson: { password: 'x', refreshToken: 'y', registerNo: 'УБ99112233', accountNo: '5000123', status: 200 } }));
      expect(f.rows[0]!.afterJson).toEqual({ password: '[redacted]', refreshToken: '[redacted]', registerNo: '[redacted]', accountNo: '[redacted]', status: 200 });
    });

    it('bounds every free-form text field and strips NUL so ordinary input cannot create poison rows', async () => {
      const f = fakePrisma();
      const long = 'x'.repeat(10_000);
      await make(f.prisma).record(rec({ entity: long, entityId: `a\u0000b${long}`, action: long, actorId: long, orgId: long, correlationId: long, ip: long, userAgent: long }));
      const r = f.rows[0]!;
      expect((r.entityId as string).startsWith('ab')).toBe(true);
      for (const k of ['entity', 'entityId', 'action', 'actorId', 'orgId', 'correlationId', 'ip', 'userAgent']) expect((r[k] as string).length, k).toBeLessThanOrEqual(512);
      expect((r.userAgent as string).length).toBe(300);
    });
  });

  describe('drain', () => {
    it('drains the fallback queue into the database (idempotent by id) and empties it', async () => {
      const f = fakePrisma(['fail', 'fail', 'fail']);
      const queue = new MemoryAuditQueue();
      const svc = make(f.prisma, queue);
      await svc.record(rec());
      expect(f.rows).toHaveLength(0);
      expect(await svc.drainFallback()).toBe(1);
      expect(f.rows).toHaveLength(1);
      expect(f.rows[0]!.at).toBeInstanceOf(Date);
      expect(await queue.size()).toBe(0);
      expect(await svc.drainFallback()).toBe(0);
      expect(svc.metrics()).toMatchObject({ drained: 1 });
    });

    it('a transient error drops nothing; the next tick retries', async () => {
      const f = fakePrisma();
      const queue = new MemoryAuditQueue();
      await queue.push(row());
      await queue.push(row());
      f.many.push('fail');
      const svc = make(f.prisma, queue);
      expect(await svc.drainFallback()).toBe(0);
      expect(await queue.size()).toBe(2);
      expect(f.rows).toHaveLength(0);
      expect(await svc.drainFallback()).toBe(2);
      expect(await queue.size()).toBe(0);
    });

    it('one permanently bad row does not block the queue: good rows persist, the bad one goes to the DLQ (no payload PII)', async () => {
      const f = fakePrisma();
      const queue = new MemoryAuditQueue();
      const [a, bad, c] = [row(), row('BAD'), row()];
      for (const r of [a, bad, c]) await queue.push(r);
      const svc = make(f.prisma, queue);
      expect(await svc.drainFallback()).toBe(2);
      expect(ids(f.rows).sort()).toEqual([a.id, c.id].sort());
      expect(await queue.size()).toBe(0);
      const dlq = await queue.deadLetters(10);
      expect(dlq).toHaveLength(1);
      expect(dlq[0]).toMatchObject({ id: bad.id, errorClass: 'P2000' });
      expect(JSON.stringify(dlq[0])).not.toContain('SECRET-VALUE');
      expect(svc.metrics()).toMatchObject({ deadLettered: 1 });
      expect(errors.some((e) => e.includes('AUDIT_DLQ'))).toBe(true);
    });

    it('a transient error during the row-by-row fallback removes only the rows already persisted', async () => {
      const f = fakePrisma();
      const queue = new MemoryAuditQueue();
      const [a, bad, c] = [row(), row('BAD'), row()];
      for (const r of [a, bad, c]) await queue.push(r);
      let n = 0;
      const real = f.create.getMockImplementation()!;
      f.create.mockImplementation(async (args) => { if (++n === 3) throw transient(); return real(args); });
      const svc = make(f.prisma, queue);
      await svc.drainFallback();
      expect(ids(f.rows)).toEqual([a.id]);
      expect((await queue.peek(10)).map((x) => x.row?.id)).toEqual([c.id]);
      expect(await queue.deadLetters(10)).toHaveLength(1);
    });

    it('an unparseable entry is moved to the DLQ as CORRUPT instead of blocking', async () => {
      const f = fakePrisma();
      const queue = new MemoryAuditQueue();
      await queue.pushRaw('{not json');
      const good = row();
      await queue.push(good);
      expect(await make(f.prisma, queue).drainFallback()).toBe(1);
      expect(ids(f.rows)).toEqual([good.id]);
      expect((await queue.deadLetters(10))[0]).toMatchObject({ errorClass: 'CORRUPT' });
    });

    it('lock expires mid-drain: the second pod drains, the first pod removes nothing it does not own (no loss, no duplicates)', async () => {
      let now = 0;
      const queue = new MemoryAuditQueue({ now: () => now });
      const f = fakePrisma();
      const [r1, r2, r3, r4] = [row(), row(), row(), row()];
      await queue.push(r1);
      await queue.push(r2);
      const podA = new AuditService(f.prisma as never, queue, { attempts: 1, backoffMs: [0], sleep: async () => undefined, drainIntervalMs: 0, lockTtlMs: 30_000 });
      const podB = new AuditService(f.prisma as never, queue, { attempts: 1, backoffMs: [0], sleep: async () => undefined, drainIntervalMs: 0, lockTtlMs: 30_000 });
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      let entered!: () => void;
      const inside = new Promise<void>((r) => { entered = r; });
      f.many.push(async () => { entered(); await gate; }); // pod A's batch insert stalls (slow DB / GC pause)
      const a = podA.drainFallback();
      await inside;
      now += 31_000; // A's lease expired
      await queue.push(r3);
      expect(await podB.drainFallback()).toBe(3); // B takes over: r1, r2, r3
      await queue.push(r4);
      release();
      await a;
      expect(ids(f.rows).sort()).toEqual([r1.id, r2.id, r3.id].sort()); // each exactly once
      expect((await queue.peek(10)).map((x) => x.row?.id)).toEqual([r4.id]); // A did not remove r4
    });
  });
});
