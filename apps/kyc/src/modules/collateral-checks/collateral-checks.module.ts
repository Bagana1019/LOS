import { Module } from '@nestjs/common';
import { EncumbranceIntegrationModule } from '../../integrations/encumbrance/encumbrance.module';
import { CollateralChecksController } from './collateral-checks.controller';
import { CollateralChecksService } from './collateral-checks.service';

// FR-6.6: барьцааны ачаалал шалгалт (ЗМС + ЭБ). FR-6.3/6.5-ын ХУР хөрөнгө, өмчлөгч нь `modules/xyp`-д (`/xyp/assets`, `/xyp/property`).
// `Clock` нь CommonModule-оос (global). Дэлгэрэнгүй: apps/kyc/README.md.
@Module({ imports: [EncumbranceIntegrationModule], controllers: [CollateralChecksController], providers: [CollateralChecksService] })
export class CollateralChecksModule {}
