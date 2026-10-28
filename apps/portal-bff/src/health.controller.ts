import { Controller, Get } from '@nestjs/common';
import { Public } from './modules/auth/public.decorator';
import { SkipRateLimit } from './security/rate-limit.decorator';

@Controller('health')
export class HealthController {
  @Public()
  @SkipRateLimit()
  @Get()
  health() {
    return { service: 'portal-bff', ok: true };
  }
}
