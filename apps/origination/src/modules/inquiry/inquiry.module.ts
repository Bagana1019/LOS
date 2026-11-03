import { Module } from '@nestjs/common';
import { BorrowerModule } from '../borrower/borrower.module';
import { InquiryController } from './inquiry.controller';
import { InquiryService } from './inquiry.service';
import { KYC_INQUIRY_PORT, createKycInquiryPort } from './ports/kyc-inquiry.port';

// Модуль 3 (FR-3): лавлагаа (wizard-ийн 2-р алхам). Өгөгдөл kyc-д; README.md.
// kyc-ийг портоор — тестэд `overrideProvider(KYC_INQUIRY_PORT)`. PrismaService/Clock/SharedModule нь AppModule-аас.
@Module({
  imports: [BorrowerModule],
  controllers: [InquiryController],
  providers: [InquiryService, { provide: KYC_INQUIRY_PORT, useFactory: () => createKycInquiryPort() }],
  exports: [InquiryService],
})
export class InquiryModule {}
