import { Module } from '@nestjs/common';
import { CREDIT_HISTORY } from './credit-history/credit-history.port';
import { createCreditHistory } from './credit-history/credit-history.provider';
import { ScoreController } from './score.controller';
import { ScoreEventsSubscriber } from './score-events.subscriber';
import { ScoreService } from './score.service';
import { ScoreInputAssembler } from './score-input.assembler';
import { SCORING_CLIENT, createScoringClient } from './scoring.client';

// Модуль 8 — Тооцоолол (A/B/C) ба Sosco Score-ийн origination фасад (FR-8, BR-1…BR-5). PrismaService, SharedModule (ApplicationAccessService, OrgSettings),
// Clock (CommonModule), EVENT_BUS (EventsModule) нь AppModule-аас. `ScoreService.markStale` нь Loan-terms / Schedule модульд зориулж export хийгдсэн.
@Module({
  controllers: [ScoreController],
  providers: [
    ScoreService,
    ScoreInputAssembler,
    ScoreEventsSubscriber,
    { provide: SCORING_CLIENT, useFactory: () => createScoringClient() },
    { provide: CREDIT_HISTORY, useFactory: () => createCreditHistory() },
  ],
  exports: [ScoreService],
})
export class ScoreModule {}
