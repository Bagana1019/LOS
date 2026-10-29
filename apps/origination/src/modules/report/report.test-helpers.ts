import request from 'supertest';
import type { ReportResult } from '@los/contracts';
import { ReportResult as ReportResultSchema } from '@los/contracts';
import { resetDb } from '../../test-utils/factories';
import { createTestApp, TestApp } from '../../test-utils/test-app';
import { DASHBOARD_CACHE_TTL_MS } from './dashboard.service';
import { ReportModule } from './report.module';
import { seedWorld, type World } from './report.fixtures';

export interface ReportEnv { t: TestApp; http: () => ReturnType<typeof request> }

/** Dashboard кэшийг тестэд анхдагчаар унтраана (тест бүр өгөгдлөө сольж дахин уншдаг); кэшийн тестүүд `dashboardCacheMs`-ийг өгнө. */
export async function bootReport(o: { dashboardCacheMs?: number } = {}): Promise<ReportEnv> {
  const t = await createTestApp([ReportModule], (b) => b.overrideProvider(DASHBOARD_CACHE_TTL_MS).useValue(o.dashboardCacheMs ?? 0));
  return { t, http: () => request(t.app.getHttpServer()) };
}

export async function resetReport(env: ReportEnv): Promise<void> {
  await resetDb(env.t.prisma);
  env.t.clock.set('2026-10-28T02:00:00Z');
}

export async function resetAndSeed(env: ReportEnv): Promise<World> {
  await resetReport(env);
  return seedWorld(env.t.prisma);
}

/** GET reports/:key, 200 + DTO parse. */
export async function getReport(env: ReportEnv, headers: Record<string, string>, key: string, query: Record<string, string | number> = {}): Promise<ReportResult> {
  const res = await env.http().get(`/api/reports/${key}`).query(query).set(headers);
  if (res.status !== 200) throw new Error(`GET reports/${key} → ${res.status} ${JSON.stringify(res.body)}`);
  return ReportResultSchema.parse(res.body);
}

/** Мөрүүдийг тодорхой түлхүүрээр авна. */
export const col = (r: ReportResult, key: string) => r.rows.map((row) => row[key]);
