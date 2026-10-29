import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { DomainEvent } from '@los/contracts';
import { buildEvent, type EventBus } from '@los/database';
import { getRequestContext } from '@los/nest-common';
import type { PrismaService } from '../../prisma.service';
import { DocumentEventsSubscriber, EVENT_GROUP, SUBSCRIBED_TYPES } from './document-events.subscriber';
import type { ApplicationDocumentService } from './document.service';

Logger.overrideLogger(false);

const CTX = { orgId: 'org-1', userId: 'officer-1', correlationId: 'corr-7' };
const uploaded = (applicationId: string | null = 'app-1'): DomainEvent => buildEvent(CTX, 'DocumentUploaded', { documentId: 'd-1', applicationId, kind: 'id_card', checklistKey: 'id_card', relatedEntity: 'APPLICATION', relatedId: null, fileId: 'f-1' });
const removed = (): DomainEvent => buildEvent(CTX, 'DocumentRemoved', { documentId: 'd-1', applicationId: 'app-1', kind: 'id_card', checklistKey: 'id_card' });

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

const service = () => {
  const recomputeFromEvent = vi.fn().mockResolvedValue(undefined);
  return { documents: { recomputeFromEvent } as unknown as ApplicationDocumentService, recomputeFromEvent };
};

describe('DocumentEventsSubscriber', () => {
  it("DocumentUploaded, DocumentRemoved-д тусдаа group-ээр бүртгүүлнэ ('origination' group-ийг гэрээ/барьцааны subscriber ашигладаг тул залгилцахгүй)", async () => {
    const { bus, subscribe } = fakeBus();
    await new DocumentEventsSubscriber(bus, fakeDb().db, service().documents).onApplicationBootstrap();
    expect(subscribe).toHaveBeenCalledTimes(1);
    const [group, types] = subscribe.mock.calls[0]!;
    expect([group, types]).toEqual(['origination-documents', ['DocumentUploaded', 'DocumentRemoved']]);
    expect(EVENT_GROUP).not.toBe('origination');
    expect(SUBSCRIBED_TYPES).toEqual(types);
  });

  it('event бүрийг (системийн контекстоор, correlationId-тай) хүсэлтийн дахин тооцоолол руу дамжуулна', async () => {
    const { bus, subscribe } = fakeBus();
    const { documents, recomputeFromEvent } = service();
    let seenCtx: ReturnType<typeof getRequestContext> = null;
    recomputeFromEvent.mockImplementation(async () => { seenCtx = getRequestContext(); });
    await new DocumentEventsSubscriber(bus, fakeDb().db, documents).onApplicationBootstrap();
    const callback = subscribe.mock.calls[0]![2];

    const up = uploaded();
    await callback(up);
    await callback(removed());
    expect(recomputeFromEvent).toHaveBeenCalledTimes(2);
    expect(recomputeFromEvent).toHaveBeenNthCalledWith(1, up);
    expect(recomputeFromEvent.mock.calls[1]![0]).toMatchObject({ type: 'DocumentRemoved', applicationId: 'app-1' });
    expect(seenCtx).toMatchObject({ orgId: 'org-1', correlationId: 'corr-7', userId: null });
  });

  it('applicationId=null event-ийг ч дамжуулна (null-safe шийдвэр үйлчилгээнд): subscriber унахгүй', async () => {
    const { bus, subscribe } = fakeBus();
    const { documents, recomputeFromEvent } = service();
    await new DocumentEventsSubscriber(bus, fakeDb().db, documents).onApplicationBootstrap();
    await expect(subscribe.mock.calls[0]![2](uploaded(null))).resolves.toBeUndefined();
    expect(recomputeFromEvent).toHaveBeenCalledTimes(1);
  });

  it('төрөл нь хамааралгүй event (bus буруу чиглүүлсэн ч) үйлчилгээг дууддаггүй', async () => {
    const { bus, subscribe } = fakeBus();
    const { documents, recomputeFromEvent } = service();
    await new DocumentEventsSubscriber(bus, fakeDb().db, documents).onApplicationBootstrap();
    await subscribe.mock.calls[0]![2](buildEvent(CTX, 'SettingsChanged', { key: 'k', productId: null }));
    expect(recomputeFromEvent).not.toHaveBeenCalled();
  });

  it('давхар хүргэгдсэн event-ийг (ижил eventId) нэг л удаа боловсруулна', async () => {
    const { bus, subscribe } = fakeBus();
    const { documents, recomputeFromEvent } = service();
    await new DocumentEventsSubscriber(bus, fakeDb().db, documents).onApplicationBootstrap();
    const callback = subscribe.mock.calls[0]![2];
    const event = uploaded();
    await callback(event);
    await callback(event);
    await callback({ ...event }); // bus-аас дахин parse хийгдсэн хуулбар — ижил eventId
    expect(recomputeFromEvent).toHaveBeenCalledTimes(1);
    await callback(uploaded()); // өөр eventId
    expect(recomputeFromEvent).toHaveBeenCalledTimes(2);
  });

  it('үйлчилгээний алдааг bus-д дамжуулж, marker-ийг буцаана (at-least-once дахин хүргэнэ)', async () => {
    const { bus, subscribe } = fakeBus();
    const { db, processed } = fakeDb();
    const { documents, recomputeFromEvent } = service();
    recomputeFromEvent.mockRejectedValueOnce(new Error('dms down')).mockResolvedValue(undefined);
    await new DocumentEventsSubscriber(bus, db, documents).onApplicationBootstrap();
    const callback = subscribe.mock.calls[0]![2];
    const event = uploaded();

    await expect(callback(event)).rejects.toThrow('dms down');
    expect(processed.size).toBe(0);
    await callback(event); // дахин хүргэлт амжина
    expect(recomputeFromEvent).toHaveBeenCalledTimes(2);
    expect(processed.size).toBe(1);
  });

  it('bus байхгүй (null) бол чимээгүй алгасаж, сервис асна', async () => {
    await expect(new DocumentEventsSubscriber(null, fakeDb().db, service().documents).onApplicationBootstrap()).resolves.toBeUndefined();
  });

  it('subscribe өөрөө унавал bootstrap унана (чимээгүй алдвал 8-р алхам баримтын өөрчлөлтийг мэдэхгүй үлдэнэ)', async () => {
    const { bus, subscribe } = fakeBus();
    subscribe.mockRejectedValue(new Error('NOGROUP'));
    await expect(new DocumentEventsSubscriber(bus, fakeDb().db, service().documents).onApplicationBootstrap()).rejects.toThrow('NOGROUP');
  });
});
