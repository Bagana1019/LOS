import nodemailer from 'nodemailer';
import { describe, expect, it, vi } from 'vitest';
import { IntegrationNotConfiguredError } from '../../shared/integration-mode';
import { ChannelError } from '../channel/channel-error';
import { MockEmailGateway } from './email.mock';
import { createEmailGateway } from './email.provider';
import { classifySmtpError, RealEmailGateway } from './email.real';

describe('MockEmailGateway', () => {
  const msg = { to: 'bold@example.mn', subject: 'Гарчиг', text: 'Текст', html: '<p>Текст</p>', reference: 'd-1' };

  it('outbox, mock-email-<n>', async () => {
    const g = new MockEmailGateway();
    expect(await g.send(msg)).toEqual({ providerMessageId: 'mock-email-1' });
    expect(g.outbox[0]).toEqual({ to: 'bold@example.mn', subject: 'Гарчиг', text: 'Текст', html: '<p>Текст</p>', ref: 'd-1', providerMessageId: 'mock-email-1' });
  });

  it('failNext + буруу хаяг', async () => {
    const g = new MockEmailGateway();
    g.failNext(1, { retryable: true, code: 'TIMEOUT' });
    await expect(g.send(msg)).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true });
    await expect(g.send({ ...msg, to: 'bold' })).rejects.toMatchObject({ code: 'INVALID_ADDRESS', retryable: false });
    expect(g.outbox).toHaveLength(0);
  });
});

describe('RealEmailGateway (nodemailer)', () => {
  const msg = { to: 'bold@example.mn', subject: 'Гарчиг', text: 'Текст', html: '<p>Текст</p>', reference: 'delivery-77' };
  const env = { SMTP_HOST: 'smtp.example.mn', SMTP_PORT: '587', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'LOS <no-reply@example.mn>' };

  it('jsonTransport: from/to/subject/text/html зөв дамжина, messageId буцна (сүлжээ ашиглахгүй)', async () => {
    const inner = nodemailer.createTransport({ jsonTransport: true });
    const captured: string[] = [];
    const transport = { sendMail: async (o: Parameters<typeof inner.sendMail>[0]) => { const info = await inner.sendMail(o); captured.push(info.message as string); return info; } };
    const res = await new RealEmailGateway({ transport: transport as never, from: 'LOS <no-reply@example.mn>' }).send(msg);
    expect(res.providerMessageId).toBeTruthy();
    const json = JSON.parse(captured[0]);
    expect(json).toMatchObject({ subject: 'Гарчиг', text: 'Текст', html: '<p>Текст</p>', from: { address: 'no-reply@example.mn' }, to: [{ address: 'bold@example.mn' }] });
    expect(json.headers).toMatchObject({ 'X-LOS-Reference': 'delivery-77' });
  });

  it('inject хийсэн transport-д дуудагдах аргументууд', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: '<abc@example.mn>' });
    const g = new RealEmailGateway({ transport: { sendMail } as never, from: 'from@example.mn' });
    expect(await g.send(msg)).toEqual({ providerMessageId: '<abc@example.mn>' });
    expect(sendMail).toHaveBeenCalledWith({ from: 'from@example.mn', to: 'bold@example.mn', subject: 'Гарчиг', text: 'Текст', html: '<p>Текст</p>', headers: { 'X-LOS-Reference': 'delivery-77' } });
  });

  it('тохиргоо дутуу бол IntegrationNotConfiguredError (SMTP_SECURE заавал биш)', async () => {
    const err = await new RealEmailGateway({ env: { SMTP_HOST: 'h' } }).send(msg).catch((e) => e);
    expect(err).toBeInstanceOf(IntegrationNotConfiguredError);
    expect(err.missing).toEqual(['SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']);
  });

  it('env бүрэн бол SMTP transport үүсгэнэ; хүрэх боломжгүй хост → retryable сүлжээний алдаа', async () => {
    const g = new RealEmailGateway({ env: { ...env, SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', SMTP_SECURE: 'false' }, timeoutMs: 1500 });
    const err = await g.send(msg).catch((e) => e);
    expect(err).toBeInstanceOf(ChannelError);
    expect(err.retryable).toBe(true);
  });

  it('transport-ын алдааг ChannelError болгоно', async () => {
    const sendMail = vi.fn().mockRejectedValue(Object.assign(new Error('Mailbox unavailable'), { responseCode: 550 }));
    const err = await new RealEmailGateway({ transport: { sendMail } as never, from: 'f@example.mn' }).send(msg).catch((e) => e);
    expect(err).toMatchObject({ code: 'INVALID_ADDRESS', retryable: false });
    expect(err.message).not.toContain('bold@example.mn');
  });
});

describe('classifySmtpError (RFC 5321: 4yz түр, 5yz байнгын)', () => {
  const cls = (e: object) => { const c = classifySmtpError(e); return { code: c.code, retryable: c.retryable }; };
  it('4xx → дахин оролдоно', () => {
    expect(cls({ responseCode: 421 })).toEqual({ code: 'RATE_LIMITED', retryable: true });
    expect(cls({ responseCode: 452 })).toEqual({ code: 'RATE_LIMITED', retryable: true });
    expect(cls({ responseCode: 450 })).toEqual({ code: 'PROVIDER_ERROR', retryable: true });
    expect(cls({ responseCode: 451 })).toEqual({ code: 'PROVIDER_ERROR', retryable: true });
    expect(cls({ responseCode: 454 })).toEqual({ code: 'PROVIDER_ERROR', retryable: true });
  });
  it('5xx → байнгын (хаяг буруу бол INVALID_ADDRESS)', () => {
    for (const responseCode of [501, 550, 551, 553]) expect(cls({ responseCode })).toEqual({ code: 'INVALID_ADDRESS', retryable: false });
    expect(cls({ responseCode: 554 })).toEqual({ code: 'PROVIDER_ERROR', retryable: false });
    expect(cls({ responseCode: 535 })).toEqual({ code: 'PROVIDER_ERROR', retryable: false });
  });
  it('сүлжээ/timeout → retryable; EAUTH/EENVELOPE → байнгын', () => {
    expect(cls({ code: 'ETIMEDOUT' })).toEqual({ code: 'TIMEOUT', retryable: true });
    expect(cls({ code: 'ESOCKET' })).toEqual({ code: 'PROVIDER_ERROR', retryable: true });
    expect(cls({ code: 'ECONNECTION' })).toEqual({ code: 'PROVIDER_ERROR', retryable: true });
    expect(cls({ code: 'EDNS' })).toEqual({ code: 'PROVIDER_ERROR', retryable: true });
    expect(cls({ code: 'EAUTH' })).toEqual({ code: 'PROVIDER_ERROR', retryable: false });
    expect(cls({ code: 'EENVELOPE' })).toEqual({ code: 'INVALID_ADDRESS', retryable: false });
    expect(cls(new Error('boom'))).toEqual({ code: 'PROVIDER_ERROR', retryable: true });
    expect(classifySmtpError(undefined).retryable).toBe(true);
  });
});

describe('createEmailGateway', () => {
  it('анхдагч mock; real горимд RealEmailGateway', () => {
    expect(createEmailGateway({})).toBeInstanceOf(MockEmailGateway);
    expect(createEmailGateway({ INTEGRATION_MODE_EMAIL: 'real' })).toBeInstanceOf(RealEmailGateway);
  });
});
