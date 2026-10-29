import { z } from 'zod';
import { resolveIntegrationMode } from '../../integrations/erp';
import type { RetryPolicy } from './retry-policy';

const Env = z.object({
  ERP_RELAY_ENABLED: z.enum(['true', 'false']).default('true'),
  ERP_RELAY_INTERVAL_MS: z.coerce.number().int().min(200).default(5_000),
  ERP_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(20),
  ERP_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(1),
  ERP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(15_000),
  ERP_LEASE_MS: z.coerce.number().int().min(5_000).optional(),
  // 48 оролдлого ≈ 1 цагийн дээд завсартай 2 хоног орчим: ERP-ийн удаан засвар/амралтын өдрийг DEAD болгохгүй давна
  ERP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(48),
  ERP_RETRY_BASE_MS: z.coerce.number().int().min(100).default(30_000),
  ERP_RETRY_MAX_MS: z.coerce.number().int().min(1_000).default(3_600_000),
  ERP_ABORT_AFTER_FAILURES: z.coerce.number().int().min(1).default(3),
  ERP_COOLDOWN_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(30_000),
});

export interface ErpSyncConfig {
  mode: 'mock' | 'real';
  relay: { enabled: boolean; intervalMs: number; batchSize: number; concurrency: number; leaseMs: number; abortAfterFailures: number; cooldownMs: number };
  retry: RetryPolicy;
}

export const ERP_SYNC_CONFIG = Symbol('ERP_SYNC_CONFIG');

export function loadErpSyncConfig(env: Record<string, string | undefined>): ErpSyncConfig {
  const mode = resolveIntegrationMode(env, 'invalid ERP sync config');
  const parsed = Env.safeParse(env);
  if (!parsed.success) throw new Error(`invalid ERP sync config: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  const e = parsed.data;
  return {
    mode,
    relay: {
      // OUTBOX_RELAY=off (docs/00-foundation.md §4): сервисийн бүх relay-г нэг унтраалгаар унтраана (unit/e2e тест)
      enabled: e.ERP_RELAY_ENABLED === 'true' && env.OUTBOX_RELAY !== 'off', intervalMs: e.ERP_RELAY_INTERVAL_MS, batchSize: e.ERP_BATCH_SIZE,
      concurrency: e.ERP_CONCURRENCY,
      // түрээс нь HTTP timeout-оос урт байх ёстой, эс бол дуусаагүй илгээлтийг өөр worker булаана
      leaseMs: Math.max(e.ERP_LEASE_MS ?? 0, e.ERP_TIMEOUT_MS + 30_000),
      abortAfterFailures: e.ERP_ABORT_AFTER_FAILURES, cooldownMs: e.ERP_COOLDOWN_MS,
    },
    retry: { baseDelayMs: e.ERP_RETRY_BASE_MS, factor: 2, maxDelayMs: e.ERP_RETRY_MAX_MS, jitterRatio: 0.2, maxAttempts: e.ERP_MAX_ATTEMPTS },
  };
}
