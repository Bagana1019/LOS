import { describe, expect, it } from 'vitest';
import { isSimulatable } from '../payment-provider/payment-provider.port';
import { IntegrationNotConfiguredError } from '../../shared/integration-mode';
import { ProviderNotImplementedError } from '../payment-provider/provider-errors';
import { createSocialPayClient } from './socialpay.provider';
import { MockSocialPayClient } from './socialpay.mock';
import { RealSocialPayClient } from './socialpay.real';

const T0 = new Date('2026-10-28T02:00:00Z');
const req = { senderInvoiceNo: 'LOS-APP-00001-1', amount: 50_000, currency: 'MNT', description: 'Эргэн төлөлт', receiverCode: 'APP-00001', expiresAt: new Date('2026-10-28T03:00:00Z') };

describe('MockSocialPayClient', () => {
  const c = () => new MockSocialPayClient({ now: () => T0 });

  it('invoice үүсгэнэ: deterministic ID, QR PNG, deeplink', async () => {
    const a = await c().createInvoice(req);
    const b = await c().createInvoice(req);
    expect(a.providerInvoiceId).toBe(b.providerInvoiceId);
    expect(a.providerInvoiceId.startsWith('socialpaymock_')).toBe(true);
    expect(a.qrImage).toBe(b.qrImage);
    expect(Buffer.from(a.qrImage as string, 'base64').subarray(1, 4).toString()).toBe('PNG');
    expect(a.deeplinks[0].link).toContain('socialpay-payment://');
    expect(isSimulatable(c())).toBe(true);
  });

  it('simulatePayment → checkInvoice paid; дараа нь cancel татгалзана', async () => {
    const client = c();
    const inv = await client.createInvoice(req);
    expect(await client.checkInvoice({ providerInvoiceId: inv.providerInvoiceId, senderInvoiceNo: req.senderInvoiceNo })).toEqual({ paid: false, payments: [] });
    const p = client.simulatePayment(inv.providerInvoiceId);
    expect(p).toMatchObject({ amount: 50_000, currency: 'MNT', paidAt: T0 });
    const chk = await client.checkInvoice({ providerInvoiceId: inv.providerInvoiceId, senderInvoiceNo: req.senderInvoiceNo });
    expect(chk.paid).toBe(true);
    expect(chk.payments).toHaveLength(1);
    await expect(client.cancelInvoice({ providerInvoiceId: inv.providerInvoiceId, senderInvoiceNo: req.senderInvoiceNo })).rejects.toMatchObject({ providerCode: 'INVOICE_PAID' });
  });
});

describe('RealSocialPayClient (skeleton)', () => {
  it('тохиргоо дутуу → IntegrationNotConfiguredError; бүрэн → NotImplemented; хэзээ ч available биш', async () => {
    const missing = new RealSocialPayClient({});
    expect(missing.isAvailable()).toBe(false);
    expect(missing.unavailableReason()).toBe('NOT_CONFIGURED');
    await expect(missing.createInvoice(req)).rejects.toBeInstanceOf(IntegrationNotConfiguredError);
    const env = { SOCIALPAY_BASE_URL: 'https://x', SOCIALPAY_MERCHANT_ID: 'm', SOCIALPAY_SECRET: 's', SOCIALPAY_CALLBACK_BASE_URL: 'https://cb' };
    const configured = new RealSocialPayClient(env);
    expect(configured.isAvailable()).toBe(false);
    expect(configured.unavailableReason()).toBe('NOT_IMPLEMENTED');
    const ref = { providerInvoiceId: 'x', senderInvoiceNo: 'y' };
    for (const call of [() => configured.createInvoice(req), () => configured.checkInvoice(ref), () => configured.cancelInvoice(ref)]) {
      const err = await call().catch((e) => e);
      expect(err).toBeInstanceOf(ProviderNotImplementedError);
      expect(err.message).toContain('хэрэгжээгүй');
    }
  });

  it('provider factory: INTEGRATION_MODE_SOCIALPAY', () => {
    const clock = { now: () => T0 };
    expect(createSocialPayClient(clock, {})).toBeInstanceOf(MockSocialPayClient);
    expect(createSocialPayClient(clock, { INTEGRATION_MODE: 'real' })).toBeInstanceOf(RealSocialPayClient);
  });
});
