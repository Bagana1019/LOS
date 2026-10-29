import { Module } from '@nestjs/common';
import { bankGatewayProvider } from '../../integrations/bank-transfer/bank-transfer.provider';
import { qpayClientProvider } from '../../integrations/qpay/qpay.provider';
import { socialPayClientProvider } from '../../integrations/socialpay/socialpay.provider';
import { BankAccountService } from './bank-account.service';
import { BankReconciliationService } from './bank-reconciliation.service';
import { CallbacksController } from './callbacks.controller';
import { DevSimulationService } from './dev-simulation.service';
import { InvoiceService } from './invoice.service';
import { PaymentController } from './payment.controller';
import { PaymentMaintenance } from './payment-maintenance.service';
import { PaymentService } from './payment.service';
import { ProviderRegistry } from './provider-registry';
import { RepaymentStatusService } from './repayment-status.service';

/**
 * Төлбөрийн интеграци: ЭТХ-ийн төлбөрийг QPay / SocialPay / банкны шилжүүлгээр цуглуулж, ЭТХ-ийн мөрүүдэд хуваарилна.
 * Шаардлага: FR-12.4 (нэр-дугаар тулгалт), NFR-2 (интеграци = interface + mock), NFR-4/5; CLAUDE.md §3.2.7.
 */
@Module({
  controllers: [PaymentController, CallbacksController],
  providers: [
    qpayClientProvider, socialPayClientProvider, bankGatewayProvider, ProviderRegistry,
    PaymentService, InvoiceService, RepaymentStatusService, BankReconciliationService, BankAccountService, DevSimulationService, PaymentMaintenance,
  ],
  exports: [PaymentService],
})
export class PaymentModule {}
