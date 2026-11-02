import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CTX_HEADERS } from '@los/contracts';
import { SEED } from '@los/database';
import { Clock, FixedClock, JsonLogger } from '@los/nest-common';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';

export const HAS_DB = !!process.env.TEST_DATABASE_URL;
export const ORG = SEED.org.id;

/** 2026-10-29 11:00 in Ulaanbaatar (UTC+8). The DEMO seed prices are valid from 2026-01-01, so they are current at this instant. */
export const NOW = new Date('2026-10-29T03:00:00.000Z');
export const TODAY_UB = '2026-10-29';

/** The whole service (AppModule) with a fixed clock; integrations are the deterministic mocks (INTEGRATION_MODE unset). */
export async function createApp(now: Date = NOW, logSink?: (line: string) => void): Promise<INestApplication> {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(Clock).useValue(new FixedClock(now)).compile();
  const app = mod.createNestApplication();
  app.setGlobalPrefix('api');
  configureApp(app);
  app.useLogger(logSink ? new JsonLogger('valuation', 'debug', logSink) : false);
  await app.init();
  return app;
}

/** What the gateway sends after it authenticated the user (CLAUDE.md §3.2 rule 9); the services trust these headers. */
export const as = (u: keyof typeof SEED.users, orgId: string = ORG): Record<string, string> => {
  const user = SEED.users[u];
  return { [CTX_HEADERS.userId]: user.id, [CTX_HEADERS.roles]: user.roles.join(','), [CTX_HEADERS.orgId]: orgId, ...(user.branch ? { [CTX_HEADERS.branchId]: SEED.branches[user.branch].id } : {}) };
};

/** A caller whose role carries no permission at all (a self-service borrower, for example). */
export const asNobody = (orgId: string = ORG): Record<string, string> => ({ [CTX_HEADERS.userId]: 'nobody', [CTX_HEADERS.roles]: 'CUSTOMER', [CTX_HEADERS.orgId]: orgId });
