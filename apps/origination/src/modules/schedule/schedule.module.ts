import { Module } from '@nestjs/common';
import { ApplicationModule } from '../application/application.module';
import { BsaModule } from '../bsa/bsa.module';
import { ScoreModule } from '../score/score.module';
import { ScheduleController } from './schedule.controller';
import { ScheduleService } from './schedule.service';

// FR-7 ЭТХ. ApplicationModule → төлвийн машин (lock), ScoreModule → `markStale` (FR-7.3).
@Module({ imports: [ApplicationModule, ScoreModule, BsaModule], controllers: [ScheduleController], providers: [ScheduleService], exports: [ScheduleService] })
export class ScheduleModule {}
