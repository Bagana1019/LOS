import { describe, expect, it, vi } from 'vitest';
import type { DomainEvent } from '@los/contracts';
import { leaseDecided, makeLease, merchantStatusChanged } from '../contract-fixtures';
import { writeOutbox, type OutboxTx } from './outbox';

// writeOutbox-ийн нэгж тест (fake tx): бодит транзакцийн зан төлөв prisma.contract.test.ts-д.
function fakeTx() {
  const create = vi.fn().mockResolvedValue({});
  return { tx: { outbox: { create } } as unknown as OutboxTx, create };
}
const lease = makeLease({ merchantId: 'm', storeId: 's', planId: 'p' });

describe('writeOutbox', () => {
  it('does nothing for an empty batch', async () => {
    const { tx, create } = fakeTx();
    await writeOutbox(tx, []);
    expect(create).not.toHaveBeenCalled();
  });

  it('inserts every event with id = eventId, type and the event as payload', async () => {
    const { tx, create } = fakeTx();
    const events = [leaseDecided(lease), merchantStatusChanged('11111111-1111-4111-8111-111111111111')];
    await writeOutbox(tx, events);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls.map((c) => c[0])).toEqual(events.map((e) => ({ data: { id: e.eventId, type: e.type, payload: e } })));
  });

  it('drops fields outside the event contract so PII cannot reach the outbox', async () => {
    const { tx, create } = fakeTx();
    const polluted = { ...leaseDecided(lease), buyerPhone: '99112233' } as unknown as DomainEvent;
    await writeOutbox(tx, [polluted]);
    const payload = create.mock.calls[0]![0].data.payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty('buyerPhone');
    expect(payload).toMatchObject({ type: 'PosLeaseDecided', leaseId: lease.id });
  });

  it('rejects an event that violates the contract, naming the type and field but not the values', async () => {
    const { tx, create } = fakeTx();
    const bad = { ...leaseDecided(lease), decision: 'SECRET-VALUE' } as unknown as DomainEvent;
    const err = await writeOutbox(tx, [bad]).then(() => null, (e: unknown) => e as Error);
    expect(err?.message).toContain('PosLeaseDecided');
    expect(err?.message).toContain('decision');
    expect(err?.message).not.toContain('SECRET-VALUE');
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects an unknown event type', async () => {
    const { tx } = fakeTx();
    await expect(writeOutbox(tx, [{ type: 'Nope' } as unknown as DomainEvent])).rejects.toThrow(/Nope/);
  });
});
