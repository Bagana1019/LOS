import { describe, expect, it } from 'vitest';
import { ProviderRejectedError, ProviderUnavailableError } from '../payment-provider/provider-errors';
import { createQPayClient } from './qpay.provider';
import { MockQPayClient } from './qpay.mock';
import { RealQPayClient } from './qpay.real';

const T0 = new Date('2026-10-28T02:00:00Z');
const req = { senderInvoiceNo: 'LOS-APP-00001-1', amount: 120_000.5, currency: 'MNT', description: 'Эргэн төлөлт', receiverCode: 'APP-00001', expiresAt: new Date('2026-10-28T03:00:00Z') };
const ref = (id: string) => ({ providerInvoiceId: id, senderInvoiceNo: req.senderInvoiceNo });

describe('MockQPayClient', () => {
  const c = () => new MockQPayClient({ now: () => T0 });

  it('invoice: deterministic ID, жинхэнэ PNG QR, deeplink-үүд, нууцгүй raw', async () => {
    const a = await c().createInvoice(req);
    const b = await c().createInvoice(req);
    expect(a.providerInvoiceId).toBe(b.providerInvoiceId);
    expect(a.providerInvoiceId).toMatch(/^qpaymock_[0-9a-f]{12}$/);
    expect(a.qrImage).toBe(b.qrImage);
    const png = Buffer.from(a.qrImage as string, 'base64');
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a'); // PNG signature
    expect(a.qrText).toContain(a.providerInvoiceId);
    expect(a.deeplinks.length).toBeGreaterThanOrEqual(3);
    expect(a.deeplinks[0]).toMatchObject({ name: 'Khan bank', link: expect.stringContaining('khanbank://') });
    expect(a.raw).toMatchObject({ mock: true, sender_invoice_no: req.senderInvoiceNo });
  });

  it('ижил senderInvoiceNo → ижил invoice (idempotent); өөр дүнтэй бол татгалзана', async () => {
    const client = c();
    const a = await client.createInvoice(req);
    expect(await client.createInvoice(req)).toBe(a);
    expect(client.invoiceCount()).toBe(1);
    await expect(client.createInvoice({ ...req, amount: 5 })).rejects.toMatchObject({ providerCode: 'SENDER_INVOICE_NO_DUPLICATED' });
  });

  it('MNT-ээс бусад валют, эерэг биш дүнг татгалзана', async () => {
    await expect(c().createInvoice({ ...req, currency: 'USD' })).rejects.toBeInstanceOf(ProviderRejectedError);
    await expect(c().createInvoice({ ...req, amount: 0 })).rejects.toMatchObject({ providerCode: 'INVALID_AMOUNT' });
  });

  it('simulatePayment → checkInvoice paid; нэг төлбөр, давхар simulate нь ижил төлбөр', async () => {
    const client = c();
    const inv = await client.createInvoice(req);
    expect(await client.checkInvoice(ref(inv.providerInvoiceId))).toEqual({ paid: false, payments: [] });
    const p1 = client.simulatePayment(inv.providerInvoiceId);
    const p2 = client.simulatePayment(inv.providerInvoiceId, { amount: 1 });
    expect(p2).toBe(p1);
    expect(p1).toMatchObject({ providerPaymentId: `${inv.providerInvoiceId}_P1`, amount: 120_000.5, currency: 'MNT', paidAt: T0 });
    const chk = await client.checkInvoice(ref(inv.providerInvoiceId));
    expect(chk.paid).toBe(true);
    expect(chk.payments).toEqual([p1]);
    expect(client.statusOf(inv.providerInvoiceId)).toBe('PAID');
  });

  it('simulatePayment: өөр дүн / цаг / төлөгч', async () => {
    const client = c();
    const inv = await client.createInvoice(req);
    const p = client.simulatePayment(inv.providerInvoiceId, { amount: 99, paidAt: new Date('2026-10-28T02:30:00Z'), payerName: 'А', payerAccount: '5011223344' });
    expect(p).toMatchObject({ amount: 99, payerName: 'А', payerAccount: '5011223344', paidAt: new Date('2026-10-28T02:30:00Z') });
  });

  it('cancel: OPEN → CANCELLED (идемпотент); цуцлагдсаныг төлөх боломжгүй; төлөгдсөнийг цуцлах боломжгүй', async () => {
    const client = c();
    const inv = await client.createInvoice(req);
    await client.cancelInvoice(ref(inv.providerInvoiceId));
    await client.cancelInvoice(ref(inv.providerInvoiceId));
    expect(client.statusOf(inv.providerInvoiceId)).toBe('CANCELLED');
    expect(() => client.simulatePayment(inv.providerInvoiceId)).toThrow(ProviderRejectedError);
    expect((await client.checkInvoice(ref(inv.providerInvoiceId))).paid).toBe(false);
    await client.cancelInvoice(ref('unknown')); // байхгүй = алдаагүй

    const inv2 = await client.createInvoice({ ...req, senderInvoiceNo: 'LOS-APP-00001-2' });
    client.simulatePayment(inv2.providerInvoiceId);
    await expect(client.cancelInvoice(ref(inv2.providerInvoiceId))).rejects.toMatchObject({ providerCode: 'INVOICE_PAID' });
  });

  it('үл мэдэгдэх invoice-ийг шалгахад INVOICE_NOTFOUND', async () => {
    await expect(c().checkInvoice(ref('nope'))).rejects.toMatchObject({ providerCode: 'INVOICE_NOTFOUND' });
    expect(() => c().simulatePayment('nope')).toThrow(ProviderRejectedError);
  });

  it('failNext: дараагийн дуудлага, method-оор, олон удаа', async () => {
    const client = c();
    client.failNext();
    await expect(client.createInvoice(req)).rejects.toBeInstanceOf(ProviderUnavailableError);
    const inv = await client.createInvoice(req);
    client.failNext({ method: 'checkInvoice', times: 2 });
    await expect(client.createInvoice({ ...req, senderInvoiceNo: 'LOS-APP-00001-9' })).resolves.toBeTruthy(); // create-д нөлөөлөхгүй
    await expect(client.checkInvoice(ref(inv.providerInvoiceId))).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(client.checkInvoice(ref(inv.providerInvoiceId))).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(client.checkInvoice(ref(inv.providerInvoiceId))).resolves.toBeTruthy();
    client.failNext({ error: new ProviderRejectedError('QPay', 'X') });
    await expect(client.cancelInvoice(ref(inv.providerInvoiceId))).rejects.toBeInstanceOf(ProviderRejectedError);
  });

  it('mock: available, mode=mock', () => {
    const client = c();
    expect(client.mode).toBe('mock');
    expect(client.provider).toBe('QPAY');
    expect(client.isAvailable()).toBe(true);
    expect(client.unavailableReason()).toBeNull();
  });

  it('provider factory: INTEGRATION_MODE_QPAY нь INTEGRATION_MODE-г дарна', () => {
    const clock = { now: () => T0 };
    expect(createQPayClient(clock, {})).toBeInstanceOf(MockQPayClient);
    expect(createQPayClient(clock, { INTEGRATION_MODE: 'real' })).toBeInstanceOf(RealQPayClient);
    expect(createQPayClient(clock, { INTEGRATION_MODE: 'real', INTEGRATION_MODE_QPAY: 'mock' })).toBeInstanceOf(MockQPayClient);
    expect(() => createQPayClient(clock, { INTEGRATION_MODE: 'live' })).toThrow();
  });
});
