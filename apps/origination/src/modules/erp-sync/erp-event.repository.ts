// ERP-д дамжуулах үйл явдлын outbox-ийн port. Prisma хэрэгжүүлэлт (production) ба санах ойн хэрэгжүүлэлт (unit test) ижил гэрээг дагана.
import type { ErpEventData, ErpEventStatus, ErpEventType } from '@los/contracts';
import type { ErpEventHeader } from './event-plan';

// Дуудагчийн транзакц (Prisma.TransactionClient). Бизнес мөртэй нэг транзакцид outbox-д бичихэд дамжуулна (CLAUDE.md §3.2-4).
export type ErpEventTx = unknown;

export interface ErpEventDraft {
  id: string; idempotencyKey: string; contentHash: string; eventType: ErpEventType; sourceId: string;
  header: ErpEventHeader; correlationId: string; amount: string; data: ErpEventData; now: Date;
}

export interface ErpEventRecord {
  id: string; seq: bigint; orgId: string; branchId: string | null; idempotencyKey: string; contentHash: string;
  eventType: ErpEventType; sourceId: string; applicationId: string; contractNo: string | null; coreLoanId: string | null; customerId: string | null;
  currency: string; businessDate: string; correlationId: string; amount: string; data: ErpEventData;
  status: ErpEventStatus; attempts: number; nextAttemptAt: Date; lockedUntil: Date | null; lockedBy: string | null;
  lastErrorCode: string | null; lastError: string | null; sentAt: Date | null; externalRef: string | null; target: string | null;
  resolutionNote: string | null; createdAt: Date; updatedAt: Date;
}

export interface DeliveryAttemptRecord {
  attemptNo: number; outcome: string; errorCode: string | null; errorMessage: string | null; httpStatus: number | null;
  durationMs: number | null; externalRef: string | null; target: string | null; actorId: string | null; note: string | null;
  startedAt: Date; finishedAt: Date | null;
}
export interface ErpEventDetail extends ErpEventRecord { deliveries: DeliveryAttemptRecord[]; }

export interface InsertResult { event: ErpEventRecord; created: boolean; }

export type Completion =
  | { outcome: 'SENT'; externalRef: string | null; duplicate: boolean }
  | { outcome: 'RETRY'; nextAttemptAt: Date; errorCode: string; errorMessage: string; httpStatus?: number }
  | { outcome: 'DEAD'; errorCode: string; errorMessage: string; httpStatus?: number };

export interface ClaimArgs { now: Date; leaseMs: number; workerId: string; }
export interface CompleteArgs { id: string; workerId: string; attemptNo: number; completion: Completion; target: string; startedAt: Date; finishedAt: Date; }

export interface ErpEventListFilter { orgId?: string; status?: ErpEventStatus; eventType?: ErpEventType; applicationId?: string; errorCode?: string; limit: number; cursor?: string; }
export interface ErpEventStats {
  counts: Record<ErpEventStatus, number>; oldestPendingAt: Date | null; nextAttemptAt: Date | null;
}

export interface ErpEventRepository {
  // Idempotent: (orgId, idempotencyKey) байвал шинэ мөр үүсгэхгүй. Агуулга зөрвөл IdempotencyConflictError.
  insert(draft: ErpEventDraft, tx?: ErpEventTx): Promise<InsertResult>;
  // Хугацаа нь болсон, өмнөх (seq бага) PENDING/DEAD бичилтгүй, түгжигдээгүй нэг бичилтийг түрээслэнэ. attempts+1.
  claimNext(args: ClaimArgs): Promise<ErpEventRecord | null>;
  // Түрээс (lockedBy) хэвээр байвал л төлөв шинэчилнэ; алдагдсан бол false.
  complete(args: CompleteArgs): Promise<boolean>;
  getById(id: string): Promise<ErpEventDetail | null>;
  list(filter: ErpEventListFilter): Promise<{ items: ErpEventRecord[]; nextCursor: string | null }>;
  // orgId өгвөл зөвхөн тухайн байгууллагын бичилтийн тоо (ops API); өгөхгүй бол бүгд
  stats(orgId?: string): Promise<ErpEventStats>;
  // DEAD -> PENDING (attempts=0) эсвэл PENDING-ийг даруй дахин оролдуулах. SENT/CANCELLED бол ErpEventStateError.
  // Түрээстэй (одоо илгээгдэж буй) PENDING бол ErpEventStateError. Үйл явдлын агуулга хэзээ ч өөрчлөгдөхгүй.
  requeue(id: string, actorId: string | null, note: string | null, now: Date): Promise<ErpEventRecord>;
  // PENDING/DEAD -> CANCELLED. Одоо илгээгдэж буй (түрээстэй) бол ErpEventStateError.
  cancel(id: string, actorId: string | null, note: string, now: Date): Promise<ErpEventRecord>;
}

export const ERP_EVENT_REPOSITORY = Symbol('ERP_EVENT_REPOSITORY');
