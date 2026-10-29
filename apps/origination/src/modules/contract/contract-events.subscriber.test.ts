import { describe, expect, it, vi } from 'vitest';
import type { DomainEvent } from '@los/contracts';
import type { EventBus } from '@los/database';
import { getRequestContext } from '@los/nest-common';
import type { PrismaService } from '../../prisma.service';
import { ContractEventsSubscriber, EVENT_GROUP } from './contract-events.subscriber';
import { ContractSigningEventHandler } from './contract-signing.event-handler';
import { createHarness, signedEvent, silenceLogs } from './contract-signing.fixtures';

silenceLogs();

function fakeBus() {
  const subscribe = vi.fn<EventBus['subscribe']>().mockResolvedValue(undefined);
  const bus: EventBus = { publish: vi.fn(), subscribe, close: vi.fn() };
  return { bus, subscribe };
}

/** `processed_events`-ийг дуурайх: нэг (consumer, eventId) хоёр дахь удаа P2002 өгнө; handler унавал marker буцна (rollback). */
function fakeDb() {
  const processed = new Set<string>();
  const db = {
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const added: string[] = [];
      const tx = {
        processedEvent: {
          create: async ({ data }: { data: { consumer: string; eventId: string } }) => {
            const key = `${data.consumer}:${data.eventId}`;
            if (processed.has(key)) throw Object.assign(new Error('unique'), { code: 'P2002' });
            processed.add(key);
            added.push(key);
          },
        },
      };
      try {
        return await fn(tx);
      } catch (e) {
        for (const key of added) processed.delete(key);
        throw e;
      }
    },
  };
  return { db: db as unknown as PrismaService, processed };
}

describe('ContractEventsSubscriber', () => {
  it("bus байвал 'origination' group-д ContractSigned, ContractSigningFailed-д бүртгүүлж, handler рүү (системийн контекстоор) дамжуулна", async () => {
    const { bus, subscribe } = fakeBus();
    const handler = new ContractSigningEventHandler(createHarness().contracts);
    let seenCtx: ReturnType<typeof getRequestContext> = null;
    const handle = vi.spyOn(handler, 'handle').mockImplementation(async () => { seenCtx = getRequestContext(); });

    await new ContractEventsSubscriber(bus, fakeDb().db, handler).onApplicationBootstrap();

    expect(EVENT_GROUP).toBe('origination');
    expect(subscribe).toHaveBeenCalledTimes(1);
    const [group, types, callback] = subscribe.mock.calls[0]!;
    expect(group).toBe('origination');
    expect(types).toEqual(['ContractSigned', 'ContractSigningFailed']);

    const event = signedEvent('contract-1');
    await callback(event);
    expect(handle).toHaveBeenCalledWith(event);
    // аудитад correlationId, байгууллага event-ээс очно
    expect(seenCtx).toMatchObject({ orgId: 'org-1', correlationId: 'corr-1', userId: null });
  });

  it('давхар хүргэгдсэн event-ийг (ижил eventId) нэг л удаа боловсруулна', async () => {
    const { bus, subscribe } = fakeBus();
    const handler = new ContractSigningEventHandler(createHarness().contracts);
    const handle = vi.spyOn(handler, 'handle').mockResolvedValue(undefined);
    await new ContractEventsSubscriber(bus, fakeDb().db, handler).onApplicationBootstrap();
    const callback = subscribe.mock.calls[0]![2];

    const event: DomainEvent = signedEvent('c');
    await callback(event);
    await callback(event);
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('handler-ийн алдааг bus-д дамжуулж, marker-ийг буцаана (at-least-once дахин хүргэнэ)', async () => {
    const { bus, subscribe } = fakeBus();
    const { db, processed } = fakeDb();
    const handler = new ContractSigningEventHandler(createHarness().contracts);
    const handle = vi.spyOn(handler, 'handle').mockRejectedValueOnce(new Error('db down')).mockResolvedValue(undefined);
    await new ContractEventsSubscriber(bus, db, handler).onApplicationBootstrap();
    const callback = subscribe.mock.calls[0]![2];

    await expect(callback(signedEvent('c'))).rejects.toThrow('db down');
    expect(processed.size).toBe(0);
    await callback(signedEvent('c')); // дахин хүргэлт амжина
    expect(handle).toHaveBeenCalledTimes(2);
    expect(processed.size).toBe(1);
  });

  it('bus байхгүй (null) бол чимээгүй алгасаж, сервис асна', async () => {
    const handler = new ContractSigningEventHandler(createHarness().contracts);
    await expect(new ContractEventsSubscriber(null, fakeDb().db, handler).onApplicationBootstrap()).resolves.toBeUndefined();
  });

  it('subscribe өөрөө унавал bootstrap унана (чимээгүй алдаж гарын үсэг зурагдсан гэрээ олголтод нээгдэхгүй үлдэхээс сэргийлнэ)', async () => {
    const { bus, subscribe } = fakeBus();
    subscribe.mockRejectedValue(new Error('NOGROUP'));
    const handler = new ContractSigningEventHandler(createHarness().contracts);
    await expect(new ContractEventsSubscriber(bus, fakeDb().db, handler).onApplicationBootstrap()).rejects.toThrow('NOGROUP');
  });
});
