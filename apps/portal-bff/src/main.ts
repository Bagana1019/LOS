import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { JsonLogger } from './common/json-logger';
import { loadConfig } from './config/portal.config';

async function bootstrap() {
  const cfg = loadConfig(); // буруу тохиргоотой бол энд унана
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: new JsonLogger(), bodyParser: true });
  configureApp(app, cfg);
  await app.listen(cfg.port);
}
bootstrap();
