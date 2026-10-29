import { Inject, Injectable } from '@nestjs/common';
import type { ErpEventData, ErpEventStatus, ErpEventType } from '@los/contracts';
import type { ErpEvent, Prisma } from '.prisma/client-origination';
import { PrismaService } from '../../prisma.service';
import { IdempotencyConflictError, ErpEventNotFoundError, ErpEventStateError } from './erp-sync.errors';
import type {
  ClaimArgs, CompleteArgs, DeliveryAttemptRecord, InsertResult, ErpEventDraft, ErpEventDetail, ErpEventRecord,
  ErpEventListFilter, ErpEventRepository, ErpEventStats, ErpEventTx,
} from './erp-event.repository';

const dateOnly = (d: Date) => d.toISOString().slice(0, 10);

function toRecord(m: ErpEvent): ErpEventRecord {
  return {
    id: m.id, seq: m.seq, orgId: m.orgId, branchId: m.branchId, idempotencyKey: m.idempotencyKey, contentHash: m.contentHash,
    eventType: m.eventType as ErpEventType, sourceId: m.sourceId, applicationId: m.applicationId, contractNo: m.contractNo,
    coreLoanId: m.coreLoanId, customerId: m.customerId, currency: m.currency, businessDate: dateOnly(m.businessDate),
    correlationId: m.correlationId, amount: m.amount.toFixed(2), data: m.data as unknown as ErpEventData,
    status: m.status as ErpEventStatus, attempts: m.attempts, nextAttemptAt: m.nextAttemptAt, lockedUntil: m.lockedUntil, lockedBy: m.lockedBy,
    lastErrorCode: m.lastErrorCode, lastError: m.lastError, sentAt: m.sentAt, externalRef: m.externalRef, target: m.target,
    resolutionNote: m.resolutionNote, createdAt: m.createdAt, updatedAt: m.updatedAt,
  };
}

@Injectable()
export class PrismaErpEventRepository implements ErpEventRepository {
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {}

  async insert(d: ErpEventDraft, tx?: ErpEventTx): Promise<InsertResult> {
    const run = async (t: Prisma.TransactionClient): Promise<InsertResult> => {
      const h = d.header;
      // ON CONFLICT DO NOTHING: давхардал нь дуудагчийн транзакцийг abort хийхгүй (Postgres unique violation хийдэг)
      const inserted = await t.$queryRaw<Array<{ id: string }>>`
        INSERT INTO origination.erp_event (id, org_id, branch_id, idempotency_key, content_hash, event_type, source_id, application_id, contract_no,
          core_loan_id, customer_id, currency, business_date, correlation_id, amount, data, status, attempts, next_attempt_at,
          created_at, updated_at, created_by, updated_by)
        VALUES (${d.id}, ${h.orgId}, ${h.branchId}, ${d.idempotencyKey}, ${d.contentHash}, ${d.eventType}, ${d.sourceId}, ${h.applicationId}, ${h.contractNo},
          ${h.coreLoanId}, ${h.customerId}, ${h.currency}, ${h.businessDate}::date, ${d.correlationId}, ${d.amount}::numeric, ${JSON.stringify(d.data)}::jsonb, 'PENDING', 0, ${d.now},
          ${d.now}, ${d.now}, ${h.actorId}, ${h.actorId})
        ON CONFLICT (org_id, idempotency_key) DO NOTHING
        RETURNING id`;
      if (inserted.length === 0) {
        const existing = await t.erpEvent.findUniqueOrThrow({ where: { orgId_idempotencyKey: { orgId: h.orgId, idempotencyKey: d.idempotencyKey } } });
        if (existing.contentHash !== d.contentHash) throw new IdempotencyConflictError(d.idempotencyKey);
        return { event: toRecord(existing), created: false };
      }
      const created = await t.erpEvent.findUniqueOrThrow({ where: { id: d.id } });
      return { event: toRecord(created), created: true };
    };
    return tx ? run(tx as Prisma.TransactionClient) : this.db.$transaction(run);
  }

  async claimNext({ now, leaseMs, workerId }: ClaimArgs): Promise<ErpEventRecord | null> {
    const leaseUntil = new Date(now.getTime() + leaseMs);
    // FOR UPDATE SKIP LOCKED: олон instance зэрэг ажиллана. NOT EXISTS: нэг application-ийн өмнөх (seq бага) PENDING/DEAD бичилт дуустал хүлээнэ.
    const claimed = await this.db.$queryRaw<Array<{ id: string }>>`
      UPDATE origination.erp_event e
      SET attempts = e.attempts + 1, locked_by = ${workerId}, locked_until = ${leaseUntil}, updated_at = ${now}
      WHERE e.id = (
        SELECT c.id FROM origination.erp_event c
        WHERE c.status = 'PENDING' AND c.next_attempt_at <= ${now} AND (c.locked_until IS NULL OR c.locked_until < ${now})
          AND NOT EXISTS (
            SELECT 1 FROM origination.erp_event o
            WHERE o.application_id = c.application_id AND o.seq < c.seq AND o.status IN ('PENDING', 'DEAD'))
        ORDER BY c.next_attempt_at, c.seq
        LIMIT 1
        FOR UPDATE OF c SKIP LOCKED)
      RETURNING e.id`;
    if (claimed.length === 0) return null;
    return toRecord(await this.db.erpEvent.findUniqueOrThrow({ where: { id: claimed[0].id } }));
  }

  async complete(a: CompleteArgs): Promise<boolean> {
    const c = a.completion;
    const common = { lockedBy: null, lockedUntil: null, target: a.target, updatedAt: a.finishedAt };
    const data: Prisma.ErpEventUpdateManyMutationInput = c.outcome === 'SENT'
      ? { ...common, status: 'SENT', sentAt: a.finishedAt, externalRef: c.externalRef, lastError: null, lastErrorCode: null }
      : c.outcome === 'RETRY'
        ? { ...common, nextAttemptAt: c.nextAttemptAt, lastError: c.errorMessage, lastErrorCode: c.errorCode }
        : { ...common, status: 'DEAD', lastError: c.errorMessage, lastErrorCode: c.errorCode };
    return this.db.$transaction(async (t) => {
      // lockedBy шалгана: түрээс алдагдаж өөр worker авсан бол хуучин worker үр дүнг дарахгүй
      const { count } = await t.erpEvent.updateMany({ where: { id: a.id, status: 'PENDING', lockedBy: a.workerId }, data });
      if (count === 0) return false;
      await t.erpDeliveryAttempt.create({
        data: {
          eventId: a.id, attemptNo: a.attemptNo, outcome: c.outcome === 'SENT' && c.duplicate ? 'DUPLICATE' : c.outcome,
          errorCode: c.outcome === 'SENT' ? null : c.errorCode, errorMessage: c.outcome === 'SENT' ? null : c.errorMessage,
          httpStatus: c.outcome === 'SENT' ? null : c.httpStatus ?? null, durationMs: a.finishedAt.getTime() - a.startedAt.getTime(),
          externalRef: c.outcome === 'SENT' ? c.externalRef : null, target: a.target, startedAt: a.startedAt, finishedAt: a.finishedAt,
        },
      });
      return true;
    });
  }

  async getById(id: string): Promise<ErpEventDetail | null> {
    const m = await this.db.erpEvent.findUnique({ where: { id }, include: { deliveries: { orderBy: [{ startedAt: 'asc' }, { attemptNo: 'asc' }] } } });
    if (!m) return null;
    const deliveries: DeliveryAttemptRecord[] = m.deliveries.map((x) => ({
      attemptNo: x.attemptNo, outcome: x.outcome, errorCode: x.errorCode, errorMessage: x.errorMessage, httpStatus: x.httpStatus, durationMs: x.durationMs,
      externalRef: x.externalRef, target: x.target, actorId: x.actorId, note: x.note, startedAt: x.startedAt, finishedAt: x.finishedAt,
    }));
    return { ...toRecord(m), deliveries };
  }

  async list(f: ErpEventListFilter) {
    const rows = await this.db.erpEvent.findMany({
      where: { orgId: f.orgId, status: f.status, eventType: f.eventType, applicationId: f.applicationId, lastErrorCode: f.errorCode, ...(f.cursor ? { seq: { lt: BigInt(f.cursor) } } : {}) },
      orderBy: { seq: 'desc' }, take: f.limit + 1,
    });
    const page = rows.slice(0, f.limit);
    return { items: page.map(toRecord), nextCursor: rows.length > f.limit ? page[page.length - 1].seq.toString() : null };
  }

  async stats(orgId?: string): Promise<ErpEventStats> {
    const [groups, pending] = await Promise.all([
      this.db.erpEvent.groupBy({ by: ['status'], where: { orgId }, _count: { _all: true } }),
      this.db.erpEvent.aggregate({ where: { orgId, status: 'PENDING' }, _min: { createdAt: true, nextAttemptAt: true } }),
    ]);
    const counts: Record<ErpEventStatus, number> = { PENDING: 0, SENT: 0, DEAD: 0, CANCELLED: 0 };
    for (const g of groups) counts[g.status as ErpEventStatus] = g._count._all;
    return { counts, oldestPendingAt: pending._min.createdAt, nextAttemptAt: pending._min.nextAttemptAt };
  }

  async requeue(id: string, actorId: string | null, note: string | null, now: Date): Promise<ErpEventRecord> {
    return this.db.$transaction(async (t) => {
      const cur = await t.erpEvent.findUnique({ where: { id } });
      if (!cur) throw new ErpEventNotFoundError(id);
      if (cur.status !== 'PENDING' && cur.status !== 'DEAD') throw new ErpEventStateError(`cannot requeue a ${cur.status} ERP event`);
      // Одоо илгээгдэж буй бичилтийг сэргээвэл өөр worker-тэй зэрэг илгээгдэнэ
      if (cur.lockedUntil && cur.lockedUntil > now) throw new ErpEventStateError('ERP event is being sent right now');
      // DEAD -> PENDING (оролдлогын тоолуур шинэчлэгдэнэ); PENDING -> даруй дахин оролдуулна
      const { count } = await t.erpEvent.updateMany({
        where: { id, status: cur.status, updatedAt: cur.updatedAt },
        data: {
          status: 'PENDING', nextAttemptAt: now, lockedBy: null, lockedUntil: null, updatedBy: actorId, updatedAt: now,
          ...(cur.status === 'DEAD' ? { attempts: 0 } : {}),
        },
      });
      if (count === 0) throw new ErpEventStateError('ERP event changed concurrently');
      await t.erpDeliveryAttempt.create({ data: { eventId: id, attemptNo: cur.attempts, outcome: 'REQUEUED', actorId, note, startedAt: now, finishedAt: now } });
      return toRecord(await t.erpEvent.findUniqueOrThrow({ where: { id } }));
    });
  }

  async cancel(id: string, actorId: string | null, note: string, now: Date): Promise<ErpEventRecord> {
    return this.db.$transaction(async (t) => {
      const { count } = await t.erpEvent.updateMany({
        where: { id, status: { in: ['PENDING', 'DEAD'] }, OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }] },
        data: { status: 'CANCELLED', resolutionNote: note, lockedBy: null, lockedUntil: null, updatedBy: actorId, updatedAt: now },
      });
      const row = await t.erpEvent.findUnique({ where: { id } });
      if (!row) throw new ErpEventNotFoundError(id);
      if (count === 0) throw new ErpEventStateError(row.lockedUntil && row.lockedUntil > now ? 'ERP event is being sent right now' : `cannot cancel a ${row.status} ERP event`);
      await t.erpDeliveryAttempt.create({ data: { eventId: id, attemptNo: row.attempts, outcome: 'CANCELLED', actorId, note, startedAt: now, finishedAt: now } });
      return toRecord(await t.erpEvent.findUniqueOrThrow({ where: { id } }));
    });
  }
}
