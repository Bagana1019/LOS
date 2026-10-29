import { describe, expect, it } from 'vitest';
import { IntegrationNotConfiguredError } from '../../shared/integration-mode';
import { IntegrationNotImplementedError } from '../channel/channel-error';
import { MockPushGateway } from './push.mock';
import { createPushGateway } from './push.provider';
import { RealPushGateway } from './push.real';

describe('MockPushGateway', () => {
  const msg = { token: 'token-aaaaaaaa', title: 'Гарчиг', body: 'Текст', data: { type: 'PAYMENT_DUE' }, reference: 'd-1' };

  it('outbox, mock-push-<n>', async () => {
    const g = new MockPushGateway();
    expect(await g.send(msg)).toEqual({ providerMessageId: 'mock-push-1' });
    expect(g.outbox).toEqual([{ token: 'token-aaaaaaaa', title: 'Гарчиг', body: 'Текст', data: { type: 'PAYMENT_DUE' }, ref: 'd-1', providerMessageId: 'mock-push-1' }]);
  });

  it('invalidateToken: тухайн токен INVALID_TOKEN (retryable=false), бусад хэвийн', async () => {
    const g = new MockPushGateway();
    g.invalidateToken('token-aaaaaaaa');
    await expect(g.send(msg)).rejects.toMatchObject({ code: 'INVALID_TOKEN', retryable: false });
    expect((await g.send({ ...msg, token: 'token-bbbbbbbb' })).providerMessageId).toBe('mock-push-1');
  });

  it('failNext', async () => {
    const g = new MockPushGateway();
    g.failNext(1, { retryable: true });
    g.failNext(1, { retryable: false });
    await expect(g.send(msg)).rejects.toMatchObject({ code: 'PROVIDER_ERROR', retryable: true });
    await expect(g.send(msg)).rejects.toMatchObject({ code: 'INVALID_TOKEN', retryable: false });
    expect(g.outbox).toHaveLength(0);
  });
});

describe('RealPushGateway (skeleton)', () => {
  const msg = { token: 'token-aaaaaaaa', title: 't', body: 'b', reference: 'd-1' };

  it('тохиргоо дутуу → IntegrationNotConfiguredError', async () => {
    const err = await new RealPushGateway({}).send(msg).catch((e) => e);
    expect(err).toBeInstanceOf(IntegrationNotConfiguredError);
    expect(err.missing).toEqual(['FCM_PROJECT_ID', 'FCM_SERVICE_ACCOUNT_JSON']);
  });

  it('тохиргоотой ч NotImplemented', async () => {
    const err = await new RealPushGateway({ FCM_PROJECT_ID: 'p', FCM_SERVICE_ACCOUNT_JSON: '{}' }).send(msg).catch((e) => e);
    expect(err).toBeInstanceOf(IntegrationNotImplementedError);
    expect(err.message).toMatch(/хэрэгжээгүй/);
  });
});

describe('createPushGateway', () => {
  it('анхдагч mock; real горим', () => {
    expect(createPushGateway({})).toBeInstanceOf(MockPushGateway);
    expect(createPushGateway({ INTEGRATION_MODE: 'real' })).toBeInstanceOf(RealPushGateway);
  });
});
