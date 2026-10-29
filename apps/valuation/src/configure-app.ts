import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';

/** `POST /base-prices/import` takes up to 5000 items (≈ 0.9 MB of JSON); Express's 100 kB default would reject a real import. */
export const JSON_BODY_LIMIT = '2mb';

/** Shared by main.ts and the e2e tests so they run with the same HTTP settings. */
export function configureApp(app: INestApplication): void {
  (app as NestExpressApplication).useBodyParser('json', { limit: JSON_BODY_LIMIT });
}
