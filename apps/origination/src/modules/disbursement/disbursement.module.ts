import { Module } from '@nestjs/common';
import { bankGatewayProvider } from '../../integrations/bank-transfer/bank-transfer.provider';
import { coreLoanProvider } from '../../integrations/core-loan/core-loan.provider';
import { ApplicationModule } from '../application/application.module';
import { ErpSyncModule } from '../erp-sync/erp-sync.module';
import { NotificationModule } from '../notification/notification.module';
import { DisbursementController } from './disbursement.controller';
import { DisbursementReconcileSweeper } from './disbursement-reconcile.sweeper';
import { DisbursementService } from './disbursement.service';

// Модуль 11 (FR-12, G4/G5, BR-10). ApplicationModule → төлвийн машин; ErpSyncModule → олголтын ERP үйл явдал; Core/банк = INTEGRATION_MODE adapter.
// NotificationModule → F5-12: илгээх/буцаахад хонхны мэдэгдэл (төлвийн өөрчлөлттэй нэг транзакцид).
@Module({
  imports: [ApplicationModule, ErpSyncModule, NotificationModule],
  controllers: [DisbursementController],
  providers: [DisbursementService, DisbursementReconcileSweeper, coreLoanProvider, bankGatewayProvider],
  exports: [DisbursementService],
})
export class DisbursementModule {}
