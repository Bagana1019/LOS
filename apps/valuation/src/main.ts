import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { JsonLogger } from './common/json-logger';
async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: new JsonLogger() });
  app.setGlobalPrefix('api');
  await app.listen(process.env.VALUATION_PORT ?? 4004);
}
bootstrap();
