import { Logger, Module, type OnModuleInit } from '@nestjs/common';
import { smsGatewayProvider } from '../../integrations/sms/sms.provider';
import { PaymentModule } from '../payment/payment.module';
import { HttpDmsContractFiles, PORTAL_CONTRACT_FILES, PortalContractService } from './portal-contract.service';
import { PortalCustomersService } from './portal-customers.service';
import { PortalLoansService } from './portal-loans.service';
import { PortalPaymentsService } from './portal-payments.service';
import { PortalController } from './portal.controller';
import { assertPortalOrgConfig } from './portal.config';
import { PortalInternalGuard } from './portal.guard';

/**
 * H8: харилцагчийн өөртөө үйлчлэх портал (apps/portal-bff) — origination талын дотоод гэрээ `/api/internal/portal/*` (docs/05-portal-bff.md §6).
 * Төлбөр нь PaymentModule-ийн InvoiceService/ProviderRegistry-г (QPay/SocialPay mock|real) шууд ашиглана — тусдаа төлбөрийн логик байхгүй.
 */
@Module({
  imports: [PaymentModule],
  controllers: [PortalController],
  providers: [
    PortalInternalGuard, PortalCustomersService, PortalLoansService, PortalContractService, PortalPaymentsService,
    smsGatewayProvider,
    { provide: PORTAL_CONTRACT_FILES, useFactory: () => new HttpDmsContractFiles() },
  ],
})
export class PortalModule implements OnModuleInit {
  /** DEFAULT_ORG_ID-г эхлэхэд шалгана: production/real-д буруу бол app.init() унана (portal.config.ts). */
  onModuleInit(): void {
    const log = new Logger('PortalModule');
    assertPortalOrgConfig(process.env, (m) => log.warn(m));
  }
}
