import { describe, expect, it } from 'vitest';
import {
  ChangeRequestDecided, ChangeRequestSubmitted, DomainEvent, ListChangeRequestsQuery, MakerCheckerPolicy, RejectChangeRequest, SubmitChangeRequest, UserRole,
} from './index';

const base = { eventId: '0b6d6bd8-4c55-4a0e-9d3e-3b0f0e4f2a11', occurredAt: '2026-10-28T09:00:00.000Z', version: 1, orgId: 'o', actorId: 'u', correlationId: 'c' } as const;
const ref = { changeRequestId: '7f0c1b55-6a6e-4d2f-8c3a-1c4f7d6c9a10', targetType: 'BLACKLIST_ENTRY', targetId: 'REG1', action: 'UPDATE', applicationId: null, makerId: 'm' };

describe('maker-checker contracts', () => {
  it('SubmitChangeRequest requires UPPER_SNAKE codes, an object payload and a reason', () => {
    const ok = { targetType: 'BLACKLIST_ENTRY', action: 'UPDATE', targetId: 'REG1', payload: { a: 1 }, reason: 'Шалтгаан' };
    expect(SubmitChangeRequest.safeParse(ok).success).toBe(true);
    for (const bad of [{ targetType: 'lower' }, { action: '' }, { targetId: '  ' }, { payload: 'x' }, { payload: [1] }, { reason: 'a' }, { reason: '   ' }]) {
      expect(SubmitChangeRequest.safeParse({ ...ok, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });
  it('SubmitChangeRequest rejects what PostgreSQL would reject later (NUL bytes) and counts code points, not UTF-16 units', () => {
    const ok = { targetType: 'BLACKLIST_ENTRY', action: 'UPDATE', targetId: 'REG1', payload: { a: 1 }, reason: 'Шалтгаан' };
    const bad: Record<string, unknown>[] = [
      { reason: 'ab\u0000c' }, { targetId: 'A\u0000' }, { applicationId: 'x\u0000' }, { baseVersion: '\u0000' },
      { payload: { name: 'a\u0000b' } }, { payload: { nested: [{ k: 'v\u0000' }] } }, { payload: { 'k\u0000': 1 } },
    ];
    for (const b of bad) expect(SubmitChangeRequest.safeParse({ ...ok, ...b }).success, JSON.stringify(b)).toBe(false);
    // 3 emoji = 6 UTF-16 units but 3 code points: satisfies the DB CHECK (char_length >= 3) too
    expect(SubmitChangeRequest.safeParse({ ...ok, reason: '😀😀😀' }).success).toBe(true);
    // 2 emoji = 4 UTF-16 units but only 2 code points → must be rejected here, not by Postgres as a 500
    expect(SubmitChangeRequest.safeParse({ ...ok, reason: '😀😀' }).success).toBe(false);
  });
  it('baseVersion is optional but never an empty string (MC-BR-7: empty must not switch the stale check off)', () => {
    const ok = { targetType: 'BLACKLIST_ENTRY', action: 'UPDATE', targetId: 'REG1', payload: {}, reason: 'Шалтгаан' };
    expect(SubmitChangeRequest.safeParse(ok).success).toBe(true);
    expect(SubmitChangeRequest.safeParse({ ...ok, baseVersion: '7' }).success).toBe(true);
    expect(SubmitChangeRequest.safeParse({ ...ok, baseVersion: '' }).success).toBe(false);
    expect(SubmitChangeRequest.safeParse({ ...ok, baseVersion: '   ' }).success).toBe(false);
  });
  it('RejectChangeRequest needs a real comment', () => {
    expect(RejectChangeRequest.safeParse({ comment: 'Дутуу' }).success).toBe(true);
    expect(RejectChangeRequest.safeParse({ comment: ' a ' }).success).toBe(false);
    expect(RejectChangeRequest.safeParse({}).success).toBe(false);
    expect(RejectChangeRequest.safeParse({ comment: '😀😀' }).success).toBe(false);
    expect(RejectChangeRequest.safeParse({ comment: 'ab\u0000c' }).success).toBe(false);
  });
  it('checker roles come from the shared UserRole enum (no private copy)', () => {
    const ok = { targetType: 'X_Y', action: 'UPDATE', enabled: true, expiresInHours: 24 };
    for (const r of UserRole) expect(MakerCheckerPolicy.safeParse({ ...ok, checkerRoles: [r] }).success, r).toBe(true);
  });
  it('ListChangeRequestsQuery applies defaults, coerces numbers, restricts pageSize to 10/20/50/100', () => {
    expect(ListChangeRequestsQuery.parse({})).toMatchObject({ scope: 'inbox', page: 1, pageSize: 20 });
    expect(ListChangeRequestsQuery.parse({ page: '3', pageSize: '50', scope: 'mine' })).toMatchObject({ page: 3, pageSize: 50, scope: 'mine' });
    expect(ListChangeRequestsQuery.safeParse({ pageSize: '7' }).success).toBe(false);
    expect(ListChangeRequestsQuery.safeParse({ page: '0' }).success).toBe(false);
    expect(ListChangeRequestsQuery.safeParse({ scope: 'everything' }).success).toBe(false);
  });
  it('MakerCheckerPolicy validates roles and TTL bounds', () => {
    const ok = { targetType: 'X_Y', action: 'UPDATE', enabled: true, checkerRoles: ['APPROVER'], expiresInHours: 24 };
    expect(MakerCheckerPolicy.safeParse(ok).success).toBe(true);
    for (const bad of [{ checkerRoles: [] }, { checkerRoles: ['GOD'] }, { expiresInHours: 0 }, { expiresInHours: 721 }, { expiresInHours: 1.5 }]) {
      expect(MakerCheckerPolicy.safeParse({ ...ok, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });
  it('events are part of the DomainEvent union (usable by the outbox / event bus)', () => {
    const submitted = { ...base, type: 'ChangeRequestSubmitted', ...ref, requiredCheckerRoles: ['APPROVER'], branchId: null, expiresAt: '2026-10-29T09:00:00.000Z' };
    const decided = { ...base, type: 'ChangeRequestDecided', ...ref, outcome: 'APPLIED', checkerId: 'c1' };
    expect(ChangeRequestSubmitted.safeParse(submitted).success).toBe(true);
    expect(ChangeRequestDecided.safeParse(decided).success).toBe(true);
    expect(DomainEvent.safeParse(submitted).success).toBe(true);
    expect(DomainEvent.safeParse(decided).success).toBe(true);
    expect(DomainEvent.safeParse({ ...decided, outcome: 'MAYBE' }).success).toBe(false);
    expect(DomainEvent.safeParse({ ...decided, version: 2 }).success).toBe(false);
  });
});
