import { PosLeaseStatus } from '@los/contracts';
import { describe, expect, it } from 'vitest';
import { makeLeaseRecord } from '../testing/records';
import { allowedActions, assertTransition, canTransition, effectiveStatus, isExpired, isTerminal, POS_LEASE_TRANSITIONS } from './lease-state';
import { DomainError } from './errors';

const now = new Date('2026-10-28T04:00:00.000Z');
const past = new Date(now.getTime() - 1);
const future = new Date(now.getTime() + 60_000);

// docs/05 §4 хүснэгт
const ALLOWED: Record<string, string[]> = {
  DRAFT: ['APPROVED', 'REFERRED', 'DECLINED', 'CANCELLED', 'EXPIRED'],
  REFERRED: ['APPROVED', 'DECLINED', 'CANCELLED', 'EXPIRED'],
  APPROVED: ['ACCEPTED', 'CANCELLED', 'EXPIRED'],
  DECLINED: [],
  ACCEPTED: ['DELIVERED', 'CANCELLED'],
  DELIVERED: ['SETTLED'],
  SETTLED: [],
  CANCELLED: [],
  EXPIRED: [],
};

describe('lease transition table', () => {
  it('matches docs/05 section 4 exactly', () => {
    for (const s of PosLeaseStatus) expect([...POS_LEASE_TRANSITIONS[s]].sort()).toEqual([...ALLOWED[s]].sort());
  });
  it.each(PosLeaseStatus.flatMap((from) => PosLeaseStatus.map((to) => [from, to] as const)))('%s -> %s', (from, to) => {
    const allowed = ALLOWED[from].includes(to);
    expect(canTransition(from, to)).toBe(allowed);
    if (allowed) expect(() => assertTransition(from, to)).not.toThrow();
    else {
      try {
        assertTransition(from, to);
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(DomainError);
        expect((e as DomainError).code).toBe('INVALID_TRANSITION');
        expect((e as DomainError).status).toBe(409);
        expect((e as DomainError).details).toEqual({ from, to });
      }
    }
  });
  it('isTerminal = no outgoing transitions', () => {
    expect(PosLeaseStatus.filter(isTerminal).sort()).toEqual(['CANCELLED', 'DECLINED', 'EXPIRED', 'SETTLED']);
  });
});

describe('effectiveStatus (lazy expiry)', () => {
  it.each(['DRAFT', 'REFERRED', 'APPROVED'] as const)('%s with expiresAt in the past is EXPIRED', (status) => {
    expect(effectiveStatus({ status, expiresAt: past }, now)).toBe('EXPIRED');
    expect(isExpired({ status, expiresAt: past }, now)).toBe(true);
  });
  it('expiresAt equal to now is not yet expired (strictly less)', () => {
    expect(effectiveStatus({ status: 'APPROVED', expiresAt: now }, now)).toBe('APPROVED');
  });
  it('null or future expiresAt keeps the stored status', () => {
    expect(effectiveStatus({ status: 'DRAFT', expiresAt: null }, now)).toBe('DRAFT');
    expect(effectiveStatus({ status: 'DRAFT', expiresAt: future }, now)).toBe('DRAFT');
  });
  it.each(['DECLINED', 'ACCEPTED', 'DELIVERED', 'SETTLED', 'CANCELLED', 'EXPIRED'] as const)('%s never expires lazily', (status) => {
    expect(effectiveStatus({ status, expiresAt: past }, now)).toBe(status);
  });
});

describe('allowedActions', () => {
  const lease = (status: (typeof PosLeaseStatus)[number], over = {}) => makeLeaseRecord({ status, expiresAt: future, ...over });
  it('DRAFT without consent: SUBMIT, RESEND_CONSENT_OTP, CANCEL', () => {
    expect(allowedActions(lease('DRAFT'), now)).toEqual(['SUBMIT', 'RESEND_CONSENT_OTP', 'CANCEL']);
  });
  it('DRAFT with consent verified has no RESEND_CONSENT_OTP', () => {
    expect(allowedActions(lease('DRAFT', { consentVerifiedAt: now }), now)).toEqual(['SUBMIT', 'CANCEL']);
  });
  it('REFERRED: CANCEL; APPROVED: REQUEST_ACCEPT_OTP, ACCEPT, CANCEL; ACCEPTED: DELIVER, CANCEL', () => {
    expect(allowedActions(lease('REFERRED'), now)).toEqual(['CANCEL']);
    expect(allowedActions(lease('APPROVED'), now)).toEqual(['REQUEST_ACCEPT_OTP', 'ACCEPT', 'CANCEL']);
    expect(allowedActions(lease('ACCEPTED', { expiresAt: null }), now)).toEqual(['DELIVER', 'CANCEL']);
  });
  it.each(['DECLINED', 'DELIVERED', 'SETTLED', 'CANCELLED', 'EXPIRED'] as const)('%s has no actions', (status) => {
    expect(allowedActions(lease(status, { expiresAt: null }), now)).toEqual([]);
  });
  it.each(['DRAFT', 'REFERRED', 'APPROVED'] as const)('an expired %s has no actions', (status) => {
    expect(allowedActions(lease(status, { expiresAt: past }), now)).toEqual([]);
  });
  it('merchant status refines the actions (POS-BR-10)', () => {
    expect(allowedActions(lease('ACCEPTED', { expiresAt: null }), now, 'SUSPENDED')).toEqual(['DELIVER', 'CANCEL']);
    expect(allowedActions(lease('APPROVED'), now, 'SUSPENDED')).toEqual(['CANCEL']);
    expect(allowedActions(lease('DRAFT'), now, 'SUSPENDED')).toEqual(['CANCEL']);
    expect(allowedActions(lease('ACCEPTED', { expiresAt: null }), now, 'TERMINATED')).toEqual([]);
    expect(allowedActions(lease('APPROVED'), now, 'PENDING')).toEqual([]);
    expect(allowedActions(lease('APPROVED'), now, 'ACTIVE')).toEqual(['REQUEST_ACCEPT_OTP', 'ACCEPT', 'CANCEL']);
  });
});
