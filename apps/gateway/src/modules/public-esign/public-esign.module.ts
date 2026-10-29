import { Module } from '@nestjs/common';
import { DmsProxyService } from './dms-proxy.service';
import { loadProxyConfig, PROXY_CONFIG, type ProxyConfig } from './esign-proxy.config';
import { PublicEsignController } from './public-esign.controller';
import { FixedWindowRateLimiter, RATE_LIMITER } from './rate-limiter';

/**
 * FR-11.4: зээлдэгчийн (JWT-гүй) public e-sign → dms `/api/public/esign/**`. Ажилтны proxy (`modules/proxy`) өөрчлөгдөөгүй;
 * энэ нь `/api/public/esign/**` замыг л эзэмшиж, глобал JwtAuthGuard-аас `@Public()`-ээр, ThrottlerGuard-аас `@SkipThrottle()`-ээр гарна.
 */
@Module({
  controllers: [PublicEsignController],
  providers: [
    { provide: PROXY_CONFIG, useFactory: () => loadProxyConfig() },
    {
      provide: RATE_LIMITER,
      inject: [PROXY_CONFIG],
      useFactory: (config: ProxyConfig) => new FixedWindowRateLimiter({ windowMs: config.rateWindowMs, maxKeys: config.rateMaxKeys }),
    },
    DmsProxyService,
  ],
})
export class PublicEsignModule {}
