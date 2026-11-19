import { HttpStatus, Logger, ServiceUnavailableException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAuditQueue, type AuditFallbackQueue, type AuditRow } from './audit-fallback-queue';
import { AuditService, type AuditRecord } from './audit.service';

// M10: gateway аудит fire-and-forget биш — bounded retry → durable fallback queue → (critical) fail closed 503.
const rec = (over: Partial<AuditRecord> = {}): AuditRecord => ({ orgId: 'org-1', entity: 'USER', entityId: 'u-1', action: 'LOGIN_SUCCESS', actorId: 'u-1', correlationId: 'c-1', ...over });
const dupError = () => Object.assign(new Error('Unique constraint failed on the fields: (`id`)'), { code: 'P2002' });

function fakePrisma(plan: Array<'ok' | 'fail' | 'dup'> = []) {
  const rows: Record<string, unknown>[] = [];
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    const step = plan.shift() ?? 'ok';
    if (step === 'fail') throw new Error('Connection terminated unexpectedly');
    if (step === 'dup') { rows.push(data); throw dupError(); }
    rows.push(data);
    return data;
  });
  const createMany = vi.fn(async ({ data }: { data: Record<string, unknown>[] }) => {
    if (plan[0] === 'fail') { plan.shift(); throw new Error('db down'); }
    const fresh = data.filter((d) => !rows.some((r) => r.id === d.id));
    rows.push(...fresh);
    return { count: fresh.length };
  });
  return { rows, create, createMany, prisma: { auditLog: { create, createMany } } };
}

const failingQueue = (): AuditFallbackQueue => ({
  push: vi.fn(async () => { throw new Error('redis down'); }),
  peek: vi.fn(async () => []), drop: vi.fn(async () => undefined), size: vi.fn(async () => 0), withLock: vi.fn(async () => null),
});

const make = (prisma: unknown, queue: AuditFallbackQueue = new MemoryAuditQueue()) =>
  new AuditService(prisma as never, queue, { attempts: 3, backoffMs: [0, 0], sleep: async () => undefined });

describe('AuditService durability (M10)', () => {
  let errors: string[];
  beforeEach(() => {
    errors = [];
    vi.spyOn(Logger.prototype, 'error').mockImplementation((m: unknown) => { errors.push(String(m)); });
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => { vi.restoreAllMocks(); });

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
    const ids = f.create.mock.calls.map((c) => c[0].data.id);
    expect(new Set(ids).size).toBe(1);
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
    expect((await queue.peek(1))[0]).toMatchObject({ action: 'LOGIN_SUCCESS', entityId: 'u-1' });
    expect(svc.metrics()).toMatchObject({ written: 0, queued: 1, lost: 0 });
    expect(errors.some((e) => e.includes('AUDIT_QUEUED'))).toBe(true);
  });

  it('drains the fallback queue into the database later (idempotent by id) and empties it', async () => {
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

  it('keeps queued rows when the database is still down during a drain', async () => {
    const f = fakePrisma(['fail', 'fail', 'fail', 'fail']);
    const queue = new MemoryAuditQueue();
    const svc = make(f.prisma, queue);
    await svc.record(rec());
    await expect(svc.drainFallback()).resolves.toBe(0);
    expect(await queue.size()).toBe(1);
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
    const svc = make(f.prisma, queue);
    svc.recordSafe(rec({ entity: 'HTTP', action: 'HTTP_POST' }));
    await vi.waitFor(async () => expect(await queue.size()).toBe(1));
  });

  it('redacts secret-like keys from payloads (no PII / secrets in audit rows)', async () => {
    const f = fakePrisma();
    const svc = make(f.prisma);
    await svc.record(rec({ afterJson: { password: 'x', refreshToken: 'y', registerNo: 'УБ99112233', accountNo: '5000123', status: 200 } }));
    expect(f.rows[0]!.afterJson).toEqual({ password: '[redacted]', refreshToken: '[redacted]', registerNo: '[redacted]', accountNo: '[redacted]', status: 200 });
  });

  it('truncates the user agent', async () => {
    const f = fakePrisma();
    await make(f.prisma).record(rec({ userAgent: 'a'.repeat(1000) }));
    expect((f.rows[0]!.userAgent as string).length).toBe(300);
  });

  it('queued rows survive JSON round-trip (Date → ISO → Date)', async () => {
    const queue = new MemoryAuditQueue();
    const row: AuditRow = { id: '00000000-0000-4000-8000-000000000001', orgId: null, entity: 'E', entityId: 'x', action: 'A', actorId: null, at: new Date('2026-11-19T00:00:00.123Z'), beforeJson: null, afterJson: { a: 1 }, applicationId: null, correlationId: null, ip: null, userAgent: null };
    await queue.push(row);
    const [back] = await queue.peek(1);
    expect(back).toEqual(row);
  });
});
