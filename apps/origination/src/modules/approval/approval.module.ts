import { Global, Module } from '@nestjs/common';
import { ApplicationModule } from '../application/application.module';
import { APPROVAL_FLOW } from '../application/approval-flow.port';
import { CollateralModule } from '../collateral/collateral.module';
import { NotificationModule } from '../notification/notification.module';
import { ApprovalController } from './approval.controller';
import { ApprovalService } from './approval.service';
import { ApprovalSlaSweeper } from './approval.sla-sweeper';
import { ContractNumberService } from './contract-number.service';

// Модуль 10: шийдвэр ба батлах урсгал (FR-10, BR-7, BR-8, BR-13, G1–G3). APPROVAL_FLOW токеныг глобал өгч ApplicationService-д холбоно.
@Global()
@Module({
  imports: [ApplicationModule, CollateralModule, NotificationModule],
  controllers: [ApprovalController],
  providers: [ApprovalService, ContractNumberService, ApprovalSlaSweeper, { provide: APPROVAL_FLOW, useExisting: ApprovalService }],
  exports: [ApprovalService, ContractNumberService, APPROVAL_FLOW],
})
export class ApprovalModule {}
