import { Module } from '@nestjs/common';
import { BasePriceController } from './base-price.controller';
import { BasePriceLookupService } from './base-price-lookup.service';
import { BasePriceRepository } from './base-price.repository';
import { BasePriceService } from './base-price.service';

// FR-14.1, FR-14.5: суурь үнийн сан (хувилбартай). Админ API: /api/base-prices (settings:manage).
// BasePriceLookupService нь барьцааны үнийн саналд (CollateralValuationModule) хэрэглэгдэнэ.
@Module({
  controllers: [BasePriceController],
  providers: [BasePriceRepository, BasePriceService, BasePriceLookupService],
  exports: [BasePriceLookupService],
})
export class BasePriceModule {}
