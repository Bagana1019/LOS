import { describe, expect, it } from 'vitest';
import { ev } from '../../test-utils/events';
import { decodeDwhEvent, DWH_SUBSCRIPTIONS } from './decode';

describe('decodeDwhEvent', () => {
  it('accepts a valid v1 event the DWH maps and returns the typed event', () => {
    const e = ev('ApplicationSubmitted', { applicationId: 'a1', amount: 1_000_000, productId: 'p1' });
    expect(decodeDwhEvent(e)).toEqual({ ok: true, event: e });
  });
  it('skips an unknown version without throwing (CLAUDE.md §3.2.5)', () => {
    const e = { ...ev('ApplicationSubmitted', { applicationId: 'a1', amount: 1, productId: 'p1' }), version: 2 };
    expect(decodeDwhEvent(e)).toEqual({ ok: false, reason: 'UNSUPPORTED_VERSION' });
  });
  it('skips valid catalog events that have no DWH target and unknown types', () => {
    expect(decodeDwhEvent(ev('SettingsChanged', { key: 'k', productId: null }))).toEqual({ ok: false, reason: 'UNHANDLED_TYPE' });
    expect(decodeDwhEvent({ ...ev('ApplicationSubmitted', { applicationId: 'a', amount: 1, productId: 'p' }), type: 'Nope' })).toEqual({ ok: false, reason: 'UNHANDLED_TYPE' });
  });
  it('rejects a handled type that violates its zod schema', () => {
    const { amount: _drop, ...broken } = ev('ApplicationSubmitted', { applicationId: 'a1', amount: 1, productId: 'p1' });
    expect(decodeDwhEvent(broken)).toEqual({ ok: false, reason: 'INVALID' });
  });
  it('rejects non-objects', () => {
    for (const raw of [null, undefined, 'x', 42, []]) expect(decodeDwhEvent(raw)).toEqual({ ok: false, reason: 'INVALID' });
  });
  it('subscribes each fact to its own dwh-sync-* group and covers every handled type exactly once', () => {
    const groups = DWH_SUBSCRIPTIONS.map((s) => s.group);
    expect(new Set(groups).size).toBe(groups.length);
    for (const g of groups) expect(g).toMatch(/^dwh-sync-[a-z]+$/);
    expect(DWH_SUBSCRIPTIONS.flatMap((s) => s.types).sort()).toEqual(
      ['ApplicationApproved', 'ApplicationReturned', 'ApplicationStatusChanged', 'ApplicationSubmitted', 'DisbursementApproved', 'ScoringCompleted', 'StatementImported'],
    );
  });
});
