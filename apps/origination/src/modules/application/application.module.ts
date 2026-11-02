import { Module } from '@nestjs/common';
import { ApplicationController } from './application.controller';
import { ApplicationService } from './application.service';
import { ApplicationStateMachine } from './application-state-machine';

// Модуль 2: хүсэлт ба төлвийн машин (FR-1, docs/01 §4). `ApplicationStateMachine` нь батлах урсгал (M10), олголт (M11)-д экспортлогдоно.
@Module({
  controllers: [ApplicationController],
  providers: [ApplicationService, ApplicationStateMachine],
  exports: [ApplicationService, ApplicationStateMachine],
})
export class ApplicationModule {}
