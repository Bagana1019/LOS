import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemorySigningStore } from './memory-signing.store';
import { audit, createTestClock, newRequest, requestedEvent, signingStoreContract } from './signing-store.contract';

signingStoreContract('MemorySigningStore', {
  create: (clock) => {
    const store = new MemorySigningStore(clock);
    return { store, outbox: async () => store.outbox };
  },
});

describe('MemorySigningStore (тест тусгай)', () => {
  it('outbox/events getter нь хуулбар буцаана: өөрчилсөн ч store хувирахгүй', async () => {
    const { clock } = createTestClock();
    const store = new MemorySigningStore(clock);
    const input = newRequest();
    const event = requestedEvent(input);
    await store.create(input, { events: [event], audit: [audit('CREATED', clock())] });

    store.outbox[0].id = randomUUID();
    store.events.pop();

    expect(store.outbox).toHaveLength(1);
    expect(store.outbox[0].id).toBe(event.eventId);
    expect(store.events).toEqual([event]);
  });

  it('event нь JSON хэлбэрээр хадгалагдана (дуудагч объектыг дараа нь өөрчилсөн ч)', async () => {
    const { clock } = createTestClock();
    const store = new MemorySigningStore(clock);
    const input = newRequest();
    const event = requestedEvent(input);
    await store.create(input, { events: [event] });
    (event as { contractNo: string }).contractNo = 'TAMPERED';

    expect(store.events[0]).toMatchObject({ contractNo: 'ГЭР-2026-000123' });
  });
});
