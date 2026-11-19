import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit, Optional, ServiceUnavailableException } from '@nestjs/common';
import { sanitizeForAudit } from '@los/database';
import { PrismaService } from '../../prisma.service';
import { AUDIT_FALLBACK_QUEUE, type AuditFallbackQueue, type AuditRow } from './audit-fallback-queue';

export interface AuditRecord {
  orgId?: string | null; entity: string; entityId: string; action: string; actorId?: string | null;
  afterJson?: unknown; beforeJson?: unknown; correlationId?: string | null; ip?: string | null; userAgent?: string | null;
}

export const AUDIT_OPTIONS = Symbol('AUDIT_OPTIONS');
export interface AuditOptions {
  /** DB бичилтийн нийт оролдлого (эхнийх орно). */
  attempts: number;
  /** Оролдлого хоорондын хүлээлт (мс); дутвал сүүлийнхийг давтана. */
  backoffMs: number[];
  sleep: (ms: number) => Promise<void>;
  /** Fallback дарааллыг DB руу шилжүүлэх интервал; 0 = унтраах. */
  drainIntervalMs: number;
}
const DEFAULTS: AuditOptions = {
  attempts: 3, backoffMs: [50, 250], sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  drainIntervalMs: Number(process.env.AUDIT_DRAIN_INTERVAL_MS ?? 30_000),
};
const DRAIN_BATCH = 100;
const UA_MAX = 300;

type Metrics = { written: number; retried: number; queued: number; drained: number; lost: number };
type AuditDb = { auditLog: { create(a: { data: AuditRow }): Promise<unknown>; createMany(a: { data: AuditRow[]; skipDuplicates: boolean }): Promise<unknown> } };

const isDuplicateId = (e: unknown) => (e as { code?: unknown } | null)?.code === 'P2002';
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * iam.audit_log — нэвтрэлт ба gateway-ээр дамжсан өөрчлөлтийн хүсэлт (NFR-4). Нууц үг, token, body хэзээ ч бичихгүй.
 * M10: fire-and-forget биш. DB бичилт bounded retry (ижил id → idempotent) → бүтэхгүй бол durable fallback дараалал (Redis) → дараа нь drain.
 * Хоёулаа бүтэхгүй бол: `record` (нэвтрэлт/сесс/нууц үг — critical) 503 AUDIT_UNAVAILABLE (fail closed); `recordSafe` (HTTP мөр) алдааг
 * `AUDIT_LOST` лог + тоолуураар мэдээлнэ (хариу аль хэдийн илгээгдсэн тул буцаах боломжгүй). docs/DECISIONS.md 2026-11-19 · 6-р үе шат.
 */
@Injectable()
export class AuditService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Audit');
  private readonly opts: AuditOptions;
  private readonly counters: Metrics = { written: 0, retried: 0, queued: 0, drained: 0, lost: 0 };
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(AUDIT_FALLBACK_QUEUE) private readonly queue: AuditFallbackQueue,
    @Optional() @Inject(AUDIT_OPTIONS) opts?: Partial<AuditOptions>,
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  onModuleInit(): void {
    if (this.opts.drainIntervalMs > 0) this.timer = setInterval(() => void this.drainFallback(), this.opts.drainIntervalMs).unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.queue.close?.();
  }

  /** Ариутгасан (sanitizeForAudit), id/at-тай мөр — өөр транзакц дотор (`tx.auditLog.create({ data })`) бичихэд ч хэрэглэнэ. */
  toRow(r: AuditRecord): AuditRow {
    return {
      id: randomUUID(), at: new Date(), orgId: r.orgId ?? null, entity: r.entity, entityId: r.entityId, action: r.action, actorId: r.actorId ?? null,
      afterJson: sanitizeForAudit(r.afterJson ?? null), beforeJson: sanitizeForAudit(r.beforeJson ?? null), applicationId: null,
      correlationId: r.correlationId ?? null, ip: r.ip ?? null, userAgent: r.userAgent?.slice(0, UA_MAX) ?? null,
    };
  }

  /** Critical (нэвтрэлт, сесс, нууц үг): DB эсвэл fallback-д хадгалагдтал; аль нь ч бүтэхгүй бол 503 (fail closed). */
  async record(r: AuditRecord): Promise<void> {
    if (await this.persist(this.toRow(r))) return;
    throw new ServiceUnavailableException({ code: 'AUDIT_UNAVAILABLE', message: 'Аудит бүртгэх боломжгүй байна. Түр хүлээгээд дахин оролдоно уу' });
  }

  /** Хүсэлтийн урсгалыг хаахгүй (HTTP мөр, хариу илгээгдсэний дараа): retry + fallback-тай, алдаа нь лог + тоолуур. */
  recordSafe(r: AuditRecord): void {
    void this.persist(this.toRow(r)).catch((e: unknown) => this.log.error(`AUDIT_LOST unexpected: ${msg(e)}`));
  }

  /** Fallback дарааллыг iam.audit_log руу шилжүүлнэ (id-аар idempotent). Нэг л pod зэрэг (түгжээ). Шилжүүлсэн мөрийн тоо. */
  async drainFallback(): Promise<number> {
    try {
      return (await this.queue.withLock(() => this.drainLocked())) ?? 0;
    } catch (e) {
      this.log.warn(`audit fallback drain failed (rows kept): ${msg(e)}`);
      return 0;
    }
  }

  metrics(): Metrics { return { ...this.counters }; }

  private async drainLocked(): Promise<number> {
    let total = 0;
    for (;;) {
      const items = await this.queue.peek(DRAIN_BATCH);
      if (items.length === 0) return total;
      const rows = items.filter((x): x is AuditRow => x !== null);
      if (rows.length < items.length) this.log.error(`AUDIT_QUEUE_CORRUPT dropped=${items.length - rows.length}`);
      if (rows.length) await this.db.auditLog.createMany({ data: rows, skipDuplicates: true });
      await this.queue.drop(items.length);
      total += rows.length;
      this.counters.drained += rows.length;
      if (items.length < DRAIN_BATCH) return total;
    }
  }

  /** true = DB эсвэл fallback-д хадгалагдсан. */
  private async persist(row: AuditRow): Promise<boolean> {
    if (await this.writeWithRetry(row)) return true;
    try {
      await this.queue.push(row);
      this.counters.queued += 1;
      this.log.error(`AUDIT_QUEUED id=${row.id} action=${row.action} correlationId=${row.correlationId ?? '-'}: DB write failed, parked in fallback queue`);
      return true;
    } catch (e) {
      this.counters.lost += 1;
      this.log.error(`AUDIT_LOST id=${row.id} action=${row.action} entity=${row.entity} entityId=${row.entityId} actorId=${row.actorId ?? '-'} orgId=${row.orgId ?? '-'} correlationId=${row.correlationId ?? '-'} at=${row.at.toISOString()}: ${msg(e)}`);
      return false;
    }
  }

  private async writeWithRetry(row: AuditRow): Promise<boolean> {
    const { attempts, backoffMs, sleep } = this.opts;
    for (let i = 0; i < attempts; i += 1) {
      try {
        await this.db.auditLog.create({ data: row });
        this.counters.written += 1;
        return true;
      } catch (e) {
        if (isDuplicateId(e)) { this.counters.written += 1; return true; } // өмнөх оролдлого commit болсон (хариу л алдагдсан)
        if (i === attempts - 1) { this.log.error(`AUDIT_WRITE_FAILED id=${row.id} action=${row.action} after ${attempts} attempts: ${msg(e)}`); return false; }
        this.counters.retried += 1;
        this.log.warn(`audit write attempt ${i + 1}/${attempts} failed, retrying: ${msg(e)}`);
        await sleep(backoffMs[i] ?? backoffMs[backoffMs.length - 1] ?? 0);
      }
    }
    return false;
  }

  private get db(): AuditDb { return this.prisma as unknown as AuditDb; }
}
