import 'reflect-metadata';
import { type INestApplication, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadEnvFiles } from './config';
import { JsonLogger } from './logging/json-logger';

export interface BootstrapOptions {
  service: string;
  module: Type<unknown>;
  portEnv: string;
  defaultPort: number;
  /** web → gateway л хөндлөнгийн (browser) дуудлагатай; бусад сервис CORS нээхгүй. */
  cors?: { origin: string[]; credentials?: boolean };
  /** Gateway: `false` — proxy-д body stream хэвээр дамжуулахын тулд парсерыг өөрөө route тус бүрт тавина. */
  bodyParser?: boolean;
  configure?: (app: INestApplication) => void | Promise<void>;
}

/** CLAUDE.md §6.4: `/api` угтвар, `GET /api/health`, JSON лог, graceful shutdown. */
export async function bootstrapService(opts: BootstrapOptions): Promise<INestApplication> {
  loadEnvFiles();
  const logger = new JsonLogger(opts.service);
  const app = await NestFactory.create(opts.module, { bufferLogs: true, bodyParser: opts.bodyParser ?? true });
  app.useLogger(logger);
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  if (opts.cors) app.enableCors({ origin: opts.cors.origin, credentials: opts.cors.credentials ?? false });
  await opts.configure?.(app);
  const port = Number(process.env[opts.portEnv] ?? opts.defaultPort);
  await app.listen(port);
  logger.log(`${opts.service} listening on :${port}`, 'Bootstrap');
  return app;
}
