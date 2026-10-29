import { describe, expect, it } from 'vitest';
import { ChangeConflictError } from './change-handler';
import { LockTimeoutError } from './change-request.store';
import { MakerCheckerError } from './maker-checker.errors';
import {
  actor, adminA, adminB, approver, build, managerB1, managerB2, NoteUpdateHandler, officerA, officerB, submitInput,
} from './testing/fixtures';
import type { FakeDb } from './testing/in-memory.store';

const code = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { if (e instanceof MakerCheckerError) return e.code; throw e; }
  return 'NO_ERROR';
};
const notes = (db: FakeDb) => db.records as Record<string, { name: string; version: number }>;

describe('submit (MC-FR-1)', () => {
  it('creates a PENDING request and does NOT touch the target until approved (MC-BR-3)', async () => {
    const { svc, store, handler } = build();
    const r = await svc.submit(officerA, submitInput());
    expect(r.outcome).toBe('PENDING');
    expect(r.request).toMatchObject({ status: 'PENDING', mode: 'FOUR_EYES', makerId: 'officerA', targetId: 'REG1', requiredCheckerRoles: ['BRANCH_MANAGER', 'APPROVER'] });
    expect(handler.applied).toBe(0);
    expect(notes(store.db).REG1).toBeUndefined();
    expect(r.request.canCancel).toBe(true);
    expect(r.request.canDecide).toBe(false); // maker
  });

  it('writes SUBMITTED history and a ChangeRequestSubmitted outbox event in the same transaction (MC-BR-9)', async () => {
    const { svc, store } = build();
    const { request } = await svc.submit(officerA, submitInput({ applicationId: 'APP-1' }));
    expect(request.history).toEqual([expect.objectContaining({ seq: 1, event: 'SUBMITTED', fromStatus: null, toStatus: 'PENDING', actorId: 'officerA', comment: 'Харилцагчийн хүсэлтээр засав' })]);
    expect(store.outbox).toEqual([expect.objectContaining({ type: 'ChangeRequestSubmitted', changeRequestId: request.id, makerId: 'officerA', applicationId: 'APP-1', orgId: 'org1', correlationId: 'corr-officerA' })]);
  });

  it('captures the target snapshot and baseVersion for diff + stale detection (MC-BR-7)', async () => {
    const { svc, store } = build();
    notes(store.db).REG1 = { name: 'Old', version: 4 };
    const { request } = await svc.submit(officerA, submitInput());
    expect(request.before).toEqual({ name: 'Old' });
    expect(request.baseVersion).toBe('4');
  });

  it('lets the maker pin an explicit baseVersion (what they saw in the UI)', async () => {
    const { svc } = build();
    const { request } = await svc.submit(officerA, submitInput({ baseVersion: '9' }));
    expect(request.baseVersion).toBe('9');
  });

  it('rejects unknown targetType/action with the supported list', async () => {
    const { svc } = build();
    await expect(svc.submit(officerA, { ...submitInput(), targetType: 'NOPE' })).rejects.toMatchObject({ code: 'HANDLER_NOT_FOUND', status: 422 });
  });

  it('enforces the handler makerRoles', async () => {
    const { svc } = build();
    expect(await code(svc.submit(approver, submitInput()))).toBe('MAKER_ROLE_FORBIDDEN');
    expect(await code(svc.submit(actor('nobody', []), submitInput()))).toBe('MAKER_ROLE_FORBIDDEN');
  });

  it('validates the payload with the handler schema and the business validate hook', async () => {
    const { svc, store } = build();
    expect(await code(svc.submit(officerA, { ...submitInput(), payload: { name: '' } }))).toBe('PAYLOAD_INVALID');
    expect(await code(svc.submit(officerA, submitInput({ name: 'forbidden' })))).toBe('PAYLOAD_INVALID');
    expect(store.rows()).toHaveLength(0);
  });

  it('enforces the input contract itself, not only the HTTP layer (MC-BR-4): plug-in callers get VALIDATION_FAILED', async () => {
    const { svc, store } = build();
    for (const bad of [{ reason: 'a' }, { reason: '   ' }, { reason: '😀😀' }, { reason: 'ab\u0000c' }, { baseVersion: '' }, { targetId: ' ' }, { payload: { name: 'a\u0000b' } }]) {
      expect(await code(svc.submit(officerA, { ...submitInput(), ...bad } as never)), JSON.stringify(bad)).toBe('VALIDATION_FAILED');
    }
    expect(store.rows()).toHaveLength(0);
  });

  it('only a ChangeValidationError from validate() becomes 422; any other failure is not disguised (and never echoed to the maker)', async () => {
    const { svc, handler, store } = build();
    const original = handler.validate.bind(handler);
    const throwing = (e: Error) => { handler.validate = () => { throw e; }; };
    throwing(Object.assign(new Error('connection to 10.0.0.5:5432 refused; row {"register":"УА90010203"}'), { code: 'P1001' }));
    const failure = await svc.submit(officerA, submitInput()).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(MakerCheckerError); // the filter turns it into a logged generic 500
    handler.validate = original;
    expect(await code(svc.submit(officerA, submitInput({ name: 'forbidden' })))).toBe('PAYLOAD_INVALID');
    expect(store.rows()).toHaveLength(0);
  });

  it('a stale-target error from validate() is a 409, not a 422', async () => {
    const { svc, handler } = build();
    handler.validate = () => { throw new ChangeConflictError(); };
    expect(await code(svc.submit(officerA, submitInput()))).toBe('STALE_TARGET');
  });

  it('a branchless request (maker without X-Branch-Id) is not open to branch managers', async () => {
    const { svc } = build();
    const { request } = await svc.submit(actor('hq-officer', ['OFFICER'], null), submitInput());
    expect(request.branchId).toBeNull();
    expect(await code(svc.get(managerB1, request.id))).toBe('NOT_FOUND');
    expect(await code(svc.approve(managerB1, request.id))).toBe('NOT_FOUND');
    expect((await svc.list(managerB1, { scope: 'inbox', page: 1, pageSize: 20 })).total).toBe(0);
    expect((await svc.approve(approver, request.id)).status).toBe('APPLIED');
  });

  it('allows only one PENDING request per target (MC-BR-5), but a new one once the first is closed', async () => {
    const { svc } = build();
    const first = await svc.submit(officerA, submitInput());
    expect(await code(svc.submit(officerB, submitInput({ name: 'Other' })))).toBe('TARGET_HAS_PENDING_CHANGE');
    await svc.cancel(officerA, first.request.id);
    expect((await svc.submit(officerB, submitInput({ name: 'Other' }))).outcome).toBe('PENDING');
  });

  it('allows concurrent pending requests for different targets', async () => {
    const { svc } = build();
    await svc.submit(officerA, submitInput({ targetId: 'REG1' }));
    await expect(svc.submit(officerA, submitInput({ targetId: 'REG2' }))).resolves.toMatchObject({ outcome: 'PENDING' });
  });

  it('sets the branch from the actor and the expiry from policy TTL (MC-BR-6)', async () => {
    const { svc, clock } = build();
    const { request } = await svc.submit(officerA, submitInput());
    expect(request.branchId).toBe('B1');
    expect(request.expiresAt).toBe(new Date(clock.now().getTime() + 24 * 3_600_000).toISOString());
  });

  it('isolates organisations: other org cannot see or decide the request', async () => {
    const { svc } = build();
    const { request } = await svc.submit(officerA, submitInput());
    const foreign = actor('managerX', ['BRANCH_MANAGER'], 'B1', 'org2');
    expect(await code(svc.get(foreign, request.id))).toBe('NOT_FOUND');
    expect(await code(svc.approve(foreign, request.id))).toBe('NOT_FOUND');
  });
});

describe('approve (MC-FR-3)', () => {
  it('applies the change atomically when a different eligible checker approves', async () => {
    const { svc, store, handler } = build();
    const { request } = await svc.submit(officerA, submitInput());
    const done = await svc.approve(managerB1, request.id, 'Баримтыг шалгав');
    expect(done).toMatchObject({ status: 'APPLIED', checkerId: 'managerB1', checkerRoles: ['BRANCH_MANAGER'], checkerComment: 'Баримтыг шалгав', canDecide: false });
    expect(done.decidedAt).not.toBeNull();
    expect(handler.applied).toBe(1);
    expect(notes(store.db).REG1).toEqual({ name: 'New name', version: 1 });
    expect(done.history!.map((h) => h.event)).toEqual(['SUBMITTED', 'APPLIED']);
    expect(done.history![1]).toMatchObject({ seq: 2, fromStatus: 'PENDING', toStatus: 'APPLIED', actorId: 'managerB1' });
    expect(store.outbox.map((e) => e.type)).toEqual(['ChangeRequestSubmitted', 'ChangeRequestDecided']);
    expect(store.outbox[1]).toMatchObject({ outcome: 'APPLIED', checkerId: 'managerB1', actorId: 'managerB1' });
  });

  it('MC-BR-1: the maker can never approve their own request — whatever their role', async () => {
    const { svc, handler } = build();
    const { request } = await svc.submit(managerB1, submitInput()); // BRANCH_MANAGER is both maker and an allowed checker role
    expect(await code(svc.approve(managerB1, request.id))).toBe('SELF_APPROVAL_FORBIDDEN');
    expect(await code(svc.reject(managerB1, request.id, 'өөрөө татгалзах'))).toBe('SELF_APPROVAL_FORBIDDEN');
    expect(handler.applied).toBe(0);
    expect((await svc.get(managerB1, request.id)).status).toBe('PENDING');
  });

  it('MC-BR-1: ADMIN cannot approve own request either', async () => {
    const { svc } = build();
    const { request } = await svc.submitPolicyChange(adminA, { targetType: 'BLACKLIST_ENTRY', action: 'UPDATE', enabled: true, checkerRoles: ['ADMIN'], expiresInHours: 5 }, 'өөрчлөх');
    expect(await code(svc.approve(adminA, request.id))).toBe('SELF_APPROVAL_FORBIDDEN');
  });

  it('MC-BR-2: a checker must hold one of the policy checkerRoles', async () => {
    const { svc } = build();
    const { request } = await svc.submit(officerA, submitInput());
    expect(await code(svc.approve(officerB, request.id))).toBe('NOT_FOUND'); // peers without a checker role cannot even see it
    expect(await code(svc.approve(adminA, request.id))).toBe('CHECKER_ROLE_FORBIDDEN'); // ADMIN sees all, but is not a checker for this policy
  });

  it('MC-BR-2: branch-scoped checker only decides own-branch requests; unscoped APPROVER decides any', async () => {
    const { svc } = build();
    const { request } = await svc.submit(officerA, submitInput({ targetId: 'REG1' }));
    expect(await code(svc.approve(managerB2, request.id))).toBe('NOT_FOUND');
    const r2 = await svc.submit(officerA, submitInput({ targetId: 'REG2' }));
    expect((await svc.approve(approver, r2.request.id)).status).toBe('APPLIED');
    expect((await svc.approve(managerB1, request.id)).status).toBe('APPLIED');
  });

  it('is idempotent-safe: a second approval is a 409 and applies nothing twice', async () => {
    const { svc, handler } = build();
    const { request } = await svc.submit(officerA, submitInput());
    await svc.approve(managerB1, request.id);
    expect(await code(svc.approve(approver, request.id))).toBe('ALREADY_DECIDED');
    expect(handler.applied).toBe(1);
  });

  it('two checkers racing: exactly one wins', async () => {
    const { svc, handler } = build();
    const { request } = await svc.submit(officerA, submitInput());
    const results = await Promise.allSettled([svc.approve(managerB1, request.id), svc.approve(approver, request.id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(handler.applied).toBe(1);
  });

  it('MC-BR-6: an expired request cannot be approved; it is closed as EXPIRED', async () => {
    const { svc, store, clock, handler } = build();
    const { request } = await svc.submit(officerA, submitInput());
    clock.advanceHours(25);
    expect(await code(svc.approve(managerB1, request.id))).toBe('EXPIRED');
    expect(handler.applied).toBe(0);
    const after = await svc.get(managerB1, request.id);
    expect(after.status).toBe('EXPIRED');
    expect(after.history!.map((h) => h.event)).toEqual(['SUBMITTED', 'EXPIRED']);
    expect(store.outbox.at(-1)).toMatchObject({ type: 'ChangeRequestDecided', outcome: 'EXPIRED', changeRequestId: request.id });
  });

  it('MC-BR-6: after the sweeper already closed it, approve/reject still answer EXPIRED (not ALREADY_DECIDED)', async () => {
    const { svc, clock, handler } = build();
    const { request } = await svc.submit(officerA, submitInput());
    clock.advanceHours(25);
    expect(await svc.expireOverdue(100)).toBe(1);
    expect(await code(svc.approve(managerB1, request.id))).toBe('EXPIRED');
    expect(await code(svc.reject(managerB1, request.id, 'late'))).toBe('EXPIRED');
    expect(await code(svc.cancel(officerA, request.id))).toBe('ALREADY_DECIDED');
    expect(handler.applied).toBe(0);
  });

  it('the clock is read after the row lock: a decision that waited past the deadline is EXPIRED, not APPLIED', async () => {
    const { svc, store, clock, handler } = build();
    const { request } = await svc.submit(officerA, submitInput());
    clock.advanceHours(23); // still inside the 24h window when the approve is issued
    let release!: () => void;
    let started!: () => void;
    const running = new Promise<void>((r) => { started = r; });
    const held = store.transaction(() => new Promise<void>((r) => { release = r; started(); })); // another tx holds the store
    await running;
    const approving = code(svc.approve(managerB1, request.id));
    clock.advanceHours(2); // the deadline passes while the approve is waiting
    release();
    await held;
    expect(await approving).toBe('EXPIRED');
    expect(handler.applied).toBe(0);
    expect((await svc.get(managerB1, request.id)).status).toBe('EXPIRED');
  });

  it('a lock wait that times out is a retryable 409 DECISION_IN_PROGRESS and changes nothing', async () => {
    const { svc, store, handler } = build();
    const { request } = await svc.submit(officerA, submitInput());
    const original = store.transaction.bind(store);
    store.transaction = () => Promise.reject(new LockTimeoutError());
    expect(await code(svc.approve(managerB1, request.id))).toBe('DECISION_IN_PROGRESS');
    expect(await code(svc.submit(officerB, submitInput({ targetId: 'OTHER' })))).toBe('DECISION_IN_PROGRESS');
    store.transaction = original;
    expect(handler.applied).toBe(0);
    expect((await svc.approve(managerB1, request.id)).status).toBe('APPLIED');
  });

  it('MC-BR-7: stale target → nothing applied, request FAILED with a reason, maker must resubmit', async () => {
    const { svc, store, handler } = build();
    notes(store.db).REG1 = { name: 'Old', version: 1 };
    const { request } = await svc.submit(officerA, submitInput());
    notes(store.db).REG1 = { name: 'Changed by someone else', version: 2 };
    expect(await code(svc.approve(managerB1, request.id))).toBe('STALE_TARGET');
    expect(handler.applied).toBe(0);
    expect(notes(store.db).REG1).toEqual({ name: 'Changed by someone else', version: 2 });
    const failed = await svc.get(officerA, request.id);
    expect(failed).toMatchObject({ status: 'FAILED', checkerId: 'managerB1' });
    expect(failed.failureReason).toBeTruthy();
    expect(failed.history!.map((h) => h.event)).toEqual(['SUBMITTED', 'FAILED']);
    expect(store.outbox.at(-1)).toMatchObject({ type: 'ChangeRequestDecided', outcome: 'FAILED' });
    // maker can resubmit with fresh data
    expect((await svc.submit(officerA, submitInput())).outcome).toBe('PENDING');
  });

  it('a crashing handler rolls everything back and leaves the request PENDING', async () => {
    const { svc, store, handler } = build();
    const { request } = await svc.submit(officerA, submitInput());
    const boom = new Error('db down');
    handler.apply = async ({ db }) => { notes(db as FakeDb).REG1 = { name: 'half-written', version: 1 }; throw boom; };
    await expect(svc.approve(managerB1, request.id)).rejects.toBe(boom);
    expect(notes(store.db).REG1).toBeUndefined();
    expect((await svc.get(managerB1, request.id)).status).toBe('PENDING');
    expect(store.outbox).toHaveLength(1); // only the Submitted event
  });

  it('unknown request → 404', async () => {
    const { svc } = build();
    expect(await code(svc.approve(managerB1, '00000000-0000-4000-8000-000000000000'))).toBe('NOT_FOUND');
  });
});

describe('reject (MC-FR-3, MC-BR-4)', () => {
  it('requires a comment', async () => {
    const { svc } = build();
    const { request } = await svc.submit(officerA, submitInput());
    expect(await code(svc.reject(managerB1, request.id, ''))).toBe('VALIDATION_FAILED');
    expect(await code(svc.reject(managerB1, request.id, '  ab '))).toBe('VALIDATION_FAILED');
  });

  it('closes the request as REJECTED without applying anything', async () => {
    const { svc, store, handler } = build();
    const { request } = await svc.submit(officerA, submitInput());
    const done = await svc.reject(managerB1, request.id, 'Баримт дутуу');
    expect(done).toMatchObject({ status: 'REJECTED', checkerId: 'managerB1', checkerComment: 'Баримт дутуу' });
    expect(handler.applied).toBe(0);
    expect(notes(store.db).REG1).toBeUndefined();
    expect(store.outbox.at(-1)).toMatchObject({ type: 'ChangeRequestDecided', outcome: 'REJECTED', checkerId: 'managerB1' });
    expect(done.history!.map((h) => [h.event, h.fromStatus, h.toStatus, h.actorId, h.comment])).toEqual([
      ['SUBMITTED', null, 'PENDING', 'officerA', 'Харилцагчийн хүсэлтээр засав'], ['REJECTED', 'PENDING', 'REJECTED', 'managerB1', 'Баримт дутуу'],
    ]);
    expect(await code(svc.approve(approver, request.id))).toBe('ALREADY_DECIDED');
  });
});

describe('cancel', () => {
  it('only the maker can cancel, only while PENDING', async () => {
    const { svc, store } = build();
    const { request } = await svc.submit(officerA, submitInput());
    expect(await code(svc.cancel(managerB1, request.id))).toBe('ONLY_MAKER_CAN_CANCEL');
    expect(await code(svc.cancel(actor('stranger', ['OFFICER']), request.id))).toBe('NOT_FOUND');
    const cancelled = await svc.cancel(officerA, request.id, 'буруу оруулсан');
    expect(cancelled).toMatchObject({ status: 'CANCELLED', canCancel: false });
    expect(cancelled.history!.at(-1)).toMatchObject({ event: 'CANCELLED', actorId: 'officerA', comment: 'буруу оруулсан' });
    expect(cancelled.checkerComment).toBeNull(); // the maker's cancel note lives in history only, never as a "checker" comment
    expect(store.outbox.at(-1)).toMatchObject({ type: 'ChangeRequestDecided', outcome: 'CANCELLED', checkerId: null, actorId: 'officerA' });
    expect(await code(svc.cancel(officerA, request.id))).toBe('ALREADY_DECIDED');
    expect(await code(svc.approve(managerB1, request.id))).toBe('ALREADY_DECIDED');
  });
});

describe('policy: DIRECT mode when a policy is disabled (MC-FR-2)', () => {
  it('applies immediately, still records the audit trail with no checker', async () => {
    const { svc, store, handler } = build();
    store.state.policies.set('org1|BLACKLIST_ENTRY|UPDATE', { orgId: 'org1', targetType: 'BLACKLIST_ENTRY', action: 'UPDATE', enabled: false, checkerRoles: ['APPROVER'], expiresInHours: 1, updatedAt: new Date(), updatedBy: 'x' });
    const r = await svc.submit(officerA, submitInput());
    expect(r.outcome).toBe('APPLIED_DIRECT');
    expect(r.request).toMatchObject({ mode: 'DIRECT', status: 'APPLIED', checkerId: null });
    expect(handler.applied).toBe(1);
    expect(r.request.history).toEqual([expect.objectContaining({ event: 'DIRECT_APPLIED', actorId: 'officerA' })]);
    expect(store.outbox).toEqual([expect.objectContaining({ type: 'ChangeRequestDecided', outcome: 'APPLIED_DIRECT', checkerId: null })]);
  });

  it('DIRECT apply on stale data fails with 409 and leaves nothing behind', async () => {
    const { svc, store } = build();
    store.state.policies.set('org1|BLACKLIST_ENTRY|UPDATE', { orgId: 'org1', targetType: 'BLACKLIST_ENTRY', action: 'UPDATE', enabled: false, checkerRoles: ['APPROVER'], expiresInHours: 1, updatedAt: new Date(), updatedBy: 'x' });
    notes(store.db).REG1 = { name: 'x', version: 3 };
    expect(await code(svc.submit(officerA, submitInput({ baseVersion: '1' })))).toBe('STALE_TARGET');
    expect(store.rows()).toHaveLength(0);
  });

  it('a DIRECT change never overtakes a PENDING request for the same target (MC-BR-5)', async () => {
    const { svc, store, handler } = build();
    const pending = await svc.submit(officerA, submitInput({ targetId: 'REG7' }));
    await store.transaction((tx) => tx.upsertPolicy({ orgId: 'org1', targetType: 'BLACKLIST_ENTRY', action: 'UPDATE', enabled: false, checkerRoles: ['APPROVER'], expiresInHours: 24, updatedBy: 'adminA' }));
    expect(await code(svc.submit(officerB, submitInput({ targetId: 'REG7' })))).toBe('TARGET_HAS_PENDING_CHANGE');
    expect(handler.applied).toBe(0);
    await svc.cancel(officerA, pending.request.id);
    expect((await svc.submit(officerB, submitInput({ targetId: 'REG7' }))).outcome).toBe('APPLIED_DIRECT');
  });

  it('an overdue PENDING request that was not swept yet does not block a re-submit; it is closed as EXPIRED first (MC-BR-6)', async () => {
    const { svc, store, clock } = build();
    const first = await svc.submit(officerA, submitInput({ targetId: 'REG8' }));
    clock.advanceHours(25);
    const second = await svc.submit(officerB, submitInput({ targetId: 'REG8' }));
    expect(second.request.status).toBe('PENDING');
    const old = await svc.get(officerA, first.request.id);
    expect(old.status).toBe('EXPIRED');
    expect(old.history!.map((h) => h.event)).toEqual(['SUBMITTED', 'EXPIRED']);
    expect(store.outbox.filter((e) => e.type === 'ChangeRequestDecided' && e.outcome === 'EXPIRED')).toHaveLength(1);
    // …but a request that is still inside its window does block
    expect(await code(svc.submit(officerA, submitInput({ targetId: 'REG8' })))).toBe('TARGET_HAS_PENDING_CHANGE');
  });

  it('admin-configured checkerRoles/TTL override the handler defaults', async () => {
    const { svc, store, clock } = build();
    store.state.policies.set('org1|BLACKLIST_ENTRY|UPDATE', { orgId: 'org1', targetType: 'BLACKLIST_ENTRY', action: 'UPDATE', enabled: true, checkerRoles: ['APPROVER'], expiresInHours: 2, updatedAt: new Date(), updatedBy: 'x' });
    const { request } = await svc.submit(officerA, submitInput());
    expect(request.requiredCheckerRoles).toEqual(['APPROVER']);
    expect(request.expiresAt).toBe(new Date(clock.now().getTime() + 2 * 3_600_000).toISOString());
    expect(await code(svc.approve(managerB1, request.id))).toBe('NOT_FOUND'); // manager no longer eligible nor can see it
    expect((await svc.approve(approver, request.id)).status).toBe('APPLIED');
  });

  it('later policy changes do not alter an already submitted request (roles are snapshotted)', async () => {
    const { svc, store } = build();
    const { request } = await svc.submit(officerA, submitInput());
    store.state.policies.set('org1|BLACKLIST_ENTRY|UPDATE', { orgId: 'org1', targetType: 'BLACKLIST_ENTRY', action: 'UPDATE', enabled: true, checkerRoles: ['APPROVER'], expiresInHours: 2, updatedAt: new Date(), updatedBy: 'x' });
    expect((await svc.approve(managerB1, request.id)).status).toBe('APPLIED');
  });
});

describe('policy changes are themselves four-eyes (MC-BR-8)', () => {
  const change = (over: Record<string, unknown> = {}) => ({ targetType: 'BLACKLIST_ENTRY', action: 'UPDATE', enabled: false, checkerRoles: ['APPROVER'], expiresInHours: 48, ...over }) as Parameters<ReturnType<typeof build>['svc']['submitPolicyChange']>[1];

  it('only ADMIN can propose; a second admin approves; then the policy is in effect', async () => {
    const { svc, handler } = build();
    expect(await code(svc.submitPolicyChange(officerA, change(), 'унтраах'))).toBe('MAKER_ROLE_FORBIDDEN');
    const { request } = await svc.submitPolicyChange(adminA, change(), 'Түр унтраах');
    expect(request).toMatchObject({ status: 'PENDING', targetType: 'MAKER_CHECKER_POLICY', targetId: 'BLACKLIST_ENTRY:UPDATE', before: { enabled: true, checkerRoles: ['BRANCH_MANAGER', 'APPROVER'], expiresInHours: 24 } });
    // before approval the old policy still applies
    expect((await svc.submit(officerA, submitInput())).outcome).toBe('PENDING');
    expect(await code(svc.approve(adminA, request.id))).toBe('SELF_APPROVAL_FORBIDDEN');
    expect(await code(svc.approve(managerB1, request.id))).toBe('NOT_FOUND');
    await svc.approve(adminB, request.id, 'зөвшөөрлөө');
    const policies = await svc.listPolicies(adminA);
    expect(policies.find((p) => p.targetType === 'BLACKLIST_ENTRY')).toMatchObject({ enabled: false, checkerRoles: ['APPROVER'], expiresInHours: 48, configured: true, locked: false });
    expect((await svc.submit(officerB, submitInput({ targetId: 'REG9' }))).outcome).toBe('APPLIED_DIRECT');
    expect(handler.applied).toBe(1);
  });

  it('the policy-change control itself can never be switched off', async () => {
    const { svc } = build();
    expect(await code(svc.submitPolicyChange(adminA, change({ targetType: 'MAKER_CHECKER_POLICY', action: 'UPDATE', enabled: false }), 'unsafe'))).toBe('POLICY_LOCKED');
    const ok = await svc.submitPolicyChange(adminA, change({ targetType: 'MAKER_CHECKER_POLICY', action: 'UPDATE', enabled: true, checkerRoles: ['ADMIN'] }), 'зөвхөн админ');
    expect(ok.outcome).toBe('PENDING');
  });

  it('rejects policy changes for unknown handlers and mismatched targetId', async () => {
    const { svc } = build();
    expect(await code(svc.submitPolicyChange(adminA, change({ targetType: 'GHOST' }), 'x y z'))).toBe('HANDLER_NOT_FOUND');
    expect(await code(svc.submit(adminA, { targetType: 'MAKER_CHECKER_POLICY', action: 'UPDATE', targetId: 'SOMETHING_ELSE', payload: change(), reason: 'abc' }))).toBe('TARGET_ID_MISMATCH');
  });

  it('a policy changed behind the request\'s back after submission → approval fails as stale and the request is FAILED (MC-BR-7)', async () => {
    const { svc, store } = build();
    const { request } = await svc.submitPolicyChange(adminA, change({ expiresInHours: 10 }), 'a b c');
    expect(request.baseVersion).toBe('default');
    await store.transaction((tx) => tx.upsertPolicy({ orgId: 'org1', targetType: 'BLACKLIST_ENTRY', action: 'UPDATE', enabled: true, checkerRoles: ['ADMIN'], expiresInHours: 99, updatedBy: 'out-of-band' }));
    expect(await code(svc.approve(adminB, request.id))).toBe('STALE_TARGET');
    const failed = await svc.get(adminA, request.id);
    expect(failed).toMatchObject({ status: 'FAILED', checkerId: 'adminB' });
    expect(failed.history!.map((h) => h.event)).toEqual(['SUBMITTED', 'FAILED']);
    expect((await svc.listPolicies(adminA)).find((p) => p.targetType === 'BLACKLIST_ENTRY')).toMatchObject({ expiresInHours: 99, checkerRoles: ['ADMIN'] });
  });

  it('consecutive policy changes on one target are serialized: a second one is refused while the first is pending (MC-BR-5)', async () => {
    const { svc } = build();
    const first = await svc.submitPolicyChange(adminA, change({ expiresInHours: 10 }), 'a b c');
    // another admin pair completes a different change first … but the first is still pending on the same target → 409
    expect(await code(svc.submitPolicyChange(adminB, change({ expiresInHours: 20 }), 'd e f'))).toBe('TARGET_HAS_PENDING_CHANGE');
    await svc.approve(adminB, first.request.id);
    const second = await svc.submitPolicyChange(adminB, change({ expiresInHours: 30 }), 'g h i');
    await svc.approve(adminA, second.request.id);
    expect((await svc.listPolicies(adminA)).find((p) => p.targetType === 'BLACKLIST_ENTRY')!.expiresInHours).toBe(30);
  });

  it('listPolicies is limited to ADMIN/APPROVER and shows defaults for unconfigured handlers', async () => {
    const { svc } = build();
    expect(await code(svc.listPolicies(officerA))).toBe('FORBIDDEN');
    const list = await svc.listPolicies(approver);
    expect(list.map((p) => `${p.targetType}:${p.action}`)).toEqual(['BLACKLIST_ENTRY:UPDATE', 'MAKER_CHECKER_POLICY:UPDATE']);
    expect(list[0]).toMatchObject({ configured: false, locked: false, enabled: true, updatedAt: null });
    expect(list[1]).toMatchObject({ locked: true, enabled: true, makerRoles: ['ADMIN'] });
  });
});

describe('visibility, listing and summary (MC-FR-4/5)', () => {
  it('canView: maker, eligible checker, deciding checker and ADMIN — nobody else', async () => {
    const { svc } = build();
    const { request } = await svc.submit(officerA, submitInput());
    for (const a of [officerA, managerB1, approver, adminA]) await expect(svc.get(a, request.id)).resolves.toMatchObject({ id: request.id });
    for (const a of [officerB, managerB2]) expect(await code(svc.get(a, request.id))).toBe('NOT_FOUND');
  });

  it('inbox lists exactly what the actor can decide; mine lists own; decided lists decided; all is ADMIN-only', async () => {
    const { svc, clock } = build();
    const r1 = await svc.submit(officerA, submitInput({ targetId: 'R1' }));
    await svc.submit(managerB1, submitInput({ targetId: 'R2' }));
    const r3 = await svc.submit(officerB, submitInput({ targetId: 'R3' }));
    const q = (scope: 'inbox' | 'mine' | 'decided' | 'all') => ({ scope, page: 1, pageSize: 20 as const });

    expect((await svc.list(managerB1, q('inbox'))).items.map((i) => i.id).sort()).toEqual([r1.request.id, r3.request.id].sort()); // not own r2
    expect((await svc.list(managerB2, q('inbox'))).total).toBe(0); // other branch
    expect((await svc.list(approver, q('inbox'))).total).toBe(3);
    expect((await svc.list(officerA, q('inbox'))).total).toBe(0);
    expect((await svc.list(adminA, q('inbox'))).total).toBe(0); // admin is not a checker for this policy
    expect((await svc.list(officerA, q('mine'))).items.map((i) => i.id)).toEqual([r1.request.id]);
    expect(await code(svc.list(managerB1, q('all')))).toBe('FORBIDDEN');
    expect((await svc.list(adminA, q('all'))).total).toBe(3);

    await svc.approve(managerB1, r1.request.id);
    expect((await svc.list(managerB1, q('decided'))).items.map((i) => i.id)).toEqual([r1.request.id]);
    expect((await svc.list(adminA, { ...q('all'), status: 'APPLIED' })).total).toBe(1);
    expect((await svc.list(managerB1, q('inbox'))).items.map((i) => i.id)).toEqual([r3.request.id]);

    clock.advanceHours(30); // everything left is overdue → leaves the inbox
    expect((await svc.list(managerB1, q('inbox'))).total).toBe(0);
  });

  it('summary counts inbox and my pending requests; canDecide flags agree with the inbox', async () => {
    const { svc } = build();
    await svc.submit(officerA, submitInput({ targetId: 'R1' }));
    await svc.submit(officerA, submitInput({ targetId: 'R2' }));
    expect(await svc.summary(managerB1)).toEqual({ inbox: 2, mine: 0 });
    expect(await svc.summary(officerA)).toEqual({ inbox: 0, mine: 2 });
    const page = await svc.list(managerB1, { scope: 'inbox', page: 1, pageSize: 10 });
    expect(page.items.every((i) => i.canDecide === true && i.canCancel === false)).toBe(true);
  });

  it('paginates', async () => {
    const { svc } = build();
    for (let i = 0; i < 12; i++) await svc.submit(officerA, submitInput({ targetId: `R${i}` }));
    const p2 = await svc.list(managerB1, { scope: 'inbox', page: 2, pageSize: 10 });
    expect(p2).toMatchObject({ total: 12, page: 2, pageSize: 10 });
    expect(p2.items).toHaveLength(2);
  });
});

describe('expiry sweep (MC-BR-6)', () => {
  it('closes only overdue PENDING requests, with history + event, in batches', async () => {
    const { svc, store, clock } = build();
    const a = await svc.submit(officerA, submitInput({ targetId: 'A' }));
    clock.advanceHours(10);
    const b = await svc.submit(officerA, submitInput({ targetId: 'B' }));
    clock.advanceHours(15); // A overdue (25h), B not (15h)
    expect(await svc.expireOverdue(100)).toBe(1);
    expect((await svc.get(officerA, a.request.id)).status).toBe('EXPIRED');
    expect((await svc.get(officerA, b.request.id)).status).toBe('PENDING');
    expect((await svc.get(officerA, a.request.id)).history!.at(-1)).toMatchObject({ event: 'EXPIRED', actorId: null });
    expect(store.outbox.at(-1)).toMatchObject({ type: 'ChangeRequestDecided', outcome: 'EXPIRED', actorId: null });
    expect(await svc.expireOverdue(100)).toBe(0);
    // target is free again
    expect((await svc.submit(officerB, submitInput({ targetId: 'A' }))).outcome).toBe('PENDING');
  });
});

describe('registry', () => {
  it('rejects duplicate registration and handlers without roles', () => {
    const { registry, handler } = build();
    expect(() => registry.register(handler)).toThrow(/already registered/);
    const bad = Object.assign(new NoteUpdateHandler(), { action: 'X', makerRoles: [] as never });
    expect(() => registry.register(bad)).toThrow(/needs makerRoles/);
  });
});
