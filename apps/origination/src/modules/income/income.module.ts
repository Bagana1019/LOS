import { Module } from '@nestjs/common';
import { BorrowerModule } from '../borrower/borrower.module';
import { IncomeController } from './income.controller';
import { IncomeService } from './income.service';
import { KYC_NDSH_PORT, createKycNdshPort } from './ports/kyc-ndsh.port';

// Модуль 4 (FR-4, BSA-гүй хувилбар): орлого (wizard-ийн 3-р алхам). НДШ-ийг kyc-ээс портоор — тестэд `overrideProvider(KYC_NDSH_PORT)`. README.md.
// PrismaService/Clock/SharedModule нь AppModule-аас; CustomerDirectory-г BorrowerModule өгнө.
@Module({
  imports: [BorrowerModule],
  controllers: [IncomeController],
  providers: [IncomeService, { provide: KYC_NDSH_PORT, useFactory: () => createKycNdshPort() }],
  exports: [IncomeService],
})
export class IncomeModule {}
