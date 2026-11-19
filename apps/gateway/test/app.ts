import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hasTestDatabase } from '@los/config/vitest/test-db.mjs';
import { AppModule } from '../src/app.module';
import { configureGateway } from '../src/configure';
import { PrismaService } from '../src/prisma.service';
import { TEST_SEED_PASSWORD } from './global-setup';

export const PASSWORD = TEST_SEED_PASSWORD;
/** Throws (before any connection) if TEST_DATABASE_URL / DATABASE_URL is not a database whose name ends with "test" (H7). */
export const HAS_DB = hasTestDatabase();

export async function createGateway(): Promise<{ app: INestApplication; prisma: PrismaService }> {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = mod.createNestApplication({ bodyParser: false });
  app.setGlobalPrefix('api');
  configureGateway(app);
  await app.init();
  return { app, prisma: app.get(PrismaService) };
}
