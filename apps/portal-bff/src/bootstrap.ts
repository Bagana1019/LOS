import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { requestContext } from './common/request-context.middleware';
import type { PortalConfig } from './config/portal.config';

/** main.ts болон e2e тест нэг ижил тохиргоотой апп-ыг ашиглана. */
export function configureApp(app: NestExpressApplication, cfg: PortalConfig): void {
  app.setGlobalPrefix('api');
  app.disable('x-powered-by');
  // LB/ingress ард ажиллаж буй hop-ийн тоо; буруу бол req.ip болон IP rate-limit бүгд хуурамч болно.
  app.set('trust proxy', cfg.trustProxy > 0 ? cfg.trustProxy : false);
  // Body parser-ээс өмнө: parser-ийн алдаа (буруу JSON, 413) ч correlationId, no-store толгойтой буцна.
  app.use(requestContext);
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.useBodyParser('json', { limit: '100kb' });
  app.enableCors({
    origin: cfg.cors.origins.length ? cfg.cors.origins : false,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Correlation-Id'],
    exposedHeaders: ['X-Correlation-Id', 'Idempotent-Replayed', 'Retry-After', 'Content-Disposition'],
    maxAge: 600,
  });
  app.enableShutdownHooks();
}
