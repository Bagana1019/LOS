import { describe, expect, it } from 'vitest';
import { BadRequestException, HttpException } from '@nestjs/common';
import { IntegrationNotConfiguredError } from '../../shared/integration-mode';
import { ProviderNotImplementedError, ProviderRejectedError, ProviderUnavailableError } from '../../integrations/payment-provider/provider-errors';
import { safeLogText, toHttpError, withProvider } from './payment.errors';

const body = (e: unknown) => (e as HttpException).getResponse() as { code: string; message: string };

describe('toHttpError (бизнес дүрэм 7)', () => {
  it('ProviderUnavailableError → 502 PROVIDER_UNAVAILABLE, дотоод мессежийг дэлгэхгүй', () => {
    const e = toHttpError(new ProviderUnavailableError('QPay', 'secret internal: 10.0.0.5 timeout'));
    expect((e as HttpException).getStatus()).toBe(502);
    expect(body(e).code).toBe('PROVIDER_UNAVAILABLE');
    expect(body(e).message).not.toContain('10.0.0.5');
    expect(body(e).message).toContain('түр хүрэлцэхгүй');
  });

  it('IntegrationNotConfiguredError → 503 PROVIDER_NOT_CONFIGURED', () => {
    const e = toHttpError(new IntegrationNotConfiguredError('qpay', ['QPAY_USERNAME']));
    expect((e as HttpException).getStatus()).toBe(503);
    expect(body(e).code).toBe('PROVIDER_NOT_CONFIGURED');
    expect(body(e).message).not.toContain('QPAY_USERNAME');
  });

  it('ProviderNotImplementedError → 501', () => {
    const e = toHttpError(new ProviderNotImplementedError('SocialPay'));
    expect((e as HttpException).getStatus()).toBe(501);
    expect(body(e).code).toBe('PROVIDER_NOT_IMPLEMENTED');
  });

  it('ProviderRejectedError → 502 PROVIDER_REJECTED, провайдерын код гарахгүй', () => {
    const e = toHttpError(new ProviderRejectedError('QPay', 'INVOICE_CODE_INVALID'));
    expect((e as HttpException).getStatus()).toBe(502);
    expect(body(e).code).toBe('PROVIDER_REJECTED');
    expect(JSON.stringify(body(e))).not.toContain('INVOICE_CODE_INVALID');
  });

  it('HttpException болон үл мэдэгдэх алдаа хэвээр', () => {
    const http = new BadRequestException('x');
    expect(toHttpError(http)).toBe(http);
    const other = new Error('boom');
    expect(toHttpError(other)).toBe(other);
  });

  it('withProvider: амжилттай утга, алдааг хөрвүүлнэ', async () => {
    expect(await withProvider(async () => 5)).toBe(5);
    await expect(withProvider(async () => { throw new ProviderUnavailableError('QPay'); })).rejects.toBeInstanceOf(HttpException);
  });

  it('safeLogText: аюултай тэмдэгтийг орлуулж, урт хязгаарлана', () => {
    expect(safeLogText('LOS-APP-1\n<script>')).toBe('LOS-APP-1??script?');
    expect(safeLogText('x'.repeat(100))).toHaveLength(48);
  });
});
