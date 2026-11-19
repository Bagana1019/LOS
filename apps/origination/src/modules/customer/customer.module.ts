import { Module } from '@nestjs/common';
import { InternalHttpClient } from '@los/nest-common';
import { BlacklistModule } from '../blacklist/blacklist.module';
import { MakerCheckerModule } from '../maker-checker/maker-checker.module';
import { CustomerUpdateChangeHandler } from './customer-update.handler';
import { CustomerController } from './customer.controller';
import { CustomerService } from './customer.service';
import { KycXypLookup, XYP_LOOKUP } from './xyp-lookup';

@Module({
  imports: [BlacklistModule, MakerCheckerModule],
  controllers: [CustomerController],
  providers: [CustomerService, CustomerUpdateChangeHandler, { provide: XYP_LOOKUP, useFactory: () => new KycXypLookup(new InternalHttpClient()) }],
  exports: [CustomerService],
})
export class CustomerModule {}
