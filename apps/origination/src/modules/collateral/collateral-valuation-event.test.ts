import { describe, expect, it } from 'vitest';
import { decideValuationEvent, type ValuationCompletedEvent } from './collateral-valuation-event';

const T0 = new Date('2026-10-28T00:00:00.000Z');
const event = (over: Partial<ValuationCompletedEvent> = {}): ValuationCompletedEvent => ({
  eventId: '5f0b5f2e-6a86-4d3e-9c4f-0123456789ab', occurredAt: '2026-10-29T03:00:00.000Z', version: 1, orgId: 'org', actorId: 'u1', correlationId: 'corr', type: 'ValuationCompleted',
  collateralId: 'c1', applicationId: 'a1', marketValue: 30_000_000, collateralValue: 21_000_000, valuationId: 'v2', assetType: 'VEHICLE', source: 'INTERNAL', haircutRate: 0.7,
  valuedAt: '2026-10-29T03:00:00.000Z', validUntil: '2027-01-27T00:00:00.000Z', externalRequired: false, ...over,
});
const row = (over: Partial<Parameters<typeof decideValuationEvent>[0]> = {}) => ({ assetType: 'VEHICLE', valuationId: null, valuedAt: null, updatedAt: T0, ...over }) as Parameters<typeof decideValuationEvent>[0];

describe('decideValuationEvent', () => {
  it('шинэ үнэлгээг хэрэглэнэ: баганууд, дараагийн дахин үнэлгээ (valuedAt + интервал)', () => {
    const d = decideValuationEvent(row(), event(), 180);
    expect(d.apply).toBe(true);
    if (!d.apply) return;
    expect(d.columns).toMatchObject({ marketValue: 30_000_000, collateralValue: 21_000_000, haircutRate: 0.7, valuationId: 'v2', valuationSource: 'INTERNAL', externalValuationRequired: false, valuationOverrideReason: null });
    expect(d.columns.valuedAt.toISOString()).toBe('2026-10-29T03:00:00.000Z');
    expect(d.columns.valuationValidUntil?.toISOString()).toBe('2027-01-27T00:00:00.000Z');
    expect(d.columns.nextRevaluationAt.toISOString()).toBe('2027-04-27T00:00:00.000Z');
  });

  it('haircutRate байхгүй бол collateralValue/marketValue-аас тооцно; валидность null', () => {
    const d = decideValuationEvent(row(), event({ haircutRate: undefined, validUntil: null }), 180);
    expect(d.apply && d.columns.haircutRate).toBe(0.7);
    expect(d.apply && d.columns.valuationValidUntil).toBeNull();
    expect(decideValuationEvent(row(), event({ haircutRate: undefined, marketValue: 0 }), 180)).toEqual({ apply: false, reason: 'MISSING_FIELDS' });
  });

  it('valuedAt байхгүй бол occurredAt-ыг ашиглана', () => {
    const d = decideValuationEvent(row(), event({ valuedAt: undefined }), 180);
    expect(d.apply && d.columns.valuedAt.toISOString()).toBe('2026-10-29T03:00:00.000Z');
  });

  it.each([
    ['NO_VALUATION_ID', { valuationId: undefined }, {}],
    ['MISSING_FIELDS', { source: undefined }, {}],
    ['ASSET_MISMATCH', { assetType: 'LAND' }, {}],
    ['DUPLICATE', {}, { valuationId: 'v2', valuedAt: new Date('2026-10-29T03:00:00.000Z') }],
    ['OLDER', {}, { valuationId: 'v1', valuedAt: new Date('2026-10-29T03:00:00.000Z') }],
    ['OLDER', {}, { valuationId: 'v1', valuedAt: new Date('2026-11-01T00:00:00.000Z') }],
  ] as const)('%s -> хэрэглэхгүй', (reason, eventOver, rowOver) => {
    expect(decideValuationEvent(row(rowOver as never), event(eventOver as never), 180)).toEqual({ apply: false, reason });
  });

  it('SUPERSEDED: event үүссэний дараа барьцаа өөрчлөгдсөн (updatedAt > occurredAt)', () => {
    expect(decideValuationEvent(row({ updatedAt: new Date('2026-10-29T03:00:00.001Z') }), event(), 180)).toEqual({ apply: false, reason: 'SUPERSEDED' });
    // яг тэнцүү бол хэрэглэнэ
    expect(decideValuationEvent(row({ updatedAt: new Date('2026-10-29T03:00:00.000Z') }), event(), 180).apply).toBe(true);
  });
});
