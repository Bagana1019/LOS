import { PosLeaseAction, PosLeaseStatus, MerchantStatus } from '@los/contracts';
import { describe, expect, it } from 'vitest';
import { makeLease } from '../../../e2e/fixtures';
import { actionLabel, actorLabel, can, canCreateLeases, FLOW_STEP_KEYS, flowStepIndex, isTerminal, merchantStatusLabel, publicReasonLabel, STATUS_COLOR, statusLabel, TERMINAL_STATUSES, timelineActionLabel, MERCHANT_STATUS_COLOR } from './status';

describe('labels and colours', () => {
  it('every status has a label and a colour', () => {
    for (const s of PosLeaseStatus) {
      expect(statusLabel(s)).not.toContain('pos.status');
      expect(STATUS_COLOR[s]).toBeTruthy();
    }
    for (const s of MerchantStatus) {
      expect(merchantStatusLabel(s)).not.toContain('merchant.status');
      expect(MERCHANT_STATUS_COLOR[s]).toBeTruthy();
    }
    for (const a of PosLeaseAction) expect(actionLabel(a)).not.toContain('pos.action');
    expect(publicReasonLabel('AFFORDABILITY')).toContain('төлбөрийн чадамж');
  });
});

describe('can() follows the server-provided allowedActions only', () => {
  it('DRAFT with unverified consent offers SUBMIT, RESEND_CONSENT_OTP and CANCEL', () => {
    const lease = makeLease({ status: 'DRAFT' });
    expect(can(lease, 'RESEND_CONSENT_OTP')).toBe(true);
    expect(can(lease, 'CANCEL')).toBe(true);
    expect(can(lease, 'DELIVER')).toBe(false);
  });
  it('a consent-verified DRAFT no longer offers RESEND_CONSENT_OTP', () => {
    const lease = makeLease({ status: 'DRAFT', consentVerified: true });
    expect(can(lease, 'RESEND_CONSENT_OTP')).toBe(false);
    expect(can(lease, 'SUBMIT')).toBe(true);
  });
  it('terminal and REFERRED states', () => {
    expect(can(makeLease({ status: 'REFERRED' }), 'CANCEL')).toBe(true);
    expect(can(makeLease({ status: 'REFERRED' }), 'ACCEPT')).toBe(false);
    for (const status of ['DECLINED', 'DELIVERED', 'SETTLED', 'CANCELLED', 'EXPIRED'] as const) expect(makeLease({ status }).allowedActions).toEqual([]);
    // Хоосон allowedActions → юу ч хийж болохгүй (UI өөрөө таамаглахгүй)
    expect(can({ allowedActions: [] }, 'CANCEL')).toBe(false);
  });
});

describe('merchant status', () => {
  it('only ACTIVE merchants can create leases (POS-BR-10)', () => {
    expect(canCreateLeases('ACTIVE')).toBe(true);
    for (const s of ['PENDING', 'SUSPENDED', 'TERMINATED'] as const) expect(canCreateLeases(s)).toBe(false);
  });
  it('terminal statuses', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(['CANCELLED', 'DECLINED', 'EXPIRED', 'SETTLED']);
    expect(isTerminal('DECLINED')).toBe(true);
    expect(isTerminal('APPROVED')).toBe(false);
    expect(isTerminal('DELIVERED')).toBe(false);
  });
});

describe('guided flow step index', () => {
  it('maps each status to the active step', () => {
    expect(flowStepIndex('DRAFT')).toBe(2);
    expect(flowStepIndex('REFERRED')).toBe(3);
    expect(flowStepIndex('DECLINED')).toBe(3);
    expect(flowStepIndex('APPROVED')).toBe(3);
    expect(flowStepIndex('APPROVED', true)).toBe(4);
    expect(flowStepIndex('ACCEPTED')).toBe(5);
    expect(flowStepIndex('DELIVERED')).toBe(FLOW_STEP_KEYS.length);
    expect(flowStepIndex('SETTLED')).toBe(FLOW_STEP_KEYS.length);
    expect(flowStepIndex('CANCELLED')).toBe(3);
  });
  it('has 6 steps in the documented order', () => {
    expect(FLOW_STEP_KEYS).toHaveLength(6);
    expect(FLOW_STEP_KEYS[0]).toBe('pos.step.goods');
    expect(FLOW_STEP_KEYS[5]).toBe('pos.step.deliver');
  });
});

describe('timeline wording shows roles, never identities', () => {
  it('actorLabel keeps only the role word', () => {
    expect(actorLabel('SYSTEM')).toBe('Систем');
    expect(actorLabel('BUYER')).toBe('Худалдан авагч');
    expect(actorLabel('MERCHANT:u-1')).toBe('Мерчант');
    expect(actorLabel('LENDER:u-9')).toBe('Лизингийн байгууллага');
    expect(actorLabel('MERCHANT:u-1')).not.toContain('u-1');
    expect(actorLabel('something-else:42')).toBe(actorLabel(''));
  });
  it('timelineActionLabel falls back for unknown actions', () => {
    expect(timelineActionLabel('DELIVERED')).toBe('Бараа хүлээлгэн өгсөн');
    expect(timelineActionLabel('SOME_FUTURE_ACTION')).not.toContain('FUTURE');
  });
});
