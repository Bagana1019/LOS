// ERP outbox relay: PENDING үйл явдлыг түрээслэн ErpGateway руу илгээж, амжилт/дахин оролдлого/DEAD төлөв тэмдэглэнэ. (FIN-SYNC-4)
// Хамгаалалт: at-least-once (Idempotency-Key-тэй), нэг application дотор seq дарааллаар, олон instance SKIP LOCKED-оор зэрэг ажиллана.
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ERP_GATEWAY, ErpPostError, type ErpGateway } from '../../integrations/erp';
import { ERP_SYNC_CONFIG, type ErpSyncConfig } from './erp-sync.config';
import { Clock, SystemClock } from '@los/nest-common';
import { buildErpPayload } from './erp-payload';
import { ERP_EVENT_REPOSITORY, type Completion, type ErpEventRecord, type ErpEventRepository } from './erp-event.repository';
import { backoffDelayMs } from './retry-policy';

export interface TickSummary { claimed: number; sent: number; duplicates: number; retried: number; dead: number; lostLease: number; aborted: boolean; cooldown: boolean; }
export interface RelayDeps { random?: () => number; workerId?: string; }
export const RELAY_DEPS = Symbol('RELAY_DEPS');

const truncate = (s: string, n = 500) => (s.length > n ? `${s.slice(0, n)}…` : s);

@Injectable()
export class OutboxRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('ErpOutboxRelay');
  private readonly clock: Clock;
  private readonly random: () => number;
  private readonly workerId: string;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<TickSummary> | null = null;
  private stopping = false;
  // Гадаад систем унасан үед (дараалсан RETRYABLE алдаа) бүх relay түр зогсоно: оролдлогын тоолуурыг үрэхгүй
  private cooldownUntil = 0;

  constructor(
    @Inject(ERP_EVENT_REPOSITORY) private readonly repo: ErpEventRepository,
    @Inject(ERP_GATEWAY) private readonly gateway: ErpGateway,
    @Inject(ERP_SYNC_CONFIG) private readonly config: ErpSyncConfig,
    @Optional() @Inject(Clock) clock?: Clock,
    @Optional() @Inject(RELAY_DEPS) deps?: RelayDeps,
  ) {
    this.clock = clock ?? new SystemClock();
    this.random = deps?.random ?? Math.random;
    this.workerId = deps?.workerId ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  }

  onModuleInit(): void {
    this.logger.log({ event: 'erp.relay.config', target: this.gateway.name, mode: this.config.mode, enabled: this.config.relay.enabled, maxAttempts: this.config.retry.maxAttempts });
    if (this.config.mode === 'mock' && process.env.NODE_ENV === 'production') {
      this.logger.warn({ event: 'erp.relay.mock_in_production', message: 'events are NOT delivered to a real finance system (INTEGRATION_MODE=mock)' });
    }
    if (!this.config.relay.enabled) { this.logger.warn({ event: 'erp.relay.disabled' }); return; }
    this.timer = setInterval(() => { void this.tick().catch((e) => this.logger.error({ event: 'erp.relay.tick_failed', error: String(e) })); }, this.config.relay.intervalMs);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running?.catch(() => undefined);
  }

  status() {
    const now = this.clock.now().getTime();
    return {
      target: this.gateway.name, mode: this.config.mode, enabled: this.config.relay.enabled,
      cooldownUntil: this.cooldownUntil > now ? new Date(this.cooldownUntil).toISOString() : null,
    };
  }

  // Давхар tick ажиллуулахгүй: явж буй tick-ийн үр дүнг буцаана
  tick(): Promise<TickSummary> {
    if (!this.running) this.running = this.runTick().finally(() => { this.running = null; });
    return this.running;
  }

  private async runTick(): Promise<TickSummary> {
    const { batchSize, concurrency, cooldownMs } = this.config.relay;
    const summary: TickSummary = { claimed: 0, sent: 0, duplicates: 0, retried: 0, dead: 0, lostLease: 0, aborted: false, cooldown: false };
    if (this.clock.now().getTime() < this.cooldownUntil) { summary.cooldown = true; return summary; }
    const state = { budget: batchSize, consecutiveRetryable: 0 };
    const worker = async () => {
      while (!summary.aborted && !this.stopping && state.budget > 0) {
        state.budget--;
        const entry = await this.repo.claimNext({ now: this.clock.now(), leaseMs: this.config.relay.leaseMs, workerId: this.workerId });
        if (!entry) return;
        summary.claimed++;
        await this.deliver(entry, summary, state);
      }
    };
    // Нэг worker-ийн алдаа (DB тасрах г.м) бусдыг зогсоохгүй, tick-ийг дуустал хүлээнэ
    const results = await Promise.allSettled(Array.from({ length: concurrency }, worker));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) { summary.aborted = true; this.logger.error({ event: 'erp.relay.worker_failed', error: String(failed.reason) }); }
    if (summary.aborted && state.consecutiveRetryable >= this.config.relay.abortAfterFailures) {
      this.cooldownUntil = this.clock.now().getTime() + cooldownMs;
      this.logger.warn({ event: 'erp.relay.cooldown', target: this.gateway.name, cooldownMs });
    }
    if (summary.claimed) this.logger.log({ event: 'erp.relay.tick', ...summary });
    // Бусад worker-ууд дуусах хүртэл хүлээсний дараа л алдааг дуудагчид (scheduler лог, dispatch 500) мэдэгдэнэ
    if (failed) throw failed.reason;
    return summary;
  }

  private async deliver(entry: ErpEventRecord, summary: TickSummary, state: { consecutiveRetryable: number }): Promise<void> {
    const startedAt = this.clock.now();
    let completion: Completion;
    let payload;
    try {
      payload = buildErpPayload(entry);
    } catch (e) {
      // Payload бүрдүүлэлтийн алдаа (буруу утга) дахин оролдсон ч засрахгүй — хүн засах ёстой
      completion = { outcome: 'DEAD', errorCode: 'INVALID_PAYLOAD', errorMessage: truncate(describe(e)) };
      return this.finish(entry, completion, startedAt, summary, state);
    }
    try {
      const res = await this.gateway.post(payload, { correlationId: entry.correlationId, attemptNo: entry.attempts });
      completion = { outcome: 'SENT', externalRef: res.externalRef, duplicate: res.duplicate };
    } catch (e) {
      // Хариу ирсний дараах цагаар backoff тооцно (удаан хариуны үед nextAttemptAt өнгөрсөн болохоос сэргийлнэ)
      completion = this.classify(e, entry, this.clock.now());
    }
    return this.finish(entry, completion, startedAt, summary, state);
  }

  private async finish(entry: ErpEventRecord, completion: Completion, startedAt: Date, summary: TickSummary, state: { consecutiveRetryable: number }): Promise<void> {
    const finishedAt = this.clock.now();
    let owned: boolean;
    try {
      owned = await this.complete(entry, completion, startedAt, finishedAt);
    } catch (e) {
      // DB алдаа: түрээс дуусмагц бичилт дахин оролдогдоно (attempts аль хэдийн тоологдсон)
      this.logger.error({ event: 'erp.relay.complete_failed', eventId: entry.id, correlationId: entry.correlationId, error: String(e) });
      summary.aborted = true;
      return;
    }
    if (!owned) { summary.lostLease++; this.logger.warn({ event: 'erp.relay.lease_lost', eventId: entry.id, correlationId: entry.correlationId }); return; }

    const base = { eventId: entry.id, correlationId: entry.correlationId, key: entry.idempotencyKey, attempt: entry.attempts };
    switch (completion.outcome) {
      case 'SENT':
        state.consecutiveRetryable = 0;
        if (completion.duplicate) summary.duplicates++; else summary.sent++;
        this.logger.log({ event: 'erp.sent', ...base, duplicate: completion.duplicate, externalRef: completion.externalRef });
        break;
      case 'RETRY':
        summary.retried++;
        if (++state.consecutiveRetryable >= this.config.relay.abortAfterFailures) summary.aborted = true;
        this.logger.warn({ event: 'erp.retry', ...base, code: completion.errorCode, nextAttemptAt: completion.nextAttemptAt.toISOString() });
        break;
      case 'DEAD':
        summary.dead++;
        this.logger.error({ event: 'erp.dead', ...base, code: completion.errorCode, message: completion.errorMessage });
        break;
    }
  }

  // Үр дүнг DB-д тэмдэглэнэ. Хүлээн авагчаас ирсэн текст (external ref, алдааны мессеж) DB-д хадгалагдахгүй байвал (хэт урт/буруу тэмдэгт)
  // илгээгдсэн бичилтийг PENDING хэвээр орхиж дахин илгээхгүйн тулд мэдээллийг хасаж нэг удаа дахин оролдоно.
  private async complete(entry: ErpEventRecord, completion: Completion, startedAt: Date, finishedAt: Date): Promise<boolean> {
    const args = { id: entry.id, workerId: this.workerId, attemptNo: entry.attempts, target: this.gateway.name, startedAt, finishedAt };
    try {
      return await this.repo.complete({ ...args, completion });
    } catch (first) {
      this.logger.warn({ event: 'erp.relay.complete_retry_minimal', eventId: entry.id, error: String(first) });
      return this.repo.complete({ ...args, completion: minimal(completion) });
    }
  }

  private classify(e: unknown, entry: ErpEventRecord, now: Date): Completion {
    if (e instanceof ErpPostError) {
      if (e.kind === 'PERMANENT') return { outcome: 'DEAD', errorCode: e.code, errorMessage: truncate(e.message), httpStatus: e.httpStatus };
      return this.retryOrDead(entry, now, e.code, e.message, e.httpStatus, e.retryAfterMs);
    }
    return this.retryOrDead(entry, now, 'UNEXPECTED', describe(e));
  }

  private retryOrDead(entry: ErpEventRecord, now: Date, errorCode: string, message: string, httpStatus?: number, retryAfterMs?: number): Completion {
    const errorMessage = truncate(message);
    if (entry.attempts >= this.config.retry.maxAttempts) return { outcome: 'DEAD', errorCode: 'MAX_ATTEMPTS', errorMessage: truncate(`${errorCode}: ${message}`), httpStatus };
    const delay = Math.max(backoffDelayMs(this.config.retry, entry.attempts, this.random), retryAfterMs ?? 0);
    return { outcome: 'RETRY', nextAttemptAt: new Date(now.getTime() + delay), errorCode, errorMessage, httpStatus };
  }
}

function describe(e: unknown): string {
  const issues = (e as { issues?: Array<{ path?: Array<string | number>; message?: string }> } | null)?.issues;
  if (Array.isArray(issues)) return issues.map((i) => `${(i.path ?? []).join('.')}: ${i.message ?? 'invalid'}`).join('; ');
  return e instanceof Error ? e.message : String(e);
}

function minimal(c: Completion): Completion {
  switch (c.outcome) {
    case 'SENT': return { outcome: 'SENT', externalRef: null, duplicate: c.duplicate };
    case 'RETRY': return { ...c, errorMessage: 'delivery failed (message dropped)' };
    case 'DEAD': return { ...c, errorMessage: 'delivery failed (message dropped)' };
  }
}
