import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hasTestDatabase } from '@los/config/vitest/test-db.mjs';
import { SEED } from '@los/database';
import { AppModule } from '../src/app.module';

/** Throws (before any connection) if TEST_DATABASE_URL / DATABASE_URL is not a database whose name ends with "test" (H7). */
export const HAS_DB = hasTestDatabase();

export async function createApp(): Promise<INestApplication> {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = mod.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();
  return app;
}

/** Gateway-ийн баталгаажуулсан толгойг дуурайна (сервис тэдэнд итгэнэ — CLAUDE.md §3.2.9). */
export const as = (u: keyof typeof SEED.users) => {
  const user = SEED.users[u];
  return { 'x-user-id': user.id, 'x-roles': user.roles.join(','), 'x-org-id': SEED.org.id, ...(user.branch ? { 'x-branch-id': SEED.branches[user.branch].id } : {}) };
};
