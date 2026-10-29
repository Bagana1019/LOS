import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SEED } from '@los/database';
import { AppModule } from '../src/app.module';

export async function createApp(): Promise<INestApplication> {
  const app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();
  return app;
}

/** Gateway-ийн баталгаажуулсан толгойг дуурайна (сервис тэдэнд итгэнэ — CLAUDE.md §3.2.9). */
export const as = (u: keyof typeof SEED.users) => {
  const user = SEED.users[u];
  return { 'x-user-id': user.id, 'x-roles': user.roles.join(','), 'x-org-id': SEED.org.id, ...(user.branch ? { 'x-branch-id': SEED.branches[user.branch].id } : {}) };
};
