import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { EventBus } from '@los/database';
import { CollateralEventsSubscriber, EVENT_GROUP, SUBSCRIBED_TYPES } from './collateral-events.subscriber';

Logger.overrideLogger(false);

const db = {} as never;
const valuation = { handleValuationCompleted: vi.fn() } as never;

describe('CollateralEventsSubscriber', () => {
  it('bus байхгүй (Redis-гүй орчин) бол алдаагүй чимээгүй алгасна', async () => {
    await expect(new CollateralEventsSubscriber(null, db, valuation).onApplicationBootstrap()).resolves.toBeUndefined();
  });

  it('consumer group = origination-collateral, зөвхөн ValuationCompleted сонсоно', async () => {
    const subscribe = vi.fn().mockResolvedValue(undefined);
    const bus = { subscribe, publish: vi.fn(), close: vi.fn() } as unknown as EventBus;
    await new CollateralEventsSubscriber(bus, db, valuation).onApplicationBootstrap();
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe.mock.calls[0]![0]).toBe('origination-collateral');
    expect(subscribe.mock.calls[0]![1]).toEqual(['ValuationCompleted']);
    expect(typeof subscribe.mock.calls[0]![2]).toBe('function');
    expect(EVENT_GROUP).toBe('origination-collateral');
    expect(SUBSCRIBED_TYPES).toEqual(['ValuationCompleted']);
  });

  it('bus-ийн subscribe алдаа бол bootstrap-ыг унагаана (чимээгүй залгихгүй)', async () => {
    const bus = { subscribe: vi.fn().mockRejectedValue(new Error('redis down')), publish: vi.fn(), close: vi.fn() } as unknown as EventBus;
    await expect(new CollateralEventsSubscriber(bus, db, valuation).onApplicationBootstrap()).rejects.toThrow('redis down');
  });
});
