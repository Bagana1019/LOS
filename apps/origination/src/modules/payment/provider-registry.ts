import { Inject, Injectable } from '@nestjs/common';
import type { PaymentProviderInfo } from '@los/contracts';
import { OrgSettings } from '../../shared/org-settings';
import { BANK_GATEWAY } from '../../integrations/bank-transfer/bank-transfer.provider';
import type { BankGatewayPort } from '../../integrations/bank-transfer/bank-transfer.client';
import { MOCK_COLLECTION_ACCOUNT } from '../../integrations/bank-transfer/bank-transfer.mock';
import type { InvoiceProvider, PaymentProviderPort } from '../../integrations/payment-provider/payment-provider.port';
import { QPAY_CLIENT } from '../../integrations/qpay/qpay.provider';
import type { QPayClient } from '../../integrations/qpay/qpay.client';
import { SOCIALPAY_CLIENT } from '../../integrations/socialpay/socialpay.provider';
import type { SocialPayClient } from '../../integrations/socialpay/socialpay.client';

export interface CollectionAccount { bankCode: string; accountNo: string; accountName: string }

/** PaymentProvider → порт. QPay/SocialPay нь нийтлэг PaymentProviderPort, банкны шилжүүлэг нь BankGatewayPort. */
@Injectable()
export class ProviderRegistry {
  constructor(
    @Inject(QPAY_CLIENT) private readonly qpay: QPayClient,
    @Inject(SOCIALPAY_CLIENT) private readonly socialpay: SocialPayClient,
    @Inject(BANK_GATEWAY) readonly bank: BankGatewayPort,
    private readonly settings: OrgSettings,
  ) {}

  port(provider: InvoiceProvider): PaymentProviderPort { return provider === 'QPAY' ? this.qpay : this.socialpay; }

  /** Хүлээн авах данс: `payment.collection_account` setting; mock горимд тохируулаагүй бол mock данс. */
  async collectionAccount(orgId: string): Promise<CollectionAccount | null> {
    const configured = await this.settings.get(orgId, 'payment.collection_account');
    if (configured.bankCode && configured.accountNo) return { bankCode: configured.bankCode, accountNo: configured.accountNo, accountName: configured.accountName ?? '' };
    return this.bank.mode === 'mock' ? { ...MOCK_COLLECTION_ACCOUNT } : null;
  }

  async info(orgId: string): Promise<PaymentProviderInfo[]> {
    const fromPort = (p: PaymentProviderPort): PaymentProviderInfo => ({ provider: p.provider, enabled: p.isAvailable(), mode: p.mode, reason: p.isAvailable() ? null : p.unavailableReason() });
    const account = await this.collectionAccount(orgId);
    const bankAvailable = this.bank.isAvailable();
    return [
      fromPort(this.qpay), fromPort(this.socialpay),
      {
        provider: 'BANK_TRANSFER', mode: this.bank.mode, enabled: bankAvailable && !!account,
        reason: !bankAvailable ? this.bank.unavailableReason() : account ? null : 'ACCOUNT_MISSING',
      },
    ];
  }
}
