import { SetMetadata } from '@nestjs/common';

export interface RouteLimit {
  limit: number;
  windowSec: number;
}

export interface RateLimitOptions {
  ip?: RouteLimit;
  customer?: RouteLimit;
}

export const RATE_LIMIT_KEY = 'portal:rate-limit';
export const SKIP_RATE_LIMIT_KEY = 'portal:skip-rate-limit';

/** Маршрут тус бүрийн хязгаар. Заагаагүй бол глобал IP хязгаар үйлчилнэ. */
export const RateLimit = (opts: RateLimitOptions) => SetMetadata(RATE_LIMIT_KEY, opts);
export const SkipRateLimit = () => SetMetadata(SKIP_RATE_LIMIT_KEY, true);
