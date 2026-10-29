import { PosLeaseCreate } from '@los/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '../domain/errors';
import { leaseBody, type Fixtures } from '../testing/fixtures';
import { FIXED_OTP } from '../testing/flow';
import { toContext } from '../testing/personas';
import { TestApp } from '../testing/test-app';
import { buildSearchFilter, canonicalJson, CONSENT_TEXT_VERSION, effectivePolicy } from './lease.service';

const hasher = { hash: (v: string) => `h(${v})` };

describe('canonicalJson', () => {
  it('is independent of key order and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: undefined } })).toBe(canonicalJson({ a: { c: undefined, d: [3, { x: 2, y: 1 }] }, b: 1 }));
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
  it('keeps array order and distinguishes values', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: '1' }));
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(undefined)).toBe('null');
    expect(canonicalJson('текст')).toBe('"текст"');
  });
});

describe('buildSearchFilter (POS-FR-8)', () => {
  it('full register number is searched by hash only (case-insensitive)', () => {
    expect(buildSearchFilter('УЕ90050600', hasher)).toEqual({ buyerRegisterHash: 'h(УЕ90050600)' });
    expect(buildSearchFilter(' уе90050600 ', hasher)).toEqual({ buyerRegisterHash: 'h(УЕ90050600)' });
  });
  it('4-8 digits are a phone suffix, text of 3+ chars is a lease number fragment', () => {
    expect(buildSearchFilter('1005', hasher)).toEqual({ buyerPhoneSuffix: '1005' });
    expect(buildSearchFilter('99111005', hasher)).toEqual({ buyerPhoneSuffix: '99111005' });
    expect(buildSearchFilter('POS-261028', hasher)).toEqual({ leaseNoLike: 'POS-261028' });
    expect(buildSearchFilter('123456789', hasher)).toEqual({ leaseNoLike: '123456789' });
  });
  it('too short or empty queries add no filter', () => {
    expect(buildSearchFilter(undefined, hasher)).toEqual({});
    expect(buildSearchFilter('   ', hasher)).toEqual({});
    expect(buildSearchFilter('ab', hasher)).toEqual({});
    expect(buildSearchFilter('12', hasher)).toEqual({});
    expect(buildSearchFilter('123', hasher)).toEqual({ leaseNoLike: '123' }); // 3 тэмдэгт — доод хязгаар
  });
});

describe('effectivePolicy', () => {
  it('applies defaults and ignores undefined overrides', () => {
    const base = effectivePolicy({});
    expect(effectivePolicy({ maxDti: undefined })).toEqual(base);
    expect(base.maxDti).toBeGreaterThan(0);
  });
  it('plan overrides win', () => {
    expect(effectivePolicy({ maxDti: 0.4 }).maxDti).toBe(0.4);
  });
  it('invalid overrides are rejected by the policy schema', () => {
    expect(() => effectivePolicy({ maxDti: 5 })).toThrow();
  });
});

describe('LeaseService (service level)', () => {
  let t: TestApp;
  let fx: Fixtures;
  let n = 0;
  const staff1 = () => toContext(t.personas(fx.merchantA.id).staff(fx.storeA1.id));
  const admin = () => toContext(t.personas(fx.merchantA.id).merchantAdmin());
  const lender = () => toContext(t.personas(fx.merchantA.id).lenderAdmin());
  const approver = () => toContext(t.personas(fx.merchantA.id).approver());
  const body = (digit = 0, over: Partial<Record<string, unknown>> = {}) => PosLeaseCreate.parse(leaseBody(fx.storeA1.id, digit, over, 300 + n++));
  const create = async (digit = 0, over: Partial<Record<string, unknown>> = {}) => (await t.services.leases.createLease(staff1(), `svc-key-${n++}-0001`, body(digit, over))).result.lease;

  beforeAll(async () => {
    t = await TestApp.create();
    fx = await t.fixtures();
  });
  afterAll(async () => { await t.close(); });

  it('runs the whole lifecycle and emits the events in order', async () => {
    const before = t.outbox.events.length;
    const draft = await create();
    expect(draft.status).toBe('DRAFT');
    const decided = await t.services.leases.submit(staff1(), draft.id, { otp: FIXED_OTP });
    expect(decided.status).toBe('APPROVED');
    t.clock.advanceSeconds(31);
    await t.services.leases.requestAcceptOtp(staff1(), draft.id);
    const accepted = await t.services.leases.accept(staff1(), draft.id, { otp: FIXED_OTP });
    expect(accepted.status).toBe('ACCEPTED');
    const delivered = await t.services.leases.deliver(staff1(), draft.id, { serialNo: 'SN-123' });
    expect(delivered.status).toBe('DELIVERED');
    const settled = await t.services.leases.settle(lender(), draft.id, { settlementRef: 'PAY-SVC-1' });
    expect(settled.status).toBe('SETTLED');
    expect(settled.review.settlementRef).toBe('PAY-SVC-1');
    const types = t.outbox.events.slice(before).map((e) => e.type);
    expect(types).toEqual(['PosLeaseDecided', 'PosLeaseAccepted', 'PosLeaseDelivered', 'PosLeaseSettled']);
    expect(settled.timeline.map((x) => x.action)).toEqual(['CREATED', 'CONSENT_VERIFIED', 'DECIDED', 'ACCEPTED', 'DELIVERED', 'SETTLED']);
    expect(CONSENT_TEXT_VERSION).toBe('POS-CONSENT-v1');
  });

  it('replays the same key and body without side effects and rejects a changed body', async () => {
    const input = body();
    const key = `svc-replay-${n++}-0001`;
    const first = await t.services.leases.createLease(staff1(), key, input);
    const sms = t.sms.sent.length;
    const second = await t.services.leases.createLease(staff1(), key, input);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.result.lease.id).toBe(first.result.lease.id);
    expect(t.sms.sent.length).toBe(sms);
    await expect(t.services.leases.createLease(staff1(), key, { ...input, termMonths: 6 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('two concurrent accepts: exactly one wins, the lease is accepted once and one event is emitted', async () => {
    const lease = await create();
    await t.services.leases.submit(staff1(), lease.id, { otp: FIXED_OTP });
    t.clock.advanceSeconds(31);
    await t.services.leases.requestAcceptOtp(staff1(), lease.id);
    const before = t.outbox.events.filter((e) => e.type === 'PosLeaseAccepted').length;
    const results = await Promise.allSettled([
      t.services.leases.accept(staff1(), lease.id, { otp: FIXED_OTP }),
      t.services.leases.accept(staff1(), lease.id, { otp: FIXED_OTP }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0].reason).toBeInstanceOf(DomainError);
    expect(['CONCURRENT_UPDATE', 'INVALID_TRANSITION', 'OTP_NOT_REQUESTED']).toContain((bad[0].reason as DomainError).code);
    expect(t.outbox.events.filter((e) => e.type === 'PosLeaseAccepted').length).toBe(before + 1);
    expect((await t.services.leases.getForMerchant(staff1(), lease.id)).status).toBe('ACCEPTED');
  });

  it('expireStale cancels overdue DRAFT and APPROVED leases once, emitting PosLeaseCancelled', async () => {
    const draft = await create();
    const approved = await create();
    await t.services.leases.submit(staff1(), approved.id, { otp: FIXED_OTP });
    const fresh = await create();
    t.clock.advanceMinutes(61); // DRAFT TTL 60 мин
    const cancelledBefore = t.outbox.events.filter((e) => e.type === 'PosLeaseCancelled').length;
    const expiredNow = await t.services.leases.expireStale();
    expect(expiredNow).toBeGreaterThanOrEqual(2);
    for (const l of [draft, approved, fresh]) expect((await t.services.leases.getForMerchant(staff1(), l.id)).status).toBe('EXPIRED');
    const events = t.outbox.events.filter((e) => e.type === 'PosLeaseCancelled');
    expect(events.length).toBe(cancelledBefore + expiredNow);
    expect(await t.services.leases.expireStale()).toBe(0); // давтан ажиллуулахад шинэ зүйл байхгүй
    expect(t.outbox.events.filter((e) => e.type === 'PosLeaseCancelled').length).toBe(events.length);
  });

  it('two concurrent expireStale runs expire each lease exactly once (loser is not counted, no duplicate event)', async () => {
    await create();
    await create();
    t.clock.advanceMinutes(61);
    const before = t.outbox.events.filter((e) => e.type === 'PosLeaseCancelled').length;
    const [a, b] = await Promise.all([t.services.leases.expireStale(), t.services.leases.expireStale()]);
    const after = t.outbox.events.filter((e) => e.type === 'PosLeaseCancelled').length;
    expect(a + b).toBe(after - before);
    expect(a + b).toBeGreaterThanOrEqual(2);
  });

  it('actions on an expired lease fail with OFFER_EXPIRED or INVALID_TRANSITION, never silently succeed', async () => {
    const lease = await create();
    await t.services.leases.submit(staff1(), lease.id, { otp: FIXED_OTP });
    t.clock.advanceHours(100);
    await expect(t.services.leases.requestAcceptOtp(staff1(), lease.id)).rejects.toBeInstanceOf(DomainError);
    await expect(t.services.leases.accept(staff1(), lease.id, { otp: FIXED_OTP })).rejects.toBeInstanceOf(DomainError);
    await expect(t.services.leases.deliver(staff1(), lease.id, {})).rejects.toBeInstanceOf(DomainError);
  });

  it('scope violations at the service level: no merchant, wrong role, foreign store', async () => {
    const noMerchant = { ...admin(), merchantId: null };
    await expect(t.services.leases.listForMerchant(noMerchant, { page: 1, pageSize: 20 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(t.services.leases.listForMerchant(lender(), { page: 1, pageSize: 20 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(t.services.leases.listForBackOffice(staff1(), { page: 1, pageSize: 20 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const staff2 = toContext(t.personas(fx.merchantA.id).staff(fx.storeA2.id, 'staff-2'));
    await expect(t.services.leases.createLease(staff2, `svc-key-${n++}-0001`, body())).rejects.toMatchObject({ code: 'STORE_SCOPE_VIOLATION' });
  });

  it('review: only REFERRED leases, comment is scrubbed, lender actor is recorded', async () => {
    const referred = await create(2);
    await t.services.leases.submit(staff1(), referred.id, { otp: FIXED_OTP });
    const view = await t.services.leases.getForBackOffice(lender(), referred.id);
    expect(view.status).toBe('REFERRED');
    await expect(t.services.leases.review(approver(), (await create()).id, { decision: 'APPROVE', comment: 'Батлах тайлбар' })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    const reviewed = await t.services.leases.review(approver(), referred.id, { decision: 'DECLINE', comment: 'Утас 99111005 дээр холбогдсон' });
    expect(reviewed.status).toBe('DECLINED');
    expect(reviewed.review.comment).toBe('Утас 99****05 дээр холбогдсон');
    expect(reviewed.timeline.at(-1)?.actor).toBe('LENDER:approver-1');
  });
});
