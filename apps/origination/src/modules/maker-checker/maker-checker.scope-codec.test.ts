// Framework extension points for handlers whose request belongs to another branch than the maker's (scopeBranchId)
// and whose payload carries PII (codec). Existing handlers must keep the old behaviour — see maker-checker.service.test.ts.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ChangeConflictError, type ApplyContext, type ChangeHandler, type PayloadCodec, type SnapshotContext } from './change-handler';
import { MakerCheckerError } from './maker-checker.errors';
import { actor, build, managerB1, managerB2, officerA } from './testing/fixtures';
import type { FakeDb } from './testing/in-memory.store';

const code = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { if (e instanceof MakerCheckerError) return e.code; throw e; }
  return 'NO_ERROR';
};

const Secret = z.object({ phone: z.string().regex(/^\d{8}$/) });
type Secret = z.infer<typeof Secret>;
interface Owned { owner: string | null; phone: string; version: number }
const owned = (db: unknown) => (db as FakeDb).records as Record<string, Owned>;

/** Reversible toy codec: these tests assert on what reaches the store, not on cryptography (that is pii-codec.test.ts). */
const toyCodec: PayloadCodec = {
  seal: (value, ref) => ({ sealed: Buffer.from(JSON.stringify({ ref, value })).toString('base64'), summary: { keys: Object.keys(value as object) } }),
  unseal: (stored, ref) => {
    const { ref: r, value } = JSON.parse(Buffer.from((stored as { sealed: string }).sealed, 'base64').toString()) as { ref: typeof ref; value: unknown };
    if (r.targetId !== ref.targetId || r.orgId !== ref.orgId) throw new Error('ciphertext bound to another target');
    return value;
  },
};

class OwnedRecordHandler implements ChangeHandler<Secret> {
  readonly targetType = 'OWNED_RECORD';
  readonly action = 'UPDATE';
  readonly payloadSchema = Secret;
  readonly makerRoles = ['OFFICER'] as const;
  readonly defaultPolicy = { enabled: true, checkerRoles: ['BRANCH_MANAGER'], expiresInHours: 24 } as const;
  codec?: PayloadCodec = toyCodec;
  seenTargetId: string | null = null;
  applied: Secret[] = [];
  validate({ targetId }: { targetId: string }) { this.seenTargetId = targetId; }
  async snapshot({ db, targetId }: SnapshotContext) {
    const r = owned(db)[targetId];
    return r ? { before: { phone: r.phone }, baseVersion: String(r.version), scopeBranchId: r.owner } : null;
  }
  async apply({ db, request, payload }: ApplyContext<Secret>) {
    const r = owned(db)[request.targetId];
    if (!r || String(r.version) !== request.baseVersion) throw new ChangeConflictError('record changed');
    owned(db)[request.targetId] = { ...r, phone: payload.phone, version: r.version + 1 };
    this.applied.push(payload);
  }
}

function setup(owner: string | null = 'B2', codec: PayloadCodec | null = toyCodec) {
  const ctx = build();
  const handler = new OwnedRecordHandler();
  handler.codec = codec ?? undefined;
  ctx.registry.register(handler);
  owned(ctx.store.db).R1 = { owner, phone: '99112233', version: 1 };
  const submit = (who = officerA, phone = '88001122') => ctx.svc.submit(who, { targetType: 'OWNED_RECORD', action: 'UPDATE', targetId: 'R1', payload: { phone }, reason: 'Утас солих' });
  return { ...ctx, handler, submit };
}

describe('scopeBranchId: the handler decides which branch checks the request', () => {
  it('stores the owning branch (not the maker\'s) as the request branch', async () => {
    const { submit } = setup('B2');
    const { request } = await submit(officerA); // officerA is in B1
    expect(request.branchId).toBe('B2');
  });

  it('the owning branch manager approves; the maker\'s own branch manager cannot see or approve it', async () => {
    const { svc, submit, handler } = setup('B2');
    const { request } = await submit(officerA);
    expect(await code(svc.approve(managerB1, request.id))).toBe('NOT_FOUND'); // MC-FR-5: not even visible
    expect((await svc.list(managerB1, { scope: 'inbox', page: 1, pageSize: 20 })).total).toBe(0);
    expect((await svc.list(managerB2, { scope: 'inbox', page: 1, pageSize: 20 })).total).toBe(1);
    const done = await svc.approve(managerB2, request.id);
    expect(done.status).toBe('APPLIED');
    expect(handler.applied).toEqual([{ phone: '88001122' }]);
  });

  it('scopeBranchId = null fails closed for branch-scoped checkers', async () => {
    const { svc, submit } = setup(null);
    const { request } = await submit(officerA);
    expect(request.branchId).toBeNull();
    expect(await code(svc.approve(managerB1, request.id))).toBe('NOT_FOUND');
  });

  it('a handler that omits scopeBranchId keeps the maker\'s branch (backward compatible)', async () => {
    const { svc } = build();
    const { request } = await svc.submit(actor('o2', ['OFFICER'], 'B2'), { targetType: 'BLACKLIST_ENTRY', action: 'UPDATE', targetId: 'X', payload: { name: 'n' }, reason: 'Нэр засах хүсэлт' });
    expect(request.branchId).toBe('B2');
  });

  it('validate() receives the targetId', async () => {
    const { submit, handler } = setup();
    await submit();
    expect(handler.seenTargetId).toBe('R1');
  });
});

describe('codec: PII never reaches the immutable request row in plaintext', () => {
  it('payload and before are stored sealed; only the codec summary is readable', async () => {
    const { store, submit } = setup();
    const { request } = await submit(officerA, '88001122');
    const row = await store.getById('org1', request.id);
    expect(JSON.stringify(row?.payload)).not.toContain('88001122');
    expect(JSON.stringify(row?.before)).not.toContain('99112233');
    expect(row?.payload).toMatchObject({ summary: { keys: ['phone'] } });
  });

  it('list items stay sealed; the detail view (get) reveals them to an authorised viewer', async () => {
    const { svc, submit } = setup();
    const { request } = await submit();
    const listed = (await svc.list(managerB2, { scope: 'inbox', page: 1, pageSize: 20 })).items[0];
    expect(JSON.stringify(listed.payload)).not.toContain('88001122');
    const detail = await svc.get(managerB2, request.id);
    expect(detail.payload).toEqual({ phone: '88001122' });
    expect(detail.before).toEqual({ phone: '99112233' });
  });

  it('the maker sees the revealed payload in the submit response', async () => {
    const { submit } = setup();
    const { request } = await submit();
    expect(request.payload).toEqual({ phone: '88001122' });
  });

  it('apply() receives the unsealed payload, re-validated by the schema', async () => {
    const { svc, submit, handler } = setup();
    const { request } = await submit();
    await svc.approve(managerB2, request.id);
    expect(handler.applied).toEqual([{ phone: '88001122' }]);
  });

  it('a stored payload that no longer passes the schema fails the request as stale (409), nothing applied', async () => {
    const { svc, submit, handler, store } = setup();
    const { request } = await submit();
    handler.codec = { seal: toyCodec.seal, unseal: () => ({ phone: 'not-a-phone' }) };
    expect(await code(svc.approve(managerB2, request.id))).toBe('STALE_TARGET');
    expect((await store.getById('org1', request.id))?.status).toBe('FAILED');
    expect(handler.applied).toEqual([]);
  });

  it('a stored payload that cannot be unsealed (retired key) fails as stale, not 500', async () => {
    const { svc, submit, handler, store } = setup();
    const { request } = await submit();
    handler.codec = { seal: toyCodec.seal, unseal: () => { throw new Error('key retired'); } };
    expect(await code(svc.approve(managerB2, request.id))).toBe('STALE_TARGET');
    const row = await store.getById('org1', request.id);
    expect(row?.status).toBe('FAILED');
    expect(row?.failureReason).not.toContain('88001122');
    expect(handler.applied).toEqual([]);
  });

  it('get() does not 500 when the payload cannot be unsealed — it returns the sealed form', async () => {
    const { svc, submit, handler } = setup();
    const { request } = await submit();
    handler.codec = { seal: toyCodec.seal, unseal: () => { throw new Error('key retired'); } };
    const detail = await svc.get(managerB2, request.id);
    expect(detail.payload).toMatchObject({ summary: { keys: ['phone'] } });
  });

  it('without a codec the payload is stored as-is (existing handlers unchanged)', async () => {
    const { store, submit } = setup('B2', null);
    const { request } = await submit();
    expect((await store.getById('org1', request.id))?.payload).toEqual({ phone: '88001122' });
  });
});

describe('concurrent target change between submit and approve', () => {
  it('stale target → FAILED, visible to the owning manager, the record is untouched', async () => {
    const { svc, submit, store } = setup();
    const { request } = await submit();
    owned(store.db).R1 = { owner: 'B2', phone: '77001122', version: 2 }; // direct edit by the owning branch meanwhile
    expect(await code(svc.approve(managerB2, request.id))).toBe('STALE_TARGET');
    expect((await svc.get(managerB2, request.id)).status).toBe('FAILED');
    expect(owned(store.db).R1.phone).toBe('77001122');
  });
});
