// Бодит PostgreSQL дээрх integration тест — MC-BR-3 (нэг tx), MC-BR-5 (нэг зорилтод нэг PENDING / цуваа илгээлт) болон DB-ийн
// invariant-уудын цорын ганц жинхэнэ нотолгоо (санах ойн store нь зөвхөн дүрмийн unit тестэд). Ажиллуулах:
//   TEST_DATABASE_URL=postgresql://los:los@localhost:5432/los_test pnpm --filter @los/origination test
// (нэр нь `test`-ээр төгссөн DB; test/global-setup.ts `origination` schema-г шинээр үүсгэж migrate + seed хийнэ — docs/00-foundation.md §4)
// Хувьсагч байхгүй бол БҮГД алгасагдана. Тест бүр өвөрмөц org_id-тай (append-only хүснэгтийг TRUNCATE хийх боломжгүй), харин
// ажилладаг origination app-ын ExpirySweeper нь org хамаарахгүй тул тухайн DB дээр `MAKER_CHECKER_SWEEP_SECONDS=0` эсвэл тусдаа DB ашиглана.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '.prisma/client-origination';
import { PrismaService } from '../../prisma.service';
import { ChangeConflictError, ChangeHandlerRegistry, type ApplyContext, type ChangeHandler } from './change-handler';
import { canDecideNow } from './maker-checker.domain';
import { MakerCheckerError } from './maker-checker.errors';
import { MakerCheckerService } from './maker-checker.service';
import { PrismaChangeRequestStore } from './infra/prisma-change-request.store';
import { actor, TestClock } from './testing/fixtures';

const URL = process.env.TEST_DATABASE_URL;
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { if (e instanceof MakerCheckerError) return e.code; throw e; } return 'NO_ERROR'; };

/** Зорилт = origination.outbox-д бичигдэх мөр (бодит tx-ийн хэсэг болохыг харуулна) */
class ProbeHandler implements ChangeHandler<{ mode: 'ok' | 'throw-after-write' | 'stale' }> {
  readonly targetType = 'IT_PROBE';
  readonly action = 'WRITE';
  readonly payloadSchema = z.object({ mode: z.enum(['ok', 'throw-after-write', 'stale']) });
  readonly makerRoles = ['OFFICER'] as const;
  readonly defaultPolicy = { enabled: true, checkerRoles: ['BRANCH_MANAGER', 'APPROVER'], expiresInHours: 1 } as const;
  async apply({ db, request, payload }: ApplyContext<{ mode: string }>) {
    const tx = db as PrismaClient;
    await tx.outbox.create({ data: { id: randomUUID(), type: 'IT_PROBE_APPLIED', payload: { requestId: request.id } } });
    if (payload.mode === 'throw-after-write') throw new Error('boom');
    if (payload.mode === 'stale') throw new ChangeConflictError();
  }
}

/** Зорилт бүрийн "хувилбар" = IT_GATE_APPLIED outbox мөрийн тоо. apply() нь gate нээгдтэл хүлээнэ (зэрэг батлалтыг хуурамчаар удаашруулна). */
const deferred = () => { let open!: () => void; const wait = new Promise<void>((r) => { open = r; }); return { wait, open }; };
let gate = deferred();
class GateHandler implements ChangeHandler<{ n: number }> {
  readonly targetType = 'IT_GATE';
  readonly action = 'WRITE';
  readonly payloadSchema = z.object({ n: z.number() });
  readonly makerRoles = ['OFFICER'] as const;
  readonly defaultPolicy = { enabled: true, checkerRoles: ['BRANCH_MANAGER', 'APPROVER'], expiresInHours: 1 } as const;
  private version(db: PrismaClient, target: string) { return db.outbox.count({ where: { type: 'IT_GATE_APPLIED', payload: { path: ['target'], equals: target } } }); }
  async snapshot({ db, targetId }: { db: unknown; targetId: string }) { const v = await this.version(db as PrismaClient, targetId); return { before: { v }, baseVersion: String(v) }; }
  async apply({ db, request }: ApplyContext<{ n: number }>) {
    const tx = db as PrismaClient;
    if (request.baseVersion !== null && request.baseVersion !== String(await this.version(tx, request.targetId))) throw new ChangeConflictError();
    await tx.outbox.create({ data: { id: randomUUID(), type: 'IT_GATE_APPLIED', payload: { target: request.targetId } } });
    await gate.wait;
  }
}

/** apply() хэзээ ч нэгэн зэрэг ажиллахгүй эсэхийг хэмжинэ (DIRECT илгээлтүүд цуваа) */
let active = 0;
let maxActive = 0;
class SerialHandler implements ChangeHandler<{ n: number }> {
  readonly targetType = 'IT_SERIAL';
  readonly action = 'WRITE';
  readonly payloadSchema = z.object({ n: z.number() });
  readonly makerRoles = ['OFFICER'] as const;
  readonly defaultPolicy = { enabled: true, checkerRoles: ['APPROVER'], expiresInHours: 1 } as const;
  async apply() {
    active += 1; maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 60));
    active -= 1;
  }
}

describe.skipIf(!URL)('maker-checker on PostgreSQL', () => {
  let prisma: PrismaService;
  let svc: MakerCheckerService;
  let clock: TestClock;
  const org = `it-${randomUUID().slice(0, 8)}`;
  const officer = actor('it-officer', ['OFFICER'], 'B1', org);
  const mgr = (n: number | string, branch = 'B1') => actor(`it-mgr-${n}`, ['BRANCH_MANAGER'], branch, org);
  const probe = (mode = 'ok') => ({ targetType: 'IT_PROBE', action: 'WRITE', targetId: `T-${randomUUID()}`, payload: { mode }, reason: 'integration test' });
  const applied = (id: string) => prisma.outbox.count({ where: { type: 'IT_PROBE_APPLIED', payload: { path: ['requestId'], equals: id } } });
  const events = (id: string) => prisma.outbox.findMany({ where: { payload: { path: ['changeRequestId'], equals: id } }, orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    prisma = new PrismaService({ datasources: { db: { url: URL! } } });
    const registry = new ChangeHandlerRegistry();
    registry.register(new ProbeHandler());
    registry.register(new GateHandler());
    registry.register(new SerialHandler());
    clock = new TestClock();
    svc = new MakerCheckerService(new PrismaChangeRequestStore(prisma), registry, clock);
  }, 30_000);
  afterAll(async () => { await prisma?.$disconnect(); });

  it('persists the whole lifecycle: request, history, outbox events and the applied change', async () => {
    const { request } = await svc.submit(officer, probe());
    expect(request).toMatchObject({ status: 'PENDING', mode: 'FOUR_EYES', makerId: 'it-officer', requiredCheckerRoles: ['BRANCH_MANAGER', 'APPROVER'] });
    expect(await applied(request.id)).toBe(0);

    expect(await code(svc.approve(officer, request.id))).toBe('SELF_APPROVAL_FORBIDDEN');
    const done = await svc.approve(mgr(1), request.id, 'ok');
    expect(done).toMatchObject({ status: 'APPLIED', checkerId: 'it-mgr-1', checkerComment: 'ok' });
    expect(done.history!.map((h) => [h.seq, h.event, h.toStatus])).toEqual([[1, 'SUBMITTED', 'PENDING'], [2, 'APPLIED', 'APPLIED']]);
    expect(await applied(request.id)).toBe(1);
    expect((await events(request.id)).map((e) => e.type)).toEqual(['ChangeRequestSubmitted', 'ChangeRequestDecided']);
    expect(await code(svc.approve(mgr(2), request.id))).toBe('ALREADY_DECIDED');
  });

  it('8 checkers racing → exactly one applies, the rest get 409', async () => {
    const { request } = await svc.submit(officer, probe());
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => svc.approve(mgr(`r${i}`), request.id)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const codes = results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason.code);
    expect(codes).toEqual(Array(7).fill('ALREADY_DECIDED'));
    expect(await applied(request.id)).toBe(1);
    expect((await svc.get(officer, request.id)).history).toHaveLength(2);
  }, 30_000);

  it('approve vs reject racing → one outcome only', async () => {
    const { request } = await svc.submit(officer, probe());
    const [a, r] = await Promise.allSettled([svc.approve(mgr('a'), request.id), svc.reject(mgr('b'), request.id, 'no thanks')]);
    expect([a.status, r.status].filter((s) => s === 'fulfilled')).toHaveLength(1);
    const final = await svc.get(officer, request.id);
    expect(['APPLIED', 'REJECTED']).toContain(final.status);
    expect(await applied(request.id)).toBe(final.status === 'APPLIED' ? 1 : 0);
  }, 30_000);

  it('5 concurrent submits for one target → exactly one PENDING (partial unique index → 409)', async () => {
    const same = probe();
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => svc.submit(actor(`it-o${i}`, ['OFFICER'], 'B1', org), same)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason.code)).toEqual(Array(4).fill('TARGET_HAS_PENDING_CHANGE'));
  }, 30_000);

  it('handler failure rolls the whole approval back (change, status, history, events) and leaves it PENDING', async () => {
    const { request } = await svc.submit(officer, probe('throw-after-write'));
    await expect(svc.approve(mgr(1), request.id)).rejects.toThrow('boom');
    expect(await applied(request.id)).toBe(0);
    const again = await svc.get(officer, request.id);
    expect(again.status).toBe('PENDING');
    expect(again.history).toHaveLength(1);
    expect((await events(request.id)).map((e) => e.type)).toEqual(['ChangeRequestSubmitted']);
  });

  it('stale target → FAILED is committed while the handler writes are rolled back', async () => {
    const { request } = await svc.submit(officer, probe('stale'));
    expect(await code(svc.approve(mgr(1), request.id))).toBe('STALE_TARGET');
    expect(await applied(request.id)).toBe(0);
    const failed = await svc.get(officer, request.id);
    expect(failed).toMatchObject({ status: 'FAILED', checkerId: 'it-mgr-1' });
    expect(failed.failureReason).toBeTruthy();
    expect(failed.history!.map((h) => h.event)).toEqual(['SUBMITTED', 'FAILED']);
    expect((await events(request.id)).map((e) => e.type)).toEqual(['ChangeRequestSubmitted', 'ChangeRequestDecided']);
  });

  it('reject + cancel persist correctly (history and outbox included)', async () => {
    const rej = await svc.submit(officer, probe());
    const rejected = await svc.reject(mgr(1), rej.request.id, 'Дутуу баримт');
    expect(rejected.checkerComment).toBe('Дутуу баримт');
    expect(rejected.history!.map((h) => [h.event, h.fromStatus, h.toStatus, h.actorId, h.comment])).toEqual([
      ['SUBMITTED', null, 'PENDING', 'it-officer', 'integration test'], ['REJECTED', 'PENDING', 'REJECTED', 'it-mgr-1', 'Дутуу баримт'],
    ]);
    const can = await svc.submit(officer, probe());
    const cancelled = await svc.cancel(officer, can.request.id, 'буруу');
    expect(cancelled).toMatchObject({ status: 'CANCELLED', checkerComment: null });
    expect(cancelled.history!.map((h) => [h.event, h.comment])).toEqual([['SUBMITTED', 'integration test'], ['CANCELLED', 'буруу']]);
    const decided = (await events(can.request.id)).find((e) => e.type === 'ChangeRequestDecided');
    expect(decided?.payload).toMatchObject({ outcome: 'CANCELLED', changeRequestId: can.request.id });
  });

  it('expiry sweeps in parallel never double-process; a late approve says EXPIRED even after the sweep', async () => {
    const sweepOrg = `it-sweep-${randomUUID().slice(0, 8)}`;
    const o = actor('sw-officer', ['OFFICER'], 'B1', sweepOrg);
    const pending = await Promise.all(Array.from({ length: 6 }, () => svc.submit(o, probe())));
    clock.advanceHours(2);
    try {
      const swept = await Promise.all([1, 2, 3].map(() => svc.expireOverdue(2, { orgId: sweepOrg })).concat(svc.expireOverdue(100, { orgId: sweepOrg })));
      expect(swept.reduce((a, b) => a + b, 0)).toBe(6);
      for (const p of pending) {
        const r = await svc.get(o, p.request.id);
        expect(r.status).toBe('EXPIRED');
        expect(r.history!.map((h) => h.event)).toEqual(['SUBMITTED', 'EXPIRED']);
        expect((await events(p.request.id)).map((e) => e.type)).toEqual(['ChangeRequestSubmitted', 'ChangeRequestDecided']);
      }
      expect(await code(svc.approve(actor('sw-mgr', ['BRANCH_MANAGER'], 'B1', sweepOrg), pending[0]!.request.id))).toBe('EXPIRED');
      expect(await svc.expireOverdue(100, { orgId: sweepOrg })).toBe(0);
    } finally {
      clock.advanceHours(-2);
    }
  }, 30_000);

  it('a re-submit after the previous request expired (not yet swept) closes it lazily and goes through (MC-BR-6)', async () => {
    const target = probe();
    const first = await svc.submit(officer, target);
    clock.advanceHours(2);
    try {
      const second = await svc.submit(actor('it-officer2', ['OFFICER'], 'B1', org), target);
      expect(second.request.status).toBe('PENDING');
      const old = await svc.get(officer, first.request.id);
      expect(old.status).toBe('EXPIRED');
      expect(old.history!.map((h) => h.event)).toEqual(['SUBMITTED', 'EXPIRED']);
    } finally {
      clock.advanceHours(-2);
    }
  });

  it('a submit racing an in-flight approve waits for it and snapshots the committed state (no spurious STALE_TARGET)', async () => {
    gate = deferred();
    const target = `G-${randomUUID()}`;
    const r1 = await svc.submit(officer, { targetType: 'IT_GATE', action: 'WRITE', targetId: target, payload: { n: 1 }, reason: 'first change' });
    expect(r1.request.baseVersion).toBe('0');
    const approving = svc.approve(mgr('g1'), r1.request.id); // apply() has written and now sits on the gate, uncommitted
    await new Promise((r) => setTimeout(r, 300));
    const submitting = svc.submit(actor('it-officer3', ['OFFICER'], 'B1', org), { targetType: 'IT_GATE', action: 'WRITE', targetId: target, payload: { n: 2 }, reason: 'second change' });
    await new Promise((r) => setTimeout(r, 300));
    gate.open();
    expect((await approving).status).toBe('APPLIED');
    const r2 = (await submitting).request;
    expect(r2.baseVersion).toBe('1'); // would be '0' (stale) if the snapshot were taken before waiting for r1
    expect(r2.before).toEqual({ v: 1 });
    expect((await svc.approve(mgr('g2'), r2.id)).status).toBe('APPLIED');
  }, 30_000);

  it('DIRECT submits are serialized per target and never overtake a pending request', async () => {
    const dOrg = `it-direct-${randomUUID().slice(0, 8)}`;
    const o = (n: number) => actor(`d-officer-${n}`, ['OFFICER'], 'B1', dOrg);
    await prisma.makerCheckerPolicy.create({ data: { orgId: dOrg, targetType: 'IT_SERIAL', action: 'WRITE', enabled: false, checkerRoles: ['APPROVER'], expiresInHours: 1, createdBy: 'it', updatedBy: 'it' } });
    const target = `S-${randomUUID()}`;
    const input = (n: number) => ({ targetType: 'IT_SERIAL', action: 'WRITE', targetId: target, payload: { n }, reason: 'direct change' });
    active = 0; maxActive = 0;
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => svc.submit(o(i), input(i))));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    expect(results.every((r) => r.status === 'fulfilled' && r.value.outcome === 'APPLIED_DIRECT')).toBe(true);
    expect(maxActive).toBe(1);

    // PENDING (while the control was on) must block a DIRECT change made after the control was switched off
    const pOrg = `it-direct2-${randomUUID().slice(0, 8)}`;
    const p = (n: number) => actor(`dp-officer-${n}`, ['OFFICER'], 'B1', pOrg);
    const pending = await svc.submit(p(1), input(1));
    expect(pending.outcome).toBe('PENDING');
    await prisma.makerCheckerPolicy.create({ data: { orgId: pOrg, targetType: 'IT_SERIAL', action: 'WRITE', enabled: false, checkerRoles: ['APPROVER'], expiresInHours: 1, createdBy: 'it', updatedBy: 'it' } });
    expect(await code(svc.submit(p(2), input(2)))).toBe('TARGET_HAS_PENDING_CHANGE');
  }, 30_000);

  it('a lock wait that never ends is cut off with a retryable 409 instead of hanging the pool (lock_timeout)', async () => {
    const { request } = await svc.submit(officer, probe());
    const hold = deferred();
    const holding = prisma.$transaction(async (db) => {
      await db.$queryRawUnsafe(`SELECT id FROM origination.change_request WHERE id = $1::uuid FOR UPDATE`, request.id);
      await hold.wait;
    }, { timeout: 15_000 });
    await new Promise((r) => setTimeout(r, 200));
    process.env.MAKER_CHECKER_LOCK_TIMEOUT_MS = '300';
    const t0 = Date.now();
    try {
      expect(await code(svc.approve(mgr('lt'), request.id))).toBe('DECISION_IN_PROGRESS');
      expect(Date.now() - t0).toBeLessThan(5_000);
    } finally {
      delete process.env.MAKER_CHECKER_LOCK_TIMEOUT_MS;
      hold.open();
      await holding;
    }
    expect((await svc.get(officer, request.id)).status).toBe('PENDING');
    expect((await svc.approve(mgr('lt2'), request.id)).status).toBe('APPLIED');
  }, 30_000);

  it('store filters agree with the domain rules for every actor/request combination (parity)', async () => {
    const pOrg = `it-parity-${randomUUID().slice(0, 6)}`;
    const mk = (id: string, roles: Parameters<typeof actor>[1], branch: string | null) => actor(id, roles, branch, pOrg);
    const makers = [mk('pm1', ['OFFICER'], 'B1'), mk('pm2', ['OFFICER'], 'B2'), mk('pm3', ['OFFICER'], null)];
    for (const m of makers) await svc.submit(m, probe());
    const viewers = [
      mk('v-mgr-b1', ['BRANCH_MANAGER'], 'B1'), mk('v-mgr-b2', ['BRANCH_MANAGER'], 'B2'), mk('v-mgr-nob', ['BRANCH_MANAGER'], null),
      mk('v-appr', ['APPROVER'], null), mk('v-both', ['BRANCH_MANAGER', 'APPROVER'], 'B9'), mk('v-admin', ['ADMIN'], null),
      mk('v-off', ['OFFICER'], 'B1'), mk('pm1', ['BRANCH_MANAGER', 'OFFICER'], 'B1'), mk('v-none', [], null),
    ];
    const store = new PrismaChangeRequestStore(prisma);
    const all = (await store.list(pOrg, { scope: 'all', actor: viewers[5]!, now: clock.now(), page: 1, pageSize: 100 })).rows;
    expect(all).toHaveLength(3);
    for (const v of viewers) {
      const expected = all.filter((r) => canDecideNow(v, r, clock.now())).map((r) => r.id).sort();
      const got = (await store.list(pOrg, { scope: 'inbox', actor: v, now: clock.now(), page: 1, pageSize: 100 })).rows.map((r) => r.id).sort();
      expect(got, `inbox for ${v.userId}/${v.roles}/${v.branchId}`).toEqual(expected);
      expect(await store.count(pOrg, { scope: 'inbox', actor: v, now: clock.now() })).toBe(expected.length);
      const visible = all.filter((r) => r.makerId === v.userId).map((r) => r.id).sort();
      expect((await store.list(pOrg, { scope: 'mine', actor: v, now: clock.now(), page: 1, pageSize: 100 })).rows.map((r) => r.id).sort()).toEqual(visible);
    }
  }, 30_000);

  describe('database-level invariants (raw SQL bypasses the application)', () => {
    let id: string;
    beforeAll(async () => { id = (await svc.submit(officer, probe())).request.id; });
    const run = (sql: string, ...params: unknown[]) => prisma.$executeRawUnsafe(sql, ...params);

    it('maker ≠ checker is enforced by a CHECK constraint (MC-BR-1)', async () => {
      await expect(run(`UPDATE origination.change_request SET checker_id = maker_id, status = 'APPLIED', decided_at = now() WHERE id = $1::uuid`, id)).rejects.toThrow(/change_request_maker_ne_checker/);
    });
    it('a FOUR_EYES request cannot become APPLIED/REJECTED without a checker', async () => {
      await expect(run(`UPDATE origination.change_request SET status = 'APPLIED', decided_at = now() WHERE id = $1::uuid`, id)).rejects.toThrow(/change_request_decided_has_checker/);
    });
    it('a rejection needs a comment (MC-BR-4)', async () => {
      await expect(run(`UPDATE origination.change_request SET status = 'REJECTED', checker_id = 'x', decided_at = now() WHERE id = $1::uuid`, id)).rejects.toThrow(/change_request_reject_comment/);
    });
    it('PENDING rows cannot carry a decision', async () => {
      await expect(run(`UPDATE origination.change_request SET checker_id = 'x' WHERE id = $1::uuid`, id)).rejects.toThrow(/change_request_pending_undecided/);
    });
    it('submitted content is immutable (payload, maker, reason, target, expiry)', async () => {
      for (const set of [`payload = '{"mode":"hacked"}'::jsonb`, `maker_id = 'someone-else'`, `reason = 'rewritten'`, `target_id = 'other'`, `expires_at = now() + interval '1 year'`, `required_checker_roles = ARRAY['OFFICER']`]) {
        await expect(run(`UPDATE origination.change_request SET ${set} WHERE id = $1::uuid`, id), set).rejects.toThrow(/immutable/);
      }
    });
    it('terminal rows cannot be modified or deleted; requests are never deletable', async () => {
      const done = (await svc.submit(officer, probe())).request.id;
      await svc.reject(mgr(1), done, 'closing');
      await expect(run(`UPDATE origination.change_request SET status = 'PENDING', checker_id = NULL, decided_at = NULL, checker_comment = NULL WHERE id = $1::uuid`, done)).rejects.toThrow(/can no longer be modified/);
      await expect(run(`DELETE FROM origination.change_request WHERE id = $1::uuid`, done)).rejects.toThrow(/cannot be deleted/);
      await expect(run(`DELETE FROM origination.change_request WHERE id = $1::uuid`, id)).rejects.toThrow(/cannot be deleted/);
      await expect(run(`TRUNCATE origination.change_request CASCADE`)).rejects.toThrow(/append-only/);
    });
    it('history is append-only (no update, delete, truncate)', async () => {
      await expect(run(`UPDATE origination.change_request_history SET comment = 'edited' WHERE change_request_id = $1::uuid`, id)).rejects.toThrow(/append-only/);
      await expect(run(`DELETE FROM origination.change_request_history WHERE change_request_id = $1::uuid`, id)).rejects.toThrow(/append-only/);
      await expect(run(`TRUNCATE origination.change_request_history`)).rejects.toThrow(/append-only/);
    });
    it('only one PENDING per target even when inserted directly', async () => {
      const row = await prisma.changeRequest.findUniqueOrThrow({ where: { id } });
      await expect(run(
        `INSERT INTO origination.change_request (id, org_id, target_type, target_id, action, payload, reason, maker_id, maker_roles, required_checker_roles, checker_roles, correlation_id, expires_at, created_by, updated_by)
         VALUES (gen_random_uuid(), $1, $2, $3, 'WRITE', '{}'::jsonb, 'dup dup', 'm2', '{}', ARRAY['APPROVER'], '{}', 'c', now() + interval '1 day', 'm2', 'm2')`, row.orgId, row.targetType, row.targetId,
      )).rejects.toThrow(/23505/);
    });
    it('DIRECT rows must be APPLIED with no checker; policies need valid roles/TTL', async () => {
      await expect(run(
        `INSERT INTO origination.change_request (id, org_id, target_type, target_id, action, mode, status, checker_id, payload, reason, maker_id, maker_roles, required_checker_roles, checker_roles, correlation_id, expires_at, created_by, updated_by)
         VALUES (gen_random_uuid(), 'o', 'T', 'x', 'A', 'DIRECT', 'APPLIED', 'someone', '{}'::jsonb, 'direct!', 'm', '{}', '{}', '{}', 'c', now(), 'm', 'm')`,
      )).rejects.toThrow(/change_request_direct_no_checker/);
      await expect(run(`INSERT INTO origination.maker_checker_policy (id, org_id, target_type, action, checker_roles, expires_in_hours, created_by, updated_by) VALUES (gen_random_uuid(), 'o', 'T', 'A', '{}', 5, 'u', 'u')`)).rejects.toThrow(/maker_checker_policy_roles/);
      await expect(run(`INSERT INTO origination.maker_checker_policy (id, org_id, target_type, action, checker_roles, expires_in_hours, created_by, updated_by) VALUES (gen_random_uuid(), 'o', 'T', 'A', ARRAY['GOD'], 5, 'u', 'u')`)).rejects.toThrow(/maker_checker_policy_roles/);
      await expect(run(`INSERT INTO origination.maker_checker_policy (id, org_id, target_type, action, checker_roles, expires_in_hours, created_by, updated_by) VALUES (gen_random_uuid(), 'o', 'T', 'A', ARRAY['ADMIN'], 0, 'u', 'u')`)).rejects.toThrow(/maker_checker_policy_ttl/);
    });
    it('role arrays are NOT NULL, so NULL cannot slip past the roles CHECKs', async () => {
      await expect(run(`INSERT INTO origination.maker_checker_policy (id, org_id, target_type, action, checker_roles, expires_in_hours, created_by, updated_by) VALUES (gen_random_uuid(), 'o', 'T', 'A', NULL, 5, 'u', 'u')`)).rejects.toThrow(/23502|null value/i);
      await expect(run(
        `INSERT INTO origination.change_request (id, org_id, target_type, target_id, action, payload, reason, maker_id, maker_roles, required_checker_roles, checker_roles, correlation_id, expires_at, created_by, updated_by)
         VALUES (gen_random_uuid(), 'o', 'T', 'x2', 'A', '{}'::jsonb, 'nulls!', 'm', '{}', NULL, '{}', 'c', now() + interval '1 day', 'm', 'm')`,
      )).rejects.toThrow(/23502|null value/i);
    });
  });
});
