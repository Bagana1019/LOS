import { Module } from '@nestjs/common';
import { CustomerDirectory } from '../borrower/customer-directory';
import { CollateralChecksService } from './collateral-checks.service';
import { CollateralController } from './collateral.controller';
import { CollateralDocumentService } from './collateral-document.service';
import { CollateralEventsSubscriber } from './collateral-events.subscriber';
import { CollateralGateService } from './collateral-gate.service';
import { CollateralTxService } from './collateral-tx.service';
import { CollateralValuationService } from './collateral-valuation.service';
import { CollateralService } from './collateral.service';
import { FILE_PORT, createFilePort } from './ports/file.port';
import { KYC_ASSETS_PORT, createKycAssetsPort } from './ports/kyc-assets.port';
import { VALUATION_PORT, createValuationPort } from './ports/valuation.port';

// Модуль 6 (FR-6, FR-14, G0): барьцаа, өмчлөл/ачаалал шалгалт, үнэлгээ, checklist, LTV, 5-р алхам. `docs/05-collateral-documents.md` §3, §6; README.md.
// Гадны сервис (kyc, valuation, dms) портоор — тестэд `overrideProvider(KYC_ASSETS_PORT | VALUATION_PORT | FILE_PORT)`.
// PrismaService (global PrismaModule), EVENT_BUS (EventsModule), Clock (CommonModule), ApplicationAccessService/DomainEvents/OrgSettings (SharedModule) нь AppModule-аас.
@Module({
  controllers: [CollateralController],
  providers: [
    CustomerDirectory,
    CollateralGateService,
    CollateralTxService,
    CollateralService,
    CollateralChecksService,
    CollateralValuationService,
    CollateralDocumentService,
    CollateralEventsSubscriber,
    { provide: KYC_ASSETS_PORT, useFactory: () => createKycAssetsPort() },
    { provide: VALUATION_PORT, useFactory: () => createValuationPort() },
    { provide: FILE_PORT, useFactory: () => createFilePort() },
  ],
  // Модуль 10 (илгээх, G1): CollateralGateService.evaluate-ээр G0, давхар барьцааг дахин шалгана
  exports: [CollateralGateService],
})
export class CollateralModule {}
