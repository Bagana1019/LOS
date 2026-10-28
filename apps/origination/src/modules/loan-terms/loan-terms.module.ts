import { Module } from '@nestjs/common';
import { PricingController } from './pricing/pricing.controller';
import { PricingService } from './pricing/pricing.service';

// FR-5 Зээлийн нөхцөл. Одоогоор: эрсдэлд суурилсан үнэ тогтоолт (FR-5.5).
@Module({ controllers: [PricingController], providers: [PricingService], exports: [PricingService] })
export class LoanTermsModule {}
