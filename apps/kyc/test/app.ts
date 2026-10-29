import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { CommonModule } from '@los/nest-common';
import { SEED } from '@los/database';
import { AppModule } from '../src/app.module';
import { CollateralChecksModule } from '../src/modules/collateral-checks/collateral-checks.module';
import { XypModule } from '../src/modules/xyp/xyp.module';

/** Тестийн `overrideProvider(...)` зэргийг нэмэх hook. */
export type AppCustomizer = (builder: TestingModuleBuilder) => TestingModuleBuilder;

async function boot(builder: TestingModuleBuilder, customize?: AppCustomizer): Promise<INestApplication> {
  const app = (await (customize ? customize(builder) : builder).compile()).createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();
  return app;
}

/** Бүрэн AppModule (DB шаардлагатай). */
export async function createApp(customize?: AppCustomizer): Promise<INestApplication> {
  return boot(Test.createTestingModule({ imports: [AppModule] }), customize);
}

/**
 * Хөнгөн app: зөвхөн ХУР-ын хөрөнгө + ачааллын модуль (DB, Redis, event bus-гүй). Мөн глобал guard, алдааны фильтр, Clock-той (CommonModule).
 * Интеграцийн горимыг (INTEGRATION_MODE) модуль үүсэх үед `process.env`-ээс уншдаг тул тест `vi.stubEnv` хийж болно.
 */
export async function createLightApp(customize?: AppCustomizer): Promise<INestApplication> {
  return boot(Test.createTestingModule({ imports: [CommonModule.forRoot(), XypModule, CollateralChecksModule] }), customize);
}

/** Gateway-ийн баталгаажуулсан толгойг дуурайна (сервис тэдэнд итгэнэ — CLAUDE.md §3.2.9). */
export const as = (u: keyof typeof SEED.users) => {
  const user = SEED.users[u];
  return { 'x-user-id': user.id, 'x-roles': user.roles.join(','), 'x-org-id': SEED.org.id, ...(user.branch ? { 'x-branch-id': SEED.branches[user.branch].id } : {}) };
};
