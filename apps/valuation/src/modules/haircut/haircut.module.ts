import { Module } from '@nestjs/common';
import { HaircutController } from './haircut.controller';
import { HaircutLookupService } from './haircut-lookup.service';
import { HaircutRepository } from './haircut.repository';
import { HaircutService } from './haircut.service';

// FR-14.2: haircut (бүтээгдэхүүн/хөрөнгийн төрлөөр). Админ API: /api/haircuts (settings:manage).
// HaircutLookupService нь барьцааны үнийн саналд (CollateralValuationModule) хэрэглэгдэнэ.
@Module({
  controllers: [HaircutController],
  providers: [HaircutRepository, HaircutService, HaircutLookupService],
  exports: [HaircutLookupService],
})
export class HaircutModule {}
