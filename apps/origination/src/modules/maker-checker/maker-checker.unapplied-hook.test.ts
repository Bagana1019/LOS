// F8-2: ChangeHandler.onNotApplied — хүсэлт apply-гүйгээр хаагдахад (татгалзсан / цуцалсан / хугацаа дууссан / FAILED) handler зорилтынхоо
// "хүлээгдэж буй" төлвийг цэвэрлэж чадна. Төлөв өөрчлөлттэй НЭГ tx-д ажиллана. apply (батлалт), мөн шинэ илгээлтээр шууд солигдох
// хугацаа дууссан хүсэлтэд дуудагдахгүй (шинэ хүсэлт зорилтын pending төлвийг өөртөө авна).
import { describe, expect, it } from 'vitest';
import { ChangeHandlerRegistry, type UnappliedContext } from './change-handler';
import { MakerCheckerError } from './maker-checker.errors';
import { MakerCheckerService } from './maker-checker.service';
import { managerB1, NoteUpdateHandler, officerA, officerB, submitInput, TestClock } from './testing/fixtures';
import { InMemoryChangeRequestStore, type FakeDb } from './testing/in-memory.store';

interface Seen { outcome: string; requestId: string; status: string; actorId: string | null; checkerComment: string | null; failureReason: string | null }

/** Hook-ийн дуудлага бүрийг тэмдэглээд, tx-ийн db-д "cleared:<target>" мөр бичнэ (нэг tx-д байгааг rollback-аар шалгана). */
class HookedHandler extends NoteUpdateHandler {
  readonly seen: Seen[] = [];
  failWith: Error | null = null;
  async onNotApplied({ db, request, outcome, actor }: UnappliedContext): Promise<void> {
    this.seen.push({ outcome, requestId: request.id, status: request.status, actorId: actor?.userId ?? null, checkerComment: request.checkerComment, failureReason: request.failureReason });
    (db as FakeDb).records[`cleared:${request.targetId}`] = { name: outcome, version: 1 };
    if (this.failWith) throw this.failWith;
  }
}

function setup() {
  const store = new InMemoryChangeRequestStore();
  const registry = new ChangeHandlerRegistry();
  const clock = new TestClock();
  const handler = new HookedHandler();
  registry.register(handler);
  return { store, clock, handler, svc: new MakerCheckerService(store, registry, clock) };
}
const cleared = (store: InMemoryChangeRequestStore, target = 'REG1') => store.db.records[`cleared:${target}`];
const code = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { if (e instanceof MakerCheckerError) return e.code; throw e; }
  return 'NO_ERROR';
};

describe('ChangeHandler.onNotApplied (F8-2)', () => {
  it('runs when a checker rejects: after the status is REJECTED, with the checker as actor and the rejection comment', async () => {
    const { svc, store, handler } = setup();
    const { request } = await svc.submit(officerA, submitInput());
    await svc.reject(managerB1, request.id, 'Баримт дутуу');

    expect(handler.seen).toEqual([{ outcome: 'REJECTED', requestId: request.id, status: 'REJECTED', actorId: 'managerB1', checkerComment: 'Баримт дутуу', failureReason: null }]);
    expect(cleared(store)).toEqual({ name: 'REJECTED', version: 1 });
  });

  it('runs when the maker cancels, with the maker as actor', async () => {
    const { svc, store, handler } = setup();
    const { request } = await svc.submit(officerA, submitInput());
    await svc.cancel(officerA, request.id, 'буруу оруулсан');

    expect(handler.seen).toEqual([expect.objectContaining({ outcome: 'CANCELLED', status: 'CANCELLED', actorId: 'officerA' })]);
    expect(cleared(store)).toEqual({ name: 'CANCELLED', version: 1 });
  });

  it('runs for every request the expiry sweeper closes, with no actor, and not for requests still inside their window', async () => {
    const { svc, store, handler, clock } = setup();
    const a = await svc.submit(officerA, submitInput({ targetId: 'A' }));
    clock.advanceHours(10);
    await svc.submit(officerA, submitInput({ targetId: 'B' }));
    clock.advanceHours(15); // A overdue (25h), B not (15h)
    expect(await svc.expireOverdue(100)).toBe(1);

    expect(handler.seen).toEqual([expect.objectContaining({ outcome: 'EXPIRED', status: 'EXPIRED', requestId: a.request.id, actorId: null })]);
    expect(cleared(store, 'A')).toEqual({ name: 'EXPIRED', version: 1 });
    expect(cleared(store, 'B')).toBeUndefined();
  });

  it('runs when a late approval finds the request overdue (it is closed as EXPIRED and the caller still gets EXPIRED)', async () => {
    const { svc, store, handler, clock } = setup();
    const { request } = await svc.submit(officerA, submitInput());
    clock.advanceHours(25);

    expect(await code(svc.approve(managerB1, request.id))).toBe('EXPIRED');
    expect(handler.seen).toEqual([expect.objectContaining({ outcome: 'EXPIRED', actorId: null })]);
    expect(cleared(store)).toEqual({ name: 'EXPIRED', version: 1 }); // the EXPIRED close is committed, not rolled back by the error
  });

  it('runs when an approval is stale and the request becomes FAILED (the target would otherwise stay pending forever)', async () => {
    const { svc, store, handler } = setup();
    store.db.records.REG1 = { name: 'Old', version: 1 };
    const { request } = await svc.submit(officerA, submitInput());
    store.db.records.REG1 = { name: 'Changed by someone else', version: 2 };

    expect(await code(svc.approve(managerB1, request.id))).toBe('STALE_TARGET');
    expect(handler.seen).toEqual([expect.objectContaining({ outcome: 'FAILED', status: 'FAILED', actorId: 'managerB1', failureReason: expect.any(String) })]);
    expect(cleared(store)).toEqual({ name: 'FAILED', version: 1 });
  });

  it('does not run when the change is applied', async () => {
    const { svc, store, handler } = setup();
    const { request } = await svc.submit(officerA, submitInput());
    await svc.approve(managerB1, request.id);

    expect(handler.applied).toBe(1);
    expect(handler.seen).toEqual([]);
    expect(cleared(store)).toBeUndefined();
  });

  it('does not run for an overdue request that a new submission replaces in the same transaction (the new request owns the target)', async () => {
    const { svc, handler, clock } = setup();
    const first = await svc.submit(officerA, submitInput({ targetId: 'REG8' }));
    clock.advanceHours(25);
    const second = await svc.submit(officerB, submitInput({ targetId: 'REG8' }));

    expect(second.request.status).toBe('PENDING');
    expect((await svc.get(officerA, first.request.id)).status).toBe('EXPIRED');
    expect(handler.seen).toEqual([]);
  });

  it('is atomic with the status change: a failing hook rolls the whole rejection back and surfaces the error', async () => {
    const { svc, store, handler } = setup();
    const { request } = await svc.submit(officerA, submitInput());
    const boom = new Error('hook down');
    handler.failWith = boom;

    await expect(svc.reject(managerB1, request.id, 'Баримт дутуу')).rejects.toBe(boom);
    expect((await svc.get(managerB1, request.id)).status).toBe('PENDING');
    expect(cleared(store)).toBeUndefined();
    expect(store.outbox).toHaveLength(1); // only ChangeRequestSubmitted

    handler.failWith = null;
    expect((await svc.reject(managerB1, request.id, 'Баримт дутуу')).status).toBe('REJECTED');
    expect(cleared(store)).toEqual({ name: 'REJECTED', version: 1 });
  });

  it('is optional: a handler without the hook closes requests exactly as before', async () => {
    const store = new InMemoryChangeRequestStore();
    const registry = new ChangeHandlerRegistry();
    registry.register(new NoteUpdateHandler());
    const svc = new MakerCheckerService(store, registry, new TestClock());
    const { request } = await svc.submit(officerA, submitInput());

    expect((await svc.reject(managerB1, request.id, 'Баримт дутуу')).status).toBe('REJECTED');
  });
});
