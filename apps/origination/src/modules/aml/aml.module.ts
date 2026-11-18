import { Module } from '@nestjs/common';
import { AmlGateService } from './aml-gate.service';
import { KYC_AML_PORT, createKycAmlPort } from './ports/kyc-aml.port';

// G1 AML хаалт (FR-3.4; docs/05-compliance-aml.md §5): origination → kyc `POST /aml/screen`. PrismaService/OrgSettings/Clock нь глобал модулиас.
// Тестэд `overrideProvider(KYC_AML_PORT)` → `testing/fake-kyc-aml.port.ts`. Комплаенсын шийдвэрлэх UI, AmlHitReviewed consumer байхгүй — илгээх бүрд kyc-ийн сүүлийн төлвийг шууд уншина.
@Module({
  providers: [AmlGateService, { provide: KYC_AML_PORT, useFactory: () => createKycAmlPort() }],
  exports: [AmlGateService],
})
export class AmlModule {}
