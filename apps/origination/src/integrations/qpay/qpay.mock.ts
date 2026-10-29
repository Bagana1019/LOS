import type { PaymentDeeplink } from '@los/contracts';
import { CreateProviderInvoiceRequest } from '../payment-provider/payment-provider.port';
import { MockInvoiceProvider } from '../payment-provider/mock-invoice-provider';
import type { QPayClient } from './qpay.client';

// Deterministic QPay mock (CLAUDE.md §3.2.7): ID нь senderInvoiceNo-ийн хэшээс; QR нь qrcode багцаар жинхэнэ PNG.
const BANKS: Array<[string, string, string]> = [
  ['Khan bank', 'Хаан банк', 'khanbank'], ['State bank 3.0', 'Төрийн банк', 'statebank'], ['Xac bank', 'Хас банк', 'xacbank'],
  ['Golomt bank', 'Голомт банк', 'golomtbank'], ['TDB online', 'ХХБ', 'tdbbank'], ['Most money', 'МОСТ мони', 'mostmoney'],
];

export class MockQPayClient extends MockInvoiceProvider implements QPayClient {
  readonly provider = 'QPAY' as const;
  protected readonly idPrefix = 'qpaymock';

  protected qrPayload(providerInvoiceId: string, req: CreateProviderInvoiceRequest): string {
    return `https://qpay.mock/pay?invoice=${providerInvoiceId}&amount=${req.amount.toFixed(2)}`;
  }

  protected deeplinksFor(qrText: string): PaymentDeeplink[] {
    return BANKS.map(([name, description, scheme]) => ({ name, description, logo: `https://qpay.mock/logo/${scheme}.png`, link: `${scheme}://q?qPay_QRcode=${encodeURIComponent(qrText)}` }));
  }
}
