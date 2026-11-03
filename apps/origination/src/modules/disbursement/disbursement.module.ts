import { Module } from '@nestjs/common';
import { bankGatewayProvider } from '../../integrations/bank-transfer/bank-transfer.provider';
import { coreLoanProvider } from '../../integrations/core-loan/core-loan.provider';
import { ApplicationModule } from '../application/application.module';
import { ErpSyncModule } from '../erp-sync/erp-sync.module';
import { DisbursementController } from './disbursement.controller';
import { DisbursementService } from './disbursement.service';

// Модуль 11 (FR-12, G4/G5, BR-10). ApplicationModule → төлвийн машин; ErpSyncModule → олголтын ERP үйл явдал; Core/банк = INTEGRATION_MODE adapter.
@Module({
  imports: [ApplicationModule, ErpSyncModule],
  controllers: [DisbursementController],
  providers: [DisbursementService, coreLoanProvider, bankGatewayProvider],
  exports: [DisbursementService],
})
export class DisbursementModule {}
