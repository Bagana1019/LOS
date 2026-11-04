import { Module } from '@nestjs/common';
import { ApplicationModule } from '../application/application.module';
import { BsaModule } from '../bsa/bsa.module';
import { CollateralModule } from '../collateral/collateral.module';
import { ScoreModule } from '../score/score.module';
import { LoanTermsController } from './loan-terms.controller';
import { LoanTermsService } from './loan-terms.service';
import { PricingController } from './pricing/pricing.controller';
import { PricingService } from './pricing/pricing.service';

// FR-5 Зээлийн нөхцөл: нөхцөл хадгалах (FR-5.1…5.3) + эрсдэлд суурилсан үнэ тогтоолт (FR-5.5).
// ApplicationModule → төлвийн машин (lock), ScoreModule → `markStale` (FR-7.3).
@Module({
  imports: [ApplicationModule, ScoreModule, BsaModule, CollateralModule],
  controllers: [PricingController, LoanTermsController],
  providers: [PricingService, LoanTermsService],
  exports: [PricingService, LoanTermsService],
})
export class LoanTermsModule {}
