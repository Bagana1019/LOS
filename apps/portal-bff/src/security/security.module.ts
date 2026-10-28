import { Global, Module } from '@nestjs/common';
import { IdempotencyService } from './idempotency.service';
import { RateLimitService } from './rate-limit.service';

@Global()
@Module({
  providers: [RateLimitService, IdempotencyService],
  exports: [RateLimitService, IdempotencyService],
})
export class SecurityModule {}
