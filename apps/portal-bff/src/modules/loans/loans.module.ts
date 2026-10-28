import { Module } from '@nestjs/common';
import { LoanOwnershipService } from './loan-ownership.service';
import { LoansController } from './loans.controller';
import { LoansService } from './loans.service';

@Module({
  controllers: [LoansController],
  providers: [LoansService, LoanOwnershipService],
  exports: [LoanOwnershipService],
})
export class LoansModule {}
