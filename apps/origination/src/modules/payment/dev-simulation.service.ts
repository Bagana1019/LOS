import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { PaymentInvoiceView, PaymentSimulateRequest } from '@los/contracts';
import type { RequestContext } from '@los/contracts';
import { MockBankGateway } from '../../integrations/bank-transfer/bank-transfer.mock';
import { isSimulatable } from '../../integrations/payment-provider/payment-provider.port';
import { BankReconciliationService } from './bank-reconciliation.service';
import { InvoiceService } from './invoice.service';
import { withProvider } from './payment.errors';
import { toInvoiceView } from './payment.mapper';
import { actorOf } from './payment.service';
import { ProviderRegistry } from './provider-registry';

const notFound = () => new NotFoundException({ code: 'NOT_FOUND', message: 'Олдсонгүй' });

/** UI-н "Туршилтын төлөлт": mock ledger-т төлөгдсөн болгож, жинхэнэ callback / тулгалтын урсгалыг дуудна. Зөвхөн mock горим ба NODE_ENV≠production. */
@Injectable()
export class DevSimulationService {
  constructor(private readonly invoices: InvoiceService, private readonly registry: ProviderRegistry, private readonly reconciliation: BankReconciliationService) {}

  async simulate(ctx: RequestContext, dto: PaymentSimulateRequest): Promise<PaymentInvoiceView> {
    if (process.env.NODE_ENV === 'production') throw notFound();
    const invoice = await this.invoices.load(ctx.orgId, dto.invoiceId).catch(() => { throw notFound(); });
    const gatewayOrPort = invoice.provider === 'BANK_TRANSFER' ? this.registry.bank : this.registry.port(invoice.provider as 'QPAY' | 'SOCIALPAY');
    if (gatewayOrPort.mode !== 'mock') throw notFound();
    if (invoice.status !== 'PENDING') throw new ConflictException({ code: 'INVOICE_NOT_PENDING', message: 'Зөвхөн хүлээгдэж буй (PENDING) invoice-д туршилтын төлөлт хийнэ' });
    const amount = dto.amount ?? Number(invoice.amount);

    if (invoice.provider === 'BANK_TRANSFER') {
      const bank = this.registry.bank;
      if (!(bank instanceof MockBankGateway)) throw notFound();
      const account = await this.registry.collectionAccount(ctx.orgId);
      bank.pushIncoming({ amount, currency: invoice.currency, description: `Зээлийн төлбөр ${invoice.senderInvoiceNo}`, ...(account ? { bankCode: account.bankCode, accountNo: account.accountNo } : {}) });
      await this.reconciliation.reconcile(actorOf(ctx));
    } else {
      const port = this.registry.port(invoice.provider as 'QPAY' | 'SOCIALPAY');
      if (!isSimulatable(port) || !invoice.providerInvoiceId) throw notFound();
      await withProvider(async () => port.simulatePayment(invoice.providerInvoiceId as string, { amount }));
      await this.invoices.handleCallback(invoice.provider as 'QPAY' | 'SOCIALPAY', invoice.senderInvoiceNo);
    }
    return toInvoiceView(await this.invoices.load(ctx.orgId, invoice.id));
  }
}
