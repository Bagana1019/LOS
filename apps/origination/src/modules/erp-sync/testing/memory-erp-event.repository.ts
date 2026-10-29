// Unit test-д зориулсан санах ойн хэрэгжүүлэлт. Prisma хэрэгжүүлэлттэй ижил гэрээг (erp-event.repository.contract.ts) давна.
import { IdempotencyConflictError, ErpEventNotFoundError, ErpEventStateError } from '../erp-sync.errors';
import type {
  ClaimArgs, CompleteArgs, DeliveryAttemptRecord, InsertResult, ErpEventDraft, ErpEventDetail, ErpEventRecord,
  ErpEventListFilter, ErpEventRepository, ErpEventStats, ErpEventTx,
} from '../erp-event.repository';

export class MemoryErpEventRepository implements ErpEventRepository {
  private seq = 0n;
  private readonly rows = new Map<string, ErpEventRecord>();
  private readonly deliveries = new Map<string, DeliveryAttemptRecord[]>();

  async insert(d: ErpEventDraft, _tx?: ErpEventTx): Promise<InsertResult> {
    const existing = [...this.rows.values()].find((r) => r.orgId === d.header.orgId && r.idempotencyKey === d.idempotencyKey);
    if (existing) {
      if (existing.contentHash !== d.contentHash) throw new IdempotencyConflictError(d.idempotencyKey);
      return { event: structuredClone(existing), created: false };
    }
    const row: ErpEventRecord = {
      id: d.id, seq: ++this.seq, orgId: d.header.orgId, branchId: d.header.branchId, idempotencyKey: d.idempotencyKey, contentHash: d.contentHash,
      eventType: d.eventType, sourceId: d.sourceId, applicationId: d.header.applicationId, contractNo: d.header.contractNo,
      coreLoanId: d.header.coreLoanId, customerId: d.header.customerId, currency: d.header.currency, businessDate: d.header.businessDate,
      correlationId: d.correlationId, amount: d.amount, data: structuredClone(d.data), status: 'PENDING', attempts: 0,
      nextAttemptAt: d.now, lockedUntil: null, lockedBy: null, lastErrorCode: null, lastError: null, sentAt: null, externalRef: null,
      target: null, resolutionNote: null, createdAt: d.now, updatedAt: d.now,
    };
    this.rows.set(row.id, row);
    this.deliveries.set(row.id, []);
    return { event: structuredClone(row), created: true };
  }

  async claimNext({ now, leaseMs, workerId }: ClaimArgs): Promise<ErpEventRecord | null> {
    const due = [...this.rows.values()]
      .filter((r) => r.status === 'PENDING' && r.nextAttemptAt <= now && (!r.lockedUntil || r.lockedUntil < now))
      .filter((r) => ![...this.rows.values()].some((o) => o.applicationId === r.applicationId && o.seq < r.seq && (o.status === 'PENDING' || o.status === 'DEAD')))
      .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime() || (a.seq < b.seq ? -1 : 1));
    const row = due[0];
    if (!row) return null;
    row.attempts += 1; row.lockedBy = workerId; row.lockedUntil = new Date(now.getTime() + leaseMs); row.updatedAt = now;
    return structuredClone(row);
  }

  async complete(a: CompleteArgs): Promise<boolean> {
    const row = this.rows.get(a.id);
    if (!row || row.status !== 'PENDING' || row.lockedBy !== a.workerId) return false;
    const c = a.completion;
    const attempt: DeliveryAttemptRecord = {
      attemptNo: a.attemptNo, outcome: c.outcome === 'SENT' && c.duplicate ? 'DUPLICATE' : c.outcome,
      errorCode: c.outcome === 'SENT' ? null : c.errorCode, errorMessage: c.outcome === 'SENT' ? null : c.errorMessage,
      httpStatus: c.outcome === 'SENT' ? null : c.httpStatus ?? null, durationMs: a.finishedAt.getTime() - a.startedAt.getTime(),
      externalRef: c.outcome === 'SENT' ? c.externalRef : null, target: a.target, actorId: null, note: null, startedAt: a.startedAt, finishedAt: a.finishedAt,
    };
    row.lockedBy = null; row.lockedUntil = null; row.updatedAt = a.finishedAt; row.target = a.target;
    if (c.outcome === 'SENT') { row.status = 'SENT'; row.sentAt = a.finishedAt; row.externalRef = c.externalRef; row.lastError = null; row.lastErrorCode = null; }
    else {
      row.lastError = c.errorMessage; row.lastErrorCode = c.errorCode;
      if (c.outcome === 'RETRY') row.nextAttemptAt = c.nextAttemptAt; else row.status = 'DEAD';
    }
    this.deliveries.get(a.id)!.push(attempt);
    return true;
  }

  async getById(id: string): Promise<ErpEventDetail | null> {
    const row = this.rows.get(id);
    return row ? { ...structuredClone(row), deliveries: structuredClone(this.deliveries.get(id) ?? []) } : null;
  }

  async list(f: ErpEventListFilter) {
    const all = [...this.rows.values()]
      .filter((r) => (!f.orgId || r.orgId === f.orgId) && (!f.status || r.status === f.status) && (!f.eventType || r.eventType === f.eventType) && (!f.applicationId || r.applicationId === f.applicationId) && (!f.errorCode || r.lastErrorCode === f.errorCode))
      .filter((r) => !f.cursor || r.seq < BigInt(f.cursor))
      .sort((a, b) => (a.seq < b.seq ? 1 : -1));
    const page = all.slice(0, f.limit);
    return { items: structuredClone(page), nextCursor: all.length > f.limit ? page[page.length - 1].seq.toString() : null };
  }

  async stats(orgId?: string): Promise<ErpEventStats> {
    const counts = { PENDING: 0, SENT: 0, DEAD: 0, CANCELLED: 0 };
    const rows = [...this.rows.values()].filter((r) => !orgId || r.orgId === orgId);
    const pending = rows.filter((r) => r.status === 'PENDING');
    for (const r of rows) counts[r.status]++;
    const min = (ds: Date[]) => (ds.length ? new Date(Math.min(...ds.map((d) => d.getTime()))) : null);
    return { counts, oldestPendingAt: min(pending.map((r) => r.createdAt)), nextAttemptAt: min(pending.map((r) => r.nextAttemptAt)) };
  }

  async requeue(id: string, actorId: string | null, note: string | null, now: Date): Promise<ErpEventRecord> {
    const row = this.rows.get(id);
    if (!row) throw new ErpEventNotFoundError(id);
    if (row.status !== 'PENDING' && row.status !== 'DEAD') throw new ErpEventStateError(`cannot requeue a ${row.status} ERP event`);
    if (row.lockedUntil && row.lockedUntil > now) throw new ErpEventStateError('ERP event is being sent right now');
    const attemptsBefore = row.attempts;
    if (row.status === 'DEAD') { row.status = 'PENDING'; row.attempts = 0; }
    row.nextAttemptAt = now; row.lockedBy = null; row.lockedUntil = null; row.updatedAt = now;
    this.deliveries.get(id)!.push({ ...this.manual('REQUEUED', row, actorId, note, now), attemptNo: attemptsBefore });
    return structuredClone(row);
  }

  async cancel(id: string, actorId: string | null, note: string, now: Date): Promise<ErpEventRecord> {
    const row = this.rows.get(id);
    if (!row) throw new ErpEventNotFoundError(id);
    if (row.status !== 'PENDING' && row.status !== 'DEAD') throw new ErpEventStateError(`cannot cancel a ${row.status} ERP event`);
    if (row.lockedUntil && row.lockedUntil > now) throw new ErpEventStateError('ERP event is being sent right now');
    row.status = 'CANCELLED'; row.resolutionNote = note; row.lockedBy = null; row.lockedUntil = null; row.updatedAt = now;
    this.deliveries.get(id)!.push(this.manual('CANCELLED', row, actorId, note, now));
    return structuredClone(row);
  }

  private manual(outcome: string, row: ErpEventRecord, actorId: string | null, note: string | null, now: Date): DeliveryAttemptRecord {
    return { attemptNo: row.attempts, outcome, errorCode: null, errorMessage: null, httpStatus: null, durationMs: null, externalRef: null, target: null, actorId, note, startedAt: now, finishedAt: now };
  }
}
