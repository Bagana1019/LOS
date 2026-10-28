import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { json } from 'express';
import helmet from 'helmet';

/**
 * main.ts ба тестэд ижил middleware. Body parser-ийг глобалаар унтрааж (bodyParser:false), зөвхөн /api/auth дээр JSON парсер тавина:
 * proxy-д body stream хэвээр (upload, том файл) дамжина.
 */
export function configureGateway(app: INestApplication): void {
  const a = app as NestExpressApplication;
  if (process.env.TRUST_PROXY) a.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
  a.disable('x-powered-by');
  a.use(helmet());
  a.use(cookieParser());
  a.use('/api/auth', json({ limit: '10kb' }));
}
