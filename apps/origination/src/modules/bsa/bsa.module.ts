import { Module } from '@nestjs/common';
import { IncomeModule } from '../income/income.module';
import { ScoreModule } from '../score/score.module';
import { BSA_SCORING_CLIENT, createBsaScoringClient } from './bsa-scoring.client';
import { BSA_REPORT_STORE, createBsaReportStore } from './bsa-report.store';
import { BsaController } from './bsa.controller';
import { BsaService } from './bsa.service';

// M12c — BSA ↔ LOS интеграци (INT-1, 4, 6, 9). PrismaService, SharedModule (ApplicationAccessService), Clock нь AppModule-аас.
// LoanTerms / Schedule модуль `BsaService.syncPayment`-ийг (INT-6) дууддаг тул export хийнэ. e2e тест BSA_SCORING_CLIENT, BSA_REPORT_STORE-ийг fake-ээр солино.
@Module({
  imports: [IncomeModule, ScoreModule],
  controllers: [BsaController],
  providers: [
    BsaService,
    { provide: BSA_SCORING_CLIENT, useFactory: () => createBsaScoringClient() },
    { provide: BSA_REPORT_STORE, useFactory: () => createBsaReportStore() },
  ],
  exports: [BsaService],
})
export class BsaModule {}
