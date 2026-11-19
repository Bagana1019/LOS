import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit, Optional, ServiceUnavailableException } from '@nestjs/common';
import { sanitizeForAudit } from '@los/database';
import { PrismaService } from '../../prisma.service';
import { auditErrorClass, isTransientAuditError } from './audit-errors';
import { AUDIT_FALLBACK_QUEUE, type AuditFallbackQueue, type AuditRow, type QueuedItem } from './audit-fallback-queue';

export interface AuditRecord {
  orgId?: string | null; entity: string; entityId: string; action: string; actorId?: string | null;
  afterJson?: unknown; beforeJson?: unknown; correlationId?: string | null; ip?: string | null; userAgent?: string | null;
}

export const AUDIT_OPTIONS = Symbol('AUDIT_OPTIONS');
export interface AuditOptions {
  /** DB бичилтийн нийт оролдлого (эхнийх орно); зөвхөн transient алдаанд давтана. */
  attempts: number;
  /** Оролдлого хоорондын хүлээлт (мс); дутвал сүүлийнхийг давтана. */
  backoffMs: number[];
  sleep: (ms: number) => Promise<void>;
  /** Fallback дарааллыг DB руу шилжүүлэх интервал; 0 = унтраах. */
  drainIntervalMs: number;
  /** Drain lease-ийн TTL; batch бүрийн өмнө сунгана. */
  lockTtlMs: number;
}
const DEFAULTS: AuditOptions = {
  attempts: 3, backoffMs: [50, 250], sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  drainIntervalMs: Number(process.env.AUDIT_DRAIN_INTERVAL_MS ?? 30_000), lockTtlMs: 30_000,
};
const DRAIN_BATCH = 100;
/** Чөлөөт текстийн дээд урт (энгийн хүсэлт poison мөр үүсгэхгүй). */
const MAX = { id: 256, entityId: 512, ip: 64, userAgent: 300 } as const;

type Metrics = { written: number; retried: number; queued: number; drained: number; deadLettered: number; lost: number };
type AuditDb = { auditLog: { create(a: { data: AuditRow }): Promise<unknown>; createMany(a: { data: AuditRow[]; skipDuplicates: boolean }): Promise<unknown> } };
/** 'ok' | 'transient' | байнгын алдааны анги (PII-гүй код). */
type WriteResult = 'ok' | 'transient' | { permanent: string };

const isDuplicateId = (e: unknown) => (e as { code?: unknown } | null)?.code === 'P2002';
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** NUL (Postgres text/jsonb хүлээж авахгүй) хасаад уртыг хязгаарлана. */
const NUL = String.fromCharCode(0);
const noNul = (s: string) => s.split(NUL).join('');
const bound = (s: string, max: number) => noNul(s).slice(0, max);
const boundOpt = (s: string | null | undefined, max: number) => (s == null ? null : bound(s, max));
function stripNul(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return noNul(v);
  if (v === null || typeof v !== 'object' || depth > 8) return v;
  if (Array.isArray(v)) return v.map((x) => stripNul(x, depth + 1));
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [noNul(k), stripNul(x, depth + 1)]));
}

/**
 * iam.audit_log — нэвтрэлт ба gateway-ээр дамжсан өөрчлөлтийн хүсэлт (NFR-4). Нууц үг, token, body хэзээ ч бичихгүй.
 * M10: fire-and-forget биш. DB бичилт bounded retry (transient алдаанд, ижил id → idempotent) → бүтэхгүй бол durable fallback дараалал (Redis)
 * → `drainFallback`. Байнгын алдаатай мөр (утга/схем) DLQ руу (дарааллыг хаахгүй). Хаана ч хадгалж чадахгүй бол: `record` (нэвтрэлт/сесс —
 * critical) 503 AUDIT_UNAVAILABLE (fail closed); `recordSafe` (HTTP мөр) `AUDIT_LOST` лог + тоолуур. docs/DECISIONS.md 2026-11-19 · 6-р үе шат.
 */
@Injectable()
export class AuditService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Audit');
  private readonly opts: AuditOptions;
  private readonly counters: Metrics = { written: 0, retried: 0, queued: 0, drained: 0, deadLettered: 0, lost: 0 };
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

  /** Ариутгасан (sanitizeForAudit), хязгаарласан, id/at-тай мөр — өөр транзакц дотор (`tx.auditLog.create({ data })`) бичихэд ч хэрэглэнэ. */
  toRow(r: AuditRecord): AuditRow {
    return {
      id: randomUUID(), at: new Date(), orgId: boundOpt(r.orgId, MAX.id), entity: bound(r.entity, MAX.id), entityId: bound(r.entityId, MAX.entityId),
      action: bound(r.action, MAX.id), actorId: boundOpt(r.actorId, MAX.id),
      afterJson: stripNul(sanitizeForAudit(r.afterJson ?? null)), beforeJson: stripNul(sanitizeForAudit(r.beforeJson ?? null)), applicationId: null,
      correlationId: boundOpt(r.correlationId, MAX.id), ip: boundOpt(r.ip, MAX.ip), userAgent: boundOpt(r.userAgent, MAX.userAgent),
    };
  }

  /** Critical (нэвтрэлт, сесс): DB, fallback эсвэл DLQ-д хадгалагдтал; аль нь ч бүтэхгүй бол 503 (fail closed). */
  async record(r: AuditRecord): Promise<void> {
    if (await this.persist(this.toRow(r))) return;
    throw new ServiceUnavailableException({ code: 'AUDIT_UNAVAILABLE', message: 'Аудит бүртгэх боломжгүй байна. Түр хүлээгээд дахин оролдоно уу' });
  }

  /** Хүсэлтийн урсгалыг хаахгүй (HTTP мөр, хариу илгээгдсэний дараа): retry + fallback-тай, алдаа нь лог + тоолуур. */
  recordSafe(r: AuditRecord): void {
    void this.persist(this.toRow(r)).catch((e: unknown) => this.log.error(`AUDIT_LOST unexpected: ${msg(e)}`));
  }

  /**
   * Fallback дарааллыг iam.audit_log руу шилжүүлнэ. Lease (token) батч бүрийн өмнө сунгагдана; устгал нь зөвхөн token хүчинтэй БА толгой яг
   * peek хийсэн элементүүд байвал (removeHead). Lease алдагдвал юу ч устгахгүй — нөгөө pod дахин оруулна (id + skipDuplicates → давхардалгүй).
   * Transient алдаа → юу ч устгахгүй, дараагийн tick. Байнгын алдаатай батч → мөр мөрөөр, муу мөр DLQ руу. Шилжүүлсэн мөрийн тоо.
   */
  async drainFallback(): Promise<number> {
    let token: string | null = null;
    let total = 0;
    try {
      token = await this.queue.acquire(this.opts.lockTtlMs);
      if (!token) return 0;
      for (;;) {
        if (!(await this.queue.renew(token, this.opts.lockTtlMs))) { this.log.warn('audit drain lease lost before batch; stopping'); break; }
        const items = await this.queue.peek(DRAIN_BATCH);
        if (items.length === 0) break;
        const { done, persisted } = await this.persistBatch(items);
        if (done > 0 && !(await this.queue.removeHead(items.slice(0, done).map((i) => i.raw), token))) {
          this.log.warn(`audit drain lease lost mid-batch: ${done} row(s) left queued for the new owner (idempotent by id)`);
          break;
        }
        total += persisted;
        this.counters.drained += persisted;
        if (done < items.length || items.length < DRAIN_BATCH) break;
      }
    } catch (e) {
      this.log.warn(`audit fallback drain stopped (unconfirmed rows kept): ${msg(e)}`);
    } finally {
      if (token) await this.queue.release(token).catch(() => undefined);
    }
    return total;
  }

  metrics(): Metrics { return { ...this.counters }; }

  /** `done` = толгойгоос хэдэн элемент шийдэгдсэн (DB-д орсон эсвэл DLQ-д), `persisted` = DB-д орсон. */
  private async persistBatch(items: QueuedItem[]): Promise<{ done: number; persisted: number }> {
    const rows = items.map((i) => i.row);
    if (rows.every((r): r is AuditRow => r !== null)) {
      try {
        await this.db.auditLog.createMany({ data: rows, skipDuplicates: true });
        return { done: items.length, persisted: rows.length };
      } catch (e) {
        if (isTransientAuditError(e)) { this.log.warn(`audit drain batch failed (transient, kept): ${msg(e)}`); return { done: 0, persisted: 0 }; }
        this.log.error(`AUDIT_DRAIN_BATCH_REJECTED class=${auditErrorClass(e)}: retrying ${items.length} row(s) one by one`);
      }
    }
    let done = 0;
    let persisted = 0;
    for (const it of items) {
      const res = it.row ? await this.insertOnce(it.row) : { permanent: 'CORRUPT' };
      if (res === 'transient') break;
      if (res === 'ok') persisted += 1;
      else await this.deadLetter(it.raw, it.row?.id ?? null, res.permanent);
      done += 1;
    }
    return { done, persisted };
  }

  /** true = DB, fallback эсвэл DLQ-д хадгалагдсан. */
  private async persist(row: AuditRow): Promise<boolean> {
    const res = await this.writeWithRetry(row);
    if (res === 'ok') return true;
    try {
      if (res === 'transient') {
        await this.queue.push(row);
        this.counters.queued += 1;
        this.log.error(`AUDIT_QUEUED id=${row.id} action=${row.action} correlationId=${row.correlationId ?? '-'}: DB write failed, parked in fallback queue`);
      } else {
        await this.deadLetter(JSON.stringify(row), row.id, res.permanent);
      }
      return true;
    } catch (e) {
      this.counters.lost += 1;
      this.log.error(`AUDIT_LOST id=${row.id} action=${row.action} entity=${row.entity} entityId=${row.entityId} actorId=${row.actorId ?? '-'} orgId=${row.orgId ?? '-'} correlationId=${row.correlationId ?? '-'} at=${row.at.toISOString()}: ${msg(e)}`);
      return false;
    }
  }

  /** DLQ: алдааны анги л (мессеж/утга биш). DLQ бичилт бүтэхгүй бол throw — дуудагч мөрийг устгахгүй. */
  private async deadLetter(raw: string, id: string | null, errorClass: string): Promise<void> {
    const before = await this.queue.deadLetter({ raw, id, errorClass, failedAt: new Date().toISOString() });
    this.counters.deadLettered += 1;
    this.log.error(`AUDIT_DLQ id=${id ?? '-'} class=${errorClass} dlqSize=${before + 1}: permanently rejected audit row moved to the dead-letter list`);
  }

  private async insertOnce(row: AuditRow): Promise<WriteResult> {
    try {
      await this.db.auditLog.create({ data: row });
      return 'ok';
    } catch (e) {
      if (isDuplicateId(e)) return 'ok'; // өмнөх оролдлого commit болсон (хариу л алдагдсан)
      return isTransientAuditError(e) ? 'transient' : { permanent: auditErrorClass(e) };
    }
  }

  private async writeWithRetry(row: AuditRow): Promise<WriteResult> {
    const { attempts, backoffMs, sleep } = this.opts;
    for (let i = 0; i < attempts; i += 1) {
      const res = await this.insertOnce(row);
      if (res === 'ok') { this.counters.written += 1; return res; }
      if (res !== 'transient') return res; // байнгын алдаа — дахин оролдоод нэмэргүй
      if (i === attempts - 1) { this.log.error(`AUDIT_WRITE_FAILED id=${row.id} action=${row.action} after ${attempts} attempts`); break; }
      this.counters.retried += 1;
      this.log.warn(`audit write attempt ${i + 1}/${attempts} failed (transient), retrying`);
      await sleep(backoffMs[i] ?? backoffMs[backoffMs.length - 1] ?? 0);
    }
    return 'transient';
  }

  private get db(): AuditDb { return this.prisma as unknown as AuditDb; }
}
