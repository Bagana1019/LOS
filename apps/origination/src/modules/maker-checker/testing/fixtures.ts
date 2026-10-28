import { z } from 'zod';
import type { UserRole } from '@los/contracts';
import type { Actor } from '../actor';
import { ChangeConflictError, ChangeHandlerRegistry, ChangeValidationError, type ChangeHandler } from '../change-handler';
import type { Clock } from '../clock';
import { PolicyChangeHandler } from '../handlers/policy-change.handler';
import { MakerCheckerService } from '../maker-checker.service';
import { InMemoryChangeRequestStore, type FakeDb } from './in-memory.store';

export const actor = (userId: string, roles: UserRole[], branchId: string | null = 'B1', orgId = 'org1'): Actor => ({
  userId, roles, branchId, orgId, correlationId: `corr-${userId}`,
});
export const officerA = actor('officerA', ['OFFICER']);
export const officerB = actor('officerB', ['OFFICER']);
export const managerB1 = actor('managerB1', ['BRANCH_MANAGER'], 'B1');
export const managerB2 = actor('managerB2', ['BRANCH_MANAGER'], 'B2');
export const approver = actor('approver', ['APPROVER'], null);
export const adminA = actor('adminA', ['ADMIN'], null);
export const adminB = actor('adminB', ['ADMIN'], null);

export class TestClock implements Clock {
  constructor(public t = new Date('2026-10-28T09:00:00.000Z')) {}
  now() { return new Date(this.t); }
  advanceHours(h: number) { this.t = new Date(this.t.getTime() + h * 3_600_000); }
}

export const NoteUpdate = z.object({ name: z.string().min(1) });
type NotePayload = z.infer<typeof NoteUpdate>;
interface NoteRecord { name: string; version: number }
const rec = (db: unknown): Record<string, NoteRecord> => ((db as FakeDb).records as Record<string, NoteRecord>);

/** Домэйн handler-ийн жишээ: "BLACKLIST_ENTRY/UPDATE" — зорилт нь FakeDb дахь бичлэг (хувилбартай) */
export class NoteUpdateHandler implements ChangeHandler<NotePayload> {
  readonly targetType = 'BLACKLIST_ENTRY';
  readonly action = 'UPDATE';
  readonly payloadSchema = NoteUpdate;
  readonly makerRoles = ['OFFICER', 'BRANCH_MANAGER'] as const;
  readonly defaultPolicy = { enabled: true, checkerRoles: ['BRANCH_MANAGER', 'APPROVER'], expiresInHours: 24 } as const;
  applied = 0;
  snapshot({ db, targetId }: { db: unknown; targetId: string }) {
    const r = rec(db)[targetId];
    return Promise.resolve(r ? { before: { name: r.name }, baseVersion: String(r.version) } : { before: null, baseVersion: '0' });
  }
  validate({ payload }: { payload: NotePayload }) { if (payload.name === 'forbidden') throw new ChangeValidationError('name is forbidden'); }
  async apply({ db, request, payload }: { db: unknown; request: { targetId: string; baseVersion: string | null }; payload: NotePayload }) {
    const cur = rec(db)[request.targetId];
    const curVersion = String(cur?.version ?? 0);
    if (request.baseVersion !== null && request.baseVersion !== curVersion) throw new ChangeConflictError();
    rec(db)[request.targetId] = { name: payload.name, version: (cur?.version ?? 0) + 1 };
    this.applied += 1;
  }
}

export function build() {
  const store = new InMemoryChangeRequestStore();
  const registry = new ChangeHandlerRegistry();
  const clock = new TestClock();
  const handler = new NoteUpdateHandler();
  registry.register(handler);
  const policyHandler = new PolicyChangeHandler(registry);
  const svc = new MakerCheckerService(store, registry, clock);
  return { store, registry, clock, handler, policyHandler, svc };
}

export const submitInput = (over: Partial<{ targetId: string; name: string; reason: string; baseVersion: string; applicationId: string }> = {}) => ({
  targetType: 'BLACKLIST_ENTRY', action: 'UPDATE', targetId: over.targetId ?? 'REG1',
  payload: { name: over.name ?? 'New name' }, reason: over.reason ?? 'Харилцагчийн хүсэлтээр засав',
  ...(over.baseVersion ? { baseVersion: over.baseVersion } : {}), ...(over.applicationId ? { applicationId: over.applicationId } : {}),
});
