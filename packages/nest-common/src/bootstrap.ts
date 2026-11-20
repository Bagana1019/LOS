import 'reflect-metadata';
import { type INestApplication, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { describeDbError } from '@los/database';
import { assertAuditHmacKey, assertAuditSealSchedule } from './auth/audit-hmac-key';
import { assertInternalAuthSecret } from './auth/internal-secret';
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
  /** `req.rawBody` (JSON/urlencoded-ийн илгээсэн байт) — provider webhook-ийн гарын үсгийг байтаар шалгахад (dms e-sign). */
  rawBody?: boolean;
  /** `audit_log` эзэмшигч (gateway, origination, kyc): production-д AUDIT_HMAC_KEY шалгана (audit seal). */
  auditSeal?: boolean;
  configure?: (app: INestApplication) => void | Promise<void>;
}

/** CLAUDE.md §6.4: `/api` угтвар, `GET /api/health`, JSON лог, graceful shutdown. */
export async function bootstrapService(opts: BootstrapOptions): Promise<INestApplication> {
  loadEnvFiles();
  assertInternalAuthSecret(); // H2: production-д нууцгүйгээр эхлэхгүй (NestFactory.create-ээс ӨМНӨ)
  if (opts.auditSeal) { assertAuditHmacKey(); assertAuditSealSchedule(); } // audit seal: production-д түлхүүр сул / seal чимээгүй унтарсан бол эхлэхгүй
  const logger = new JsonLogger(opts.service);
  let app: INestApplication | undefined;
  try {
    app = await NestFactory.create(opts.module, { bufferLogs: true, bodyParser: opts.bodyParser ?? true, rawBody: opts.rawBody, abortOnError: false });
    app.useLogger(logger);
    app.setGlobalPrefix('api');
    app.enableShutdownHooks();
    if (opts.cors) app.enableCors({ origin: opts.cors.origin, credentials: opts.cors.credentials ?? false });
    await opts.configure?.(app);
    const port = Number(process.env[opts.portEnv] ?? opts.defaultPort);
    await app.listen(port); // onModuleInit (PrismaService: connect retry, M8) энд ажиллана
    logger.log(`${opts.service} listening on :${port}`, 'Bootstrap');
    return app;
  } catch (err) {
    // M8: DB connect-ийн төсөв дууссан г.м — non-zero exit → orchestrator restart. Мессеж/stack хэвлэхгүй (connection string агуулж болно).
    logger.error(`${opts.service} failed to start: ${describeDbError(err)}`, undefined, 'Bootstrap');
    await app?.close().catch(() => undefined);
    return process.exit(1);
  }
}
