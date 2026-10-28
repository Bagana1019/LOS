import { describe, expect, it, vi } from 'vitest';
import { auditDiff, recordAudit, sanitizeForAudit } from './audit';
import { buildEvent, enqueueOutbox } from './outbox';
import { consumeOnce, idempotentHandler } from './processed-events';

const ctx = { orgId: 'o1', userId: 'u1', correlationId: 'corr-1' };

describe('outbox', () => {
  it('buildEvent fills the common fields from the request context', () => {
    const e = buildEvent(ctx, 'ApplicationReturned', { applicationId: 'a1', levelNo: 2, comment: 'нэмэлт баримт' }, new Date('2026-10-28T10:00:00Z'));
    expect(e).toMatchObject({ type: 'ApplicationReturned', orgId: 'o1', actorId: 'u1', correlationId: 'corr-1', version: 1, occurredAt: '2026-10-28T10:00:00.000Z' });
    expect(e.eventId).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('enqueueOutbox writes the event id as the row id and validates the schema', async () => {
    const create = vi.fn(async () => ({}));
    const e = buildEvent(ctx, 'SettingsChanged', { key: 'br1.dti_max', productId: null });
    await enqueueOutbox({ outbox: { create } }, e);
    expect(create).toHaveBeenCalledWith({ data: { id: e.eventId, type: 'SettingsChanged', payload: e } });
    await expect(enqueueOutbox({ outbox: { create } }, { ...e, version: 2 } as never)).rejects.toThrow();
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('consumeOnce / idempotentHandler (CLAUDE.md §3.2.6)', () => {
  const event = buildEvent(ctx, 'SettingsChanged', { key: 'k', productId: null });
  function fakeDb() {
    const seen = new Set<string>();
    const db = {
      async $transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
        const added: string[] = [];
        const tx = { processedEvent: { create: async ({ data }: any) => { const k = `${data.consumer}:${data.eventId}`; if (seen.has(k)) throw Object.assign(new Error('dup'), { code: 'P2002' }); seen.add(k); added.push(k); } } };
        try { return await fn(tx); } catch (e) { added.forEach((k) => seen.delete(k)); throw e; }
      },
    };
    return db;
  }
  it('runs the handler once per (consumer, event)', async () => {
    const db = fakeDb(); const h = vi.fn(async () => {});
    expect(await consumeOnce(db, 'scoring', event, h)).toBe(true);
    expect(await consumeOnce(db, 'scoring', event, h)).toBe(false);
    expect(await consumeOnce(db, 'dwh-sync', event, h)).toBe(true);
    expect(h).toHaveBeenCalledTimes(2);
  });
  it('rolls the marker back when the handler fails so the bus can redeliver', async () => {
    const db = fakeDb(); let fail = true;
    const h = idempotentHandler(db, 'scoring', async () => { if (fail) throw new Error('boom'); });
    await expect(h(event)).rejects.toThrow('boom');
    fail = false;
    await expect(h(event)).resolves.toBeUndefined();
  });
});

describe('audit', () => {
  it('redacts secrets and personal identifiers but keeps the hash', () => {
    expect(sanitizeForAudit({ registerNo: 'УБ1', register_no_hash: 'h', accountNo: '5', passwordHash: 'x', amount: 5, d: new Date('2026-01-01T00:00:00Z') }))
      .toEqual({ registerNo: '[redacted]', register_no_hash: 'h', accountNo: '[redacted]', passwordHash: '[redacted]', amount: 5, d: '2026-01-01T00:00:00.000Z' });
  });
  it('recordAudit writes a sanitized row', async () => {
    const create = vi.fn(async () => ({}));
    await recordAudit({ auditLog: { create } }, { orgId: 'o1', entity: 'LoanApplication', entityId: 'a1', action: 'STATUS_CHANGED', actorId: 'u1', beforeJson: { status: 'DRAFT', token: 't' }, afterJson: { status: 'SUBMITTED' }, applicationId: 'a1' });
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ beforeJson: { status: 'DRAFT', token: '[redacted]' }, afterJson: { status: 'SUBMITTED' }, applicationId: 'a1', correlationId: null }) });
  });
  it('auditDiff keeps only changed fields', () => {
    expect(auditDiff({ a: 1, b: 2, c: { x: 1 } }, { a: 1, b: 3, c: { x: 1 }, d: 4 })).toEqual({ before: { b: 2, d: undefined }, after: { b: 3, d: 4 } });
  });
});
