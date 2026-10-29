import { describe, expect, it } from 'vitest';
import { IntegrationNotConfiguredError } from '../../shared/integration-mode';
import { ChannelError, IntegrationNotImplementedError } from '../channel/channel-error';
import { MockSmsGateway } from './sms.mock';
import { createSmsGateway } from './sms.provider';
import { RealSmsGateway } from './sms.real';

describe('MockSmsGateway', () => {
  const msg = { to: '+97699112233', text: 'Сайн уу', reference: 'd-1' };

  it('тогтмол providerMessageId, outbox-д хадгална', async () => {
    const g = new MockSmsGateway();
    expect(await g.send(msg)).toEqual({ providerMessageId: 'mock-sms-1' });
    expect(await g.send({ ...msg, reference: 'd-2' })).toEqual({ providerMessageId: 'mock-sms-2' });
    expect(g.outbox).toEqual([
      { to: '+97699112233', text: 'Сайн уу', ref: 'd-1', providerMessageId: 'mock-sms-1' },
      { to: '+97699112233', text: 'Сайн уу', ref: 'd-2', providerMessageId: 'mock-sms-2' },
    ]);
  });

  it('failNext(n): дараагийн n илгээлт ChannelError, дараа нь хэвийн; бүтэлгүйтэл outbox-д орохгүй', async () => {
    const g = new MockSmsGateway();
    g.failNext(2, { retryable: true });
    for (let i = 0; i < 2; i++) {
      const err = await g.send(msg).catch((e) => e);
      expect(err).toBeInstanceOf(ChannelError);
      expect(err).toMatchObject({ code: 'PROVIDER_ERROR', retryable: true });
    }
    expect(g.outbox).toHaveLength(0);
    expect((await g.send(msg)).providerMessageId).toBe('mock-sms-1');
  });

  it('failNext retryable=false → INVALID_ADDRESS; code-ыг тодорхой зааж болно', async () => {
    const g = new MockSmsGateway();
    g.failNext(1, { retryable: false });
    g.failNext(1, { retryable: true, code: 'RATE_LIMITED' });
    await expect(g.send(msg)).rejects.toMatchObject({ code: 'INVALID_ADDRESS', retryable: false });
    await expect(g.send(msg)).rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true });
  });

  it('E.164 биш хаяг → INVALID_ADDRESS (дахин оролдохгүй)', async () => {
    const g = new MockSmsGateway();
    await expect(g.send({ ...msg, to: '99112233' })).rejects.toMatchObject({ code: 'INVALID_ADDRESS', retryable: false });
    await expect(g.send({ ...msg, to: '+85212345678' })).rejects.toMatchObject({ code: 'INVALID_ADDRESS', retryable: false });
  });

  it('reset', async () => {
    const g = new MockSmsGateway();
    await g.send(msg); g.failNext(1, { retryable: true }); g.reset();
    expect(g.outbox).toHaveLength(0);
    expect((await g.send(msg)).providerMessageId).toBe('mock-sms-1');
  });
});

describe('RealSmsGateway (skeleton)', () => {
  const msg = { to: '+97699112233', text: 'x', reference: 'd-1' };

  it('тохиргоо дутуу бол IntegrationNotConfiguredError, дутууг нэрлэнэ', async () => {
    const err = await new RealSmsGateway({}).send(msg).catch((e) => e);
    expect(err).toBeInstanceOf(IntegrationNotConfiguredError);
    expect(err.missing).toEqual(['SMS_API_URL', 'SMS_API_KEY', 'SMS_SENDER_ID']);
  });

  it('тохиргоо бүрэн байсан ч protocol зохиохгүй — монгол мессежтэй NotImplemented', async () => {
    const err = await new RealSmsGateway({ SMS_API_URL: 'https://sms.invalid', SMS_API_KEY: 'k', SMS_SENDER_ID: 'LOS' }).send(msg).catch((e) => e);
    expect(err).toBeInstanceOf(IntegrationNotImplementedError);
    expect(err.message).toMatch(/хэрэгжээгүй/);
    expect(err.message).not.toContain('99112233');
  });
});

describe('createSmsGateway', () => {
  it('анхдагч mock; INTEGRATION_MODE_SMS=real → Real', () => {
    expect(createSmsGateway({})).toBeInstanceOf(MockSmsGateway);
    expect(createSmsGateway({ INTEGRATION_MODE: 'real' })).toBeInstanceOf(RealSmsGateway);
    expect(createSmsGateway({ INTEGRATION_MODE: 'real', INTEGRATION_MODE_SMS: 'mock' })).toBeInstanceOf(MockSmsGateway);
    expect(() => createSmsGateway({ INTEGRATION_MODE: 'sandbox' })).toThrow();
  });
});
