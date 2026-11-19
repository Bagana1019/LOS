// LOW (C3): readiness = current ability to process (bus enabled + group subscribed; DWH reachability/schema are their own checks).
// Dead-lettered events and past handler failures are information (status endpoint), never "down".
import { describe, expect, it } from 'vitest';
import { ConsumerStatusRegistry } from './consumer-status';

describe('ConsumerStatusRegistry (health of each consumer group)', () => {
  it('is down before the group has subscribed', () => {
    const r = new ConsumerStatusRegistry();
    expect(() => r.assertHealthy('dwh-sync-application')).toThrow(/not subscribed/);
  });
  it('is up once subscribed', () => {
    const r = new ConsumerStatusRegistry();
    r.markSubscribed('dwh-sync-application');
    expect(() => r.assertHealthy('dwh-sync-application')).not.toThrow();
  });
  it('reports every group down when the event bus is disabled', () => {
    const r = new ConsumerStatusRegistry();
    r.markSubscribed('g');
    r.markBusDisabled();
    expect(() => r.assertHealthy('g')).toThrow(/event bus disabled/);
  });
  it('a dead-lettered event does not make the group down; it is counted as information', () => {
    const r = new ConsumerStatusRegistry();
    r.markSubscribed('g');
    r.recordDeadLetter('g'); r.recordDeadLetter('g');
    expect(() => r.assertHealthy('g')).not.toThrow();
    expect(r.snapshot()).toEqual({ busEnabled: true, groups: { g: { subscribed: true, deadLettered: 2, consecutiveFailures: 0 } } });
  });
  it('consecutive handler failures never stick readiness down; they are reported and reset on the next success', () => {
    const r = new ConsumerStatusRegistry();
    r.markSubscribed('g');
    for (let i = 0; i < 50; i++) r.recordFailure('g');
    expect(() => r.assertHealthy('g')).not.toThrow();
    expect(r.snapshot().groups.g).toMatchObject({ consecutiveFailures: 50 });
    r.recordSuccess('g');
    expect(r.snapshot().groups.g).toMatchObject({ consecutiveFailures: 0, deadLettered: 0 });
  });
  it('isolates groups from each other and snapshots are immutable copies', () => {
    const r = new ConsumerStatusRegistry();
    r.markSubscribed('a');
    r.recordDeadLetter('a');
    const snap = r.snapshot();
    r.recordDeadLetter('a');
    expect(snap.groups).toEqual({ a: { subscribed: true, deadLettered: 1, consecutiveFailures: 0 } });
    expect(() => r.assertHealthy('b')).toThrow(/not subscribed/);
    expect(r.snapshot().groups.a!.deadLettered).toBe(2);
  });
});
