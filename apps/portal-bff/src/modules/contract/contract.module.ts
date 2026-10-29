import { Module } from '@nestjs/common';
import { LoansModule } from '../loans/loans.module';
import { ContractController } from './contract.controller';
import { ContractService } from './contract.service';

@Module({ imports: [LoansModule], controllers: [ContractController], providers: [ContractService] })
export class ContractModule {}
