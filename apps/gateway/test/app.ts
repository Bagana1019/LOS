import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { configureGateway } from '../src/configure';
import { PrismaService } from '../src/prisma.service';
import { TEST_SEED_PASSWORD } from './global-setup';

export const PASSWORD = TEST_SEED_PASSWORD;
export const HAS_DB = !!process.env.TEST_DATABASE_URL;

export async function createGateway(): Promise<{ app: INestApplication; prisma: PrismaService }> {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = mod.createNestApplication({ bodyParser: false });
  app.setGlobalPrefix('api');
  configureGateway(app);
  await app.init();
  return { app, prisma: app.get(PrismaService) };
}
