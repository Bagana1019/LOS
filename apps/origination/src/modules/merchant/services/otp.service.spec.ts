import { createHmac } from 'crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadPosConfig, type PosConfig } from '../config/pos.config';
import { DomainError } from '../domain/errors';
import { MockSmsGateway } from '../integrations/sms/mock-sms.gateway';
import { OtpGenerator, SmsGateway } from '../ports';
import { createInMemoryPersistence } from '../persistence/memory/in-memory';
import { FakeClock } from '../testing/fake-clock';
import { makeLeaseRecord, makeMerchantRecord } from '../testing/records';
import { SequentialIdGenerator } from '../testing/sequential-id';
import { OtpService, otpSmsText } from './otp.service';
import type { RequestContext } from '../common/request-context';

class SequenceOtp extends OtpGenerator {
  private i = 0;
  constructor(private readonly codes: string[]) { super(); }
  next() { return this.codes[this.i++ % this.codes.length]; }
}
class FailingSms extends SmsGateway {
  constructor(private readonly error: unknown) { super(); }
  async send(): Promise<void> { throw this.error; }
}

const ctx: RequestContext = { userId: 'staff-1', roles: ['MERCHANT_STAFF'], orgId: 'org-test', branchId: null, merchantId: null, storeId: null, correlationId: 'c' };
const config = (over: Partial<PosConfig> = {}): PosConfig => ({ ...loadPosConfig({ NODE_ENV: 'test' }), ...over });

async function setup(opts: { codes?: string[]; sms?: SmsGateway; config?: Partial<PosConfig> } = {}) {
  const p = createInMemoryPersistence();
  const clock = new FakeClock();
  const sms = new MockSmsGateway();
  const merchant = makeMerchantRecord({ name: 'Тэмүүлэл Дижитал' });
  await p.merchants.createMerchant(merchant, []);
  const cfg = config(opts.config);
  const svc = new OtpService(p.otps, p.merchants, opts.sms ?? sms, new SequenceOtp(opts.codes ?? ['111111', '222222', '333333', '444444', '555555', '666666', '777777']), clock, new SequentialIdGenerator(), cfg);
  return { p, clock, sms, svc, cfg, lease: makeLeaseRecord({ merchantId: merchant.id, buyerPhone: '99112212' }) };
}
const code = (e: unknown) => (e as DomainError).code;
const failure = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as DomainError);

describe('OtpService.issue', () => {
  it('sends an SMS with merchant name, purpose sentence and validity, and stores only an HMAC hash', async () => {
    const { svc, sms, p, lease, clock, cfg } = await setup();
    const sent = await svc.issue(lease, 'CONSENT', ctx);
    expect(sent).toEqual({ purpose: 'CONSENT', phoneMasked: '99****12', expiresAt: '2026-10-28T04:05:00.000Z', resendAvailableAt: '2026-10-28T04:00:30.000Z' });
    expect(sms.sent).toHaveLength(1);
    const text = sms.sent[0].text;
    expect(sms.sent[0].to).toBe('99112212');
    expect(text).toContain('Тэмүүлэл Дижитал');
    expect(text).toContain('111111');
    expect(text).toContain('5 минут');
    expect(text).toContain('зээлийн мэдээллээ шалгуулж');
    const rec = await p.otps.latestOtp(lease.id, 'CONSENT');
    expect(rec?.codeHash).toBe(createHmac('sha256', cfg.otpSecret).update(`${lease.id}:CONSENT:111111`).digest('hex'));
    expect(JSON.stringify(rec)).not.toContain('111111');
    expect(rec?.sentToMasked).toBe('99****12');
    expect(rec?.sentAt).toEqual(clock.now());
    expect(rec?.attempts).toBe(0);
  });
  it('uses a different sentence for ACCEPT', async () => {
    const { svc, sms, lease } = await setup();
    await svc.issue(lease, 'ACCEPT', ctx);
    expect(sms.sent[0].text).toContain('нөхцөлийг хүлээн зөвшөөрч');
    expect(otpSmsText('M', 'CONSENT', '123456', 5)).not.toBe(otpSmsText('M', 'ACCEPT', '123456', 5));
  });
  it('enforces the resend cooldown per purpose and the latest code wins', async () => {
    const { svc, clock, lease, p } = await setup();
    await svc.issue(lease, 'CONSENT', ctx);
    clock.advanceSeconds(10);
    const err = await failure(svc.issue(lease, 'CONSENT', ctx));
    expect(code(err)).toBe('OTP_RESEND_TOO_SOON');
    expect(err?.details).toEqual({ retryAfterSeconds: 20 });
    expect(await p.otps.countOtps(lease.id)).toBe(1);
    await expect(svc.issue(lease, 'ACCEPT', ctx)).resolves.toMatchObject({ purpose: 'ACCEPT' }); // өөр зорилго — cooldown үгүй
    clock.advanceSeconds(20);
    await svc.issue(lease, 'CONSENT', ctx);
    expect(code(await failure(svc.verify(lease, 'CONSENT', '111111')))).toBe('OTP_INVALID'); // хуучин код хүчингүй
    await expect(svc.verify(lease, 'CONSENT', '333333')).resolves.toBeUndefined();
  });
  it('limits the number of codes sent per lease (default 5)', async () => {
    const { svc, clock, lease } = await setup();
    for (let i = 0; i < 5; i++) {
      await svc.issue(lease, 'CONSENT', ctx);
      clock.advanceSeconds(31);
    }
    const err = await failure(svc.issue(lease, 'CONSENT', ctx));
    expect(code(err)).toBe('OTP_ATTEMPTS_EXCEEDED');
    expect(err?.details).toMatchObject({ reason: 'MAX_SENDS', maxSends: 5 });
  });
  it('honours configured limits', async () => {
    const { svc, clock, lease } = await setup({ config: { otpMaxSends: 2, otpResendSeconds: 5, otpTtlSeconds: 60 } });
    const first = await svc.issue(lease, 'CONSENT', ctx);
    expect(first.expiresAt).toBe('2026-10-28T04:01:00.000Z');
    expect(first.resendAvailableAt).toBe('2026-10-28T04:00:05.000Z');
    clock.advanceSeconds(5);
    await svc.issue(lease, 'CONSENT', ctx);
    clock.advanceSeconds(5);
    expect(code(await failure(svc.issue(lease, 'CONSENT', ctx)))).toBe('OTP_ATTEMPTS_EXCEEDED');
  });
  it('maps SMS failures to SMS_UNAVAILABLE and leaves no record behind, so a retry works immediately', async () => {
    const { p, lease, clock } = await setup();
    for (const error of [new Error('connect ECONNREFUSED 99112212'), new DomainError('SMS_UNAVAILABLE', 'SMS operator is not configured')]) {
      const failing = (await setup({ sms: new FailingSms(error) })).svc;
      const err = await failure(failing.issue(lease, 'CONSENT', ctx));
      expect(code(err)).toBe('SMS_UNAVAILABLE');
      expect(err?.message).not.toContain('99112212');
    }
    expect(await p.otps.countOtps(lease.id)).toBe(0);
    void clock;
    const ok = await setup();
    await ok.svc.issue(ok.lease, 'CONSENT', ctx); // cooldown/тоолуур зарцуулагдаагүй
    expect(await ok.p.otps.countOtps(ok.lease.id)).toBe(1);
  });
});

describe('OtpService.verify', () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    s = await setup();
  });

  it('OTP_NOT_REQUESTED when no code was issued', async () => {
    expect(code(await failure(s.svc.verify(s.lease, 'CONSENT', '111111')))).toBe('OTP_NOT_REQUESTED');
  });
  it('accepts the correct code once and marks verifiedAt', async () => {
    await s.svc.issue(s.lease, 'CONSENT', ctx);
    s.clock.advanceSeconds(7);
    await s.svc.verify(s.lease, 'CONSENT', '111111');
    const rec = await s.p.otps.latestOtp(s.lease.id, 'CONSENT');
    expect(rec?.verifiedAt).toEqual(s.clock.now());
    expect(rec?.attempts).toBe(1);
  });
  it('a verified code cannot be reused', async () => {
    await s.svc.issue(s.lease, 'CONSENT', ctx);
    await s.svc.verify(s.lease, 'CONSENT', '111111');
    const err = await failure(s.svc.verify(s.lease, 'CONSENT', '111111'));
    expect(code(err)).toBe('OTP_NOT_REQUESTED');
    expect(err?.details).toEqual({ reason: 'ALREADY_USED' });
  });
  it('codes are bound to the purpose and the lease', async () => {
    await s.svc.issue(s.lease, 'CONSENT', ctx);
    expect(code(await failure(s.svc.verify(s.lease, 'ACCEPT', '111111')))).toBe('OTP_NOT_REQUESTED');
    const other = makeLeaseRecord({ id: '00000000-0000-4000-8000-0000000000ff' });
    expect(code(await failure(s.svc.verify(other, 'CONSENT', '111111')))).toBe('OTP_NOT_REQUESTED');
    expect(s.svc.hashCode(s.lease.id, 'CONSENT', '111111')).not.toBe(s.svc.hashCode(other.id, 'CONSENT', '111111'));
    expect(s.svc.hashCode(s.lease.id, 'CONSENT', '111111')).not.toBe(s.svc.hashCode(s.lease.id, 'ACCEPT', '111111'));
  });
  it('OTP_EXPIRED after the TTL (and a correct code no longer helps)', async () => {
    await s.svc.issue(s.lease, 'CONSENT', ctx);
    s.clock.advanceSeconds(299);
    await expect(s.svc.verify(s.lease, 'CONSENT', '111111')).resolves.toBeUndefined();
    await s.svc.issue(s.lease, 'ACCEPT', ctx);
    s.clock.advanceSeconds(300);
    expect(code(await failure(s.svc.verify(s.lease, 'ACCEPT', '222222')))).toBe('OTP_EXPIRED');
    const rec = await s.p.otps.latestOtp(s.lease.id, 'ACCEPT');
    expect(rec?.attempts).toBe(0); // хугацаа дууссан оролдлого тоологдохгүй
  });
  it('counts and persists every attempt before returning the result; exhausts after 3', async () => {
    await s.svc.issue(s.lease, 'CONSENT', ctx);
    const first = await failure(s.svc.verify(s.lease, 'CONSENT', '000000'));
    expect(code(first)).toBe('OTP_INVALID');
    expect(first?.details).toEqual({ attemptsLeft: 2 });
    expect((await s.p.otps.latestOtp(s.lease.id, 'CONSENT'))?.attempts).toBe(1); // алдаатай ч хадгалагдсан
    const second = await failure(s.svc.verify(s.lease, 'CONSENT', '000001'));
    expect(second?.details).toEqual({ attemptsLeft: 1 });
    const third = await failure(s.svc.verify(s.lease, 'CONSENT', '000002'));
    expect(code(third)).toBe('OTP_ATTEMPTS_EXCEEDED');
    expect((await s.p.otps.latestOtp(s.lease.id, 'CONSENT'))?.attempts).toBe(3);
    // Зөв код ч дахин ажиллахгүй, оролдлого нэмэгдэхгүй
    expect(code(await failure(s.svc.verify(s.lease, 'CONSENT', '111111')))).toBe('OTP_ATTEMPTS_EXCEEDED');
    expect((await s.p.otps.latestOtp(s.lease.id, 'CONSENT'))?.attempts).toBe(3);
  });
  it('parallel guessing cannot exceed the attempt limit (atomic counter)', async () => {
    await s.svc.issue(s.lease, 'CONSENT', ctx);
    const guesses = Array.from({ length: 10 }, (_, i) => `00000${i}`);
    const results = await Promise.all(guesses.map((g) => failure(s.svc.verify(s.lease, 'CONSENT', g))));
    expect(results.every((e) => ['OTP_INVALID', 'OTP_ATTEMPTS_EXCEEDED'].includes(code(e) ?? ''))).toBe(true);
    expect((await s.p.otps.latestOtp(s.lease.id, 'CONSENT'))?.attempts).toBe(3);
    expect(code(await failure(s.svc.verify(s.lease, 'CONSENT', '111111')))).toBe('OTP_ATTEMPTS_EXCEEDED');
  });
  it('two parallel correct submissions: exactly one wins', async () => {
    await s.svc.issue(s.lease, 'CONSENT', ctx);
    const outcomes = await Promise.all([failure(s.svc.verify(s.lease, 'CONSENT', '111111')), failure(s.svc.verify(s.lease, 'CONSENT', '111111'))]);
    expect(outcomes.filter((e) => e === null)).toHaveLength(1);
    expect(outcomes.filter((e) => e && code(e) === 'OTP_NOT_REQUESTED')).toHaveLength(1);
  });
  it('the third attempt may still succeed', async () => {
    await s.svc.issue(s.lease, 'CONSENT', ctx);
    await failure(s.svc.verify(s.lease, 'CONSENT', '000000'));
    await failure(s.svc.verify(s.lease, 'CONSENT', '000001'));
    await expect(s.svc.verify(s.lease, 'CONSENT', '111111')).resolves.toBeUndefined();
  });
  it('rejects wrong-length or non-hex garbage without throwing a non-domain error', async () => {
    await s.svc.issue(s.lease, 'CONSENT', ctx);
    for (const bad of ['', '1', '12345678901234567890', 'abcdef', '１２３４５６']) {
      const err = await failure(s.svc.verify(s.lease, 'CONSENT', bad));
      expect(err).toBeInstanceOf(DomainError);
      if (code(err) !== 'OTP_ATTEMPTS_EXCEEDED') expect(code(err)).toBe('OTP_INVALID');
    }
  });
  it('a different server secret cannot verify codes hashed with another one', async () => {
    await s.svc.issue(s.lease, 'CONSENT', ctx);
    const other = new OtpService(s.p.otps, s.p.merchants, s.sms, new SequenceOtp(['111111']), s.clock, new SequentialIdGenerator(), config({ otpSecret: 'a-completely-different-secret' }));
    expect(code(await failure(other.verify(s.lease, 'CONSENT', '111111')))).toBe('OTP_INVALID');
  });
});
