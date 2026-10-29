import { Module } from '@nestjs/common';
import { BlacklistChecker } from './blacklist-checker';
import { BorrowerController } from './borrower.controller';
import { BorrowerService } from './borrower.service';
import { CustomerDirectory } from './customer-directory';

// Stream B: хамтран зээлдэгч ба батлан даагч (FR-2.1, FR-6.5, BR-9). Prisma/Common нь глобал модулиуд.
@Module({
  controllers: [BorrowerController],
  providers: [BorrowerService, CustomerDirectory, BlacklistChecker],
  exports: [BorrowerService, CustomerDirectory, BlacklistChecker],
})
export class BorrowerModule {}
