import { Module } from '@nestjs/common';
import { BasePriceModule } from '../base-price/base-price.module';
import { HaircutModule } from '../haircut/haircut.module';
import { ValuationModule } from '../valuation/valuation.module';
import { COLLATERAL_PRICING_SETTINGS } from './collateral-pricing-settings.port';
import { CollateralSuggestionService } from './collateral-suggestion.service';
import { CollateralValuationController } from './collateral-valuation.controller';
import { CollateralValuationRepository } from './collateral-valuation.repository';
import { CollateralValuationService } from './collateral-valuation.service';
import { DemoCollateralPricing } from './demo-collateral-pricing';

// FR-14.1–14.3, FR-14.6: барьцааны үнийн санал, хадгалалт, гадны үнэлгээ, түүх. Needs CommonModule (Clock, auth guard, error filter),
// PrismaModule and EventsModule (outbox relay) from the AppModule. ValuationModule exports the vehicle auto-valuation we reuse.
// COLLATERAL_PRICING_SETTINGS: swap DemoCollateralPricing here for the real settings source (see README, "DEMO parameters").
@Module({
  imports: [ValuationModule, BasePriceModule, HaircutModule],
  controllers: [CollateralValuationController],
  providers: [
    CollateralSuggestionService,
    CollateralValuationService,
    CollateralValuationRepository,
    { provide: COLLATERAL_PRICING_SETTINGS, useClass: DemoCollateralPricing },
  ],
})
export class CollateralValuationModule {}
