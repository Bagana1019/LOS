import { Module } from '@nestjs/common';
import { LoansModule } from '../loans/loans.module';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({ imports: [LoansModule], controllers: [PaymentsController], providers: [PaymentsService] })
export class PaymentsModule {}
