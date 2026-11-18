import { Module } from '@nestjs/common';
import { AmlModule } from '../aml/aml.module';
import { DocumentModule } from '../document/document.module';
import { ApplicationController } from './application.controller';
import { ApplicationService } from './application.service';
import { DraftArchiveService } from './draft-archive.service';
import { ApplicationStateMachine } from './application-state-machine';
import { SubmitGateService } from './submit-gate.service';

// Модуль 2: хүсэлт ба төлвийн машин (FR-1, docs/01 §4). `ApplicationStateMachine` нь батлах урсгал (M10), олголт (M11)-д экспортлогдоно.
// G1 илгээх хаалт: заавал баримт (DocumentModule, FR-9.2) + AML (AmlModule, FR-3.4) — `SubmitGateService` (түгжээний гадна) + машин (түгжээн дотор).
@Module({
  imports: [DocumentModule, AmlModule],
  controllers: [ApplicationController],
  providers: [ApplicationService, ApplicationStateMachine, DraftArchiveService, SubmitGateService],
  exports: [ApplicationService, ApplicationStateMachine],
})
export class ApplicationModule {}
