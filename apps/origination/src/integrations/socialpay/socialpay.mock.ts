import type { PaymentDeeplink } from '@los/contracts';
import { CreateProviderInvoiceRequest } from '../payment-provider/payment-provider.port';
import { MockInvoiceProvider } from '../payment-provider/mock-invoice-provider';
import type { SocialPayClient } from './socialpay.client';

// Deterministic SocialPay mock. Бодит протоколыг таамаглаагүй — зөвхөн манай порт (createInvoice/checkInvoice/cancelInvoice)-ийн ёс.
export class MockSocialPayClient extends MockInvoiceProvider implements SocialPayClient {
  readonly provider = 'SOCIALPAY' as const;
  protected readonly idPrefix = 'socialpaymock';

  protected qrPayload(providerInvoiceId: string, req: CreateProviderInvoiceRequest): string {
    return `https://socialpay.mock/pay?invoice=${providerInvoiceId}&amount=${req.amount.toFixed(2)}`;
  }

  protected deeplinksFor(qrText: string): PaymentDeeplink[] {
    return [{ name: 'SocialPay', description: 'Голомт банкны SocialPay апп', logo: null, link: `socialpay-payment://mock?qr=${encodeURIComponent(qrText)}` }];
  }
}
