import { Module } from '@nestjs/common';
import { InternalHttpClient } from '@los/nest-common';
import { BlacklistModule } from '../blacklist/blacklist.module';
import { CustomerController } from './customer.controller';
import { CustomerService } from './customer.service';
import { KycXypLookup, XYP_LOOKUP } from './xyp-lookup';

@Module({
  imports: [BlacklistModule],
  controllers: [CustomerController],
  providers: [CustomerService, { provide: XYP_LOOKUP, useFactory: () => new KycXypLookup(new InternalHttpClient()) }],
  exports: [CustomerService],
})
export class CustomerModule {}
