import type { ChangeRequestEvent, ChangeRequestMode, ChangeRequestScope, ChangeRequestStatus, DomainEvent } from '@los/contracts';
import type { AuditInput } from '@los/database';
import type { Actor } from './actor';

/** Persistence port. Prisma хэрэгжүүлэлт: infra/prisma-change-request.store.ts; тестийн: testing/in-memory.store.ts */
export interface ChangeRequestRow {
  id: string; orgId: string; branchId: string | null;
  targetType: string; targetId: string; action: string; applicationId: string | null;
  mode: ChangeRequestMode; status: ChangeRequestStatus;
  payload: unknown; before: unknown | null; baseVersion: string | null; reason: string;
  makerId: string; makerRoles: string[]; requiredCheckerRoles: string[];
  checkerId: string | null; checkerRoles: string[]; checkerComment: string | null; failureReason: string | null;
  correlationId: string; expiresAt: Date; decidedAt: Date | null; version: number; createdAt: Date; updatedAt: Date;
}

export type NewChangeRequest = Omit<ChangeRequestRow, 'checkerId' | 'checkerRoles' | 'checkerComment' | 'failureReason' | 'decidedAt' | 'version' | 'updatedAt'>
  & Partial<Pick<ChangeRequestRow, 'checkerId' | 'checkerRoles' | 'checkerComment' | 'decidedAt'>>;

/** Терминал төлөвт шилжүүлэх patch (PENDING-ээс л) */
export interface DecisionPatch {
  status: Exclude<ChangeRequestStatus, 'PENDING'>;
  checkerId?: string | null; checkerRoles?: string[]; checkerComment?: string | null; failureReason?: string | null;
  decidedAt: Date; updatedBy: string;
}

export interface HistoryEntry {
  event: ChangeRequestEvent; fromStatus: ChangeRequestStatus | null; toStatus: ChangeRequestStatus;
  actorId: string | null; actorRoles: string[]; comment: string | null; data?: unknown; at: Date;
}
export interface HistoryRow extends HistoryEntry { seq: number; data: unknown | null }

export interface PolicyRow {
  orgId: string; targetType: string; action: string; enabled: boolean; checkerRoles: string[]; expiresInHours: number;
  updatedAt: Date; updatedBy: string;
}

export interface ListFilter {
  scope: ChangeRequestScope; actor: Actor; now: Date;
  status?: ChangeRequestStatus; targetType?: string; applicationId?: string;
  page: number; pageSize: number;
}

/** Нэг DB транзакц доторх үйлдлүүд. `db` нь handler-д өгөгдөх үндсэн tx handle (Prisma бол Prisma.TransactionClient). */
export interface ChangeRequestTx {
  readonly db: unknown;
  /** SELECT … FOR UPDATE — зэрэг батлалтыг цуваа болгоно */
  lock(orgId: string, id: string): Promise<ChangeRequestRow | null>;
  /**
   * Нэг зорилтын (org, targetType, targetId) бүх илгээлтийг цуваа болгоно: advisory lock авч, тухайн зорилтын PENDING мөр байвал
   * `FOR UPDATE`-ээр түгжээд буцаана. submit() tx-ийн ЭХЭНД (snapshot, insert-ээс өмнө) дуудна — ингэснээр DIRECT/PENDING аль нь ч
   * хоорондоо уралдахгүй, snapshot нь зэрэг хэрэгжиж буй батлалтын дараах төлөвийг үзнэ (MC-BR-5).
   */
  lockTarget(orgId: string, targetType: string, targetId: string): Promise<ChangeRequestRow | null>;
  /** Нэг зорилтод PENDING давхардвал PendingConflictError */
  insert(row: NewChangeRequest, createdBy: string): Promise<ChangeRequestRow>;
  update(id: string, patch: DecisionPatch): Promise<ChangeRequestRow>;
  appendHistory(requestId: string, entry: HistoryEntry): Promise<void>;
  /** Transactional outbox (CLAUDE.md §3.2.4) */
  enqueue(event: DomainEvent): Promise<void>;
  /** Системийн нэгдсэн `audit_log` (NFR-4, @los/database recordAudit). Ил PII-гүй: төлөв, зорилтын төрөл/ID л */
  audit(entry: AuditInput): Promise<void>;
  /** Хугацаа дууссан PENDING мөрүүдийг түгжинэ (SKIP LOCKED); `orgId` өгвөл зөвхөн тухайн байгууллагынх */
  lockOverdue(now: Date, limit: number, orgId?: string): Promise<ChangeRequestRow[]>;
  getPolicy(orgId: string, targetType: string, action: string): Promise<PolicyRow | null>;
  upsertPolicy(policy: Omit<PolicyRow, 'updatedAt'>): Promise<PolicyRow>;
}

export interface ChangeRequestStore {
  transaction<T>(fn: (tx: ChangeRequestTx) => Promise<T>): Promise<T>;
  getPolicy(orgId: string, targetType: string, action: string): Promise<PolicyRow | null>;
  listPolicies(orgId: string): Promise<PolicyRow[]>;
  getById(orgId: string, id: string): Promise<ChangeRequestRow | null>;
  getHistory(id: string): Promise<HistoryRow[]>;
  list(orgId: string, filter: ListFilter): Promise<{ rows: ChangeRequestRow[]; total: number }>;
  count(orgId: string, filter: Pick<ListFilter, 'scope' | 'actor' | 'now'>): Promise<number>;
}

export class PendingConflictError extends Error {
  constructor() { super('target already has a pending change request'); this.name = 'PendingConflictError'; }
}

/** Мөрийн түгжээг хугацаандаа авч чадаагүй (өөр tx удаан барьж байна). Дахин оролдох боломжтой — service 409 DECISION_IN_PROGRESS болгоно. */
export class LockTimeoutError extends Error {
  constructor() { super('could not obtain the row lock in time'); this.name = 'LockTimeoutError'; }
}

export const CHANGE_REQUEST_STORE = Symbol('CHANGE_REQUEST_STORE');
