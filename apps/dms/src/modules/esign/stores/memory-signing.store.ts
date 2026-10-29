// SigningStore-ын санах ойн гүйцэтгэл (тест, unit/e2e тест). PrismaSigningStore-той ИЖИЛ семантик:
// compare-and-set, unique хязгаарлалт (tokenHash, verificationCode, providerRef, нэг гэрээнд нэг идэвхтэй), CHECK дүрмүүд,
// (мөр + аудит + outbox) бүгд нэг "транзакцид" — аль нэг шалгалт унавал юу ч өөрчлөгдөхгүй. Дуудагч хадгалсан төлөвийг өөрчилж чадахгүй (хуулбар).
import type { DomainEvent, ESignProvider, SigningStatus } from '@los/contracts';
import type { Clock } from '../../../integrations/esign/esign-provider.port';
import type { NewSigningRequest, SigningAuditEntry, SigningRequestRecord, SigningStore, TransitionEffects } from '../ports/signing.store';
import { ActiveSigningExistsError, SigningConstraintError, SigningRequestNotFoundError, SigningUniqueViolationError } from './errors';
import {
  assertRecordConstraints, buildNewRecord, cloneRecord, isActiveStatus, jsonClone, normalizeAudit, sanitizePatch,
  type NormalizedAuditEntry, type SigningRecordPatch,
} from './signing-store.shared';
import { isUuid } from './db-errors';

export interface OutboxEntry {
  id: string;
  type: string;
  payload: DomainEvent;
}

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export class MemorySigningStore implements SigningStore {
  private readonly records = new Map<string, SigningRequestRecord>();
  private readonly auditByRequest = new Map<string, NormalizedAuditEntry[]>();
  private readonly outboxRows: OutboxEntry[] = [];

  constructor(private readonly clock: Clock) {}

  /** Зөвхөн тестэд: outbox-д бичигдсэн мөрүүд (хуулбар) */
  get outbox(): OutboxEntry[] {
    return jsonClone(this.outboxRows);
  }

  /** Зөвхөн тестэд: outbox-д бичигдсэн event-үүд (хуулбар) */
  get events(): DomainEvent[] {
    return this.outbox.map((row) => row.payload);
  }

  async create(input: NewSigningRequest, effects?: TransitionEffects): Promise<SigningRequestRecord> {
    if (!isUuid(input.id)) throw new SigningConstraintError('signing_request_id_uuid');
    const record = buildNewRecord(input, this.clock());
    assertRecordConstraints(record);
    this.assertUnique(record);
    const outboxRows = this.prepareOutbox(effects);
    this.records.set(record.id, record);
    this.commitEffects(record.id, effects, outboxRows);
    return cloneRecord(record);
  }

  async getById(id: string): Promise<SigningRequestRecord | null> {
    return this.copyOrNull(this.records.get(id));
  }

  async getByTokenHash(tokenHash: string): Promise<SigningRequestRecord | null> {
    return this.copyOrNull(this.find((record) => record.tokenHash === tokenHash));
  }

  async getByProviderRef(provider: ESignProvider, providerRef: string): Promise<SigningRequestRecord | null> {
    return this.copyOrNull(this.find((record) => record.provider === provider && record.providerRef === providerRef));
  }

  async getByVerificationCode(code: string): Promise<SigningRequestRecord | null> {
    return this.copyOrNull(this.find((record) => record.verificationCode === code));
  }

  /** Шинэ нь түрүүлж: createdAt буурах, ижил бол id буурах (PrismaSigningStore-той ижил) */
  async listByApplication(applicationId: string): Promise<SigningRequestRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.applicationId === applicationId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || compareIds(b.id, a.id))
      .map(cloneRecord);
  }

  async findActiveByContract(contractId: string): Promise<SigningRequestRecord | null> {
    return this.copyOrNull(this.find((record) => record.contractId === contractId && isActiveStatus(record.status)));
  }

  async transition(id: string, from: SigningStatus[], patch: SigningRecordPatch, effects?: TransitionEffects): Promise<SigningRequestRecord | null> {
    const current = this.records.get(id);
    if (!current || !from.includes(current.status)) return null;
    const next: SigningRequestRecord = { ...cloneRecord(current), ...structuredClone(sanitizePatch(patch)), updatedAt: new Date(this.clock()) };
    assertRecordConstraints(next);
    this.assertUnique(next, current.id);
    const outboxRows = this.prepareOutbox(effects);
    this.records.set(id, next);
    this.commitEffects(id, effects, outboxRows);
    return cloneRecord(next);
  }

  async appendAudit(id: string, entry: SigningAuditEntry): Promise<void> {
    if (!this.records.has(id)) throw new SigningRequestNotFoundError(id);
    this.auditList(id).push(normalizeAudit(entry));
  }

  async listAudit(id: string): Promise<SigningAuditEntry[]> {
    // at-аар тогтвортой эрэмбэ: ижил цагтай мөрүүд оруулсан дарааллаараа үлдэнэ
    return [...(this.auditByRequest.get(id) ?? [])].sort((a, b) => a.at.getTime() - b.at.getTime()).map((entry) => normalizeAudit(entry));
  }

  /** link_expires_at < now бөгөөд PENDING|IN_PROGRESS, эсвэл FINALIZING нь finalizingStaleBefore-оос өмнө шинэчлэгдсэн; link_expires_at өсөх, ижил бол id өсөх */
  async listExpirable(now: Date, finalizingStaleBefore: Date, limit: number): Promise<SigningRequestRecord[]> {
    if (limit <= 0) return [];
    return [...this.records.values()]
      .filter((record) => {
        if (record.status === 'PENDING') return record.linkExpiresAt < now;
        // IN_PROGRESS: линк эсвэл provider session дууссан (зээлдэгч poll/webhook-гүй баталгаажуулсан байж болно)
        if (record.status === 'IN_PROGRESS') return record.linkExpiresAt < now || (record.sessionExpiresAt !== null && record.sessionExpiresAt < now);
        return record.status === 'FINALIZING' && record.updatedAt < finalizingStaleBefore;
      })
      .sort((a, b) => a.linkExpiresAt.getTime() - b.linkExpiresAt.getTime() || compareIds(a.id, b.id))
      .slice(0, limit)
      .map(cloneRecord);
  }

  private find(predicate: (record: SigningRequestRecord) => boolean): SigningRequestRecord | undefined {
    for (const record of this.records.values()) if (predicate(record)) return record;
    return undefined;
  }

  private copyOrNull(record: SigningRequestRecord | undefined): SigningRequestRecord | null {
    return record ? cloneRecord(record) : null;
  }

  private auditList(id: string): NormalizedAuditEntry[] {
    let list = this.auditByRequest.get(id);
    if (!list) {
      list = [];
      this.auditByRequest.set(id, list);
    }
    return list;
  }

  /** DB-ийн unique index-үүдийн толь. Шалгах дараалал нь миграцийн index үүсгэсэн дараалал (pkey, token_hash, verification_code, provider+ref, идэвхтэй) */
  private assertUnique(candidate: SigningRequestRecord, selfId?: string): void {
    const others = [...this.records.values()].filter((record) => record.id !== selfId);
    if (selfId === undefined && this.records.has(candidate.id)) throw new SigningUniqueViolationError('id');
    if (others.some((other) => other.tokenHash === candidate.tokenHash)) throw new SigningUniqueViolationError('tokenHash');
    if (candidate.verificationCode !== null && others.some((other) => other.verificationCode === candidate.verificationCode)) {
      throw new SigningUniqueViolationError('verificationCode');
    }
    if (candidate.provider !== null && candidate.providerRef !== null
      && others.some((other) => other.provider === candidate.provider && other.providerRef === candidate.providerRef)) {
      throw new SigningUniqueViolationError('providerRef');
    }
    if (isActiveStatus(candidate.status) && others.some((other) => other.contractId === candidate.contractId && isActiveStatus(other.status))) {
      throw new ActiveSigningExistsError(candidate.contractId);
    }
  }

  /** Outbox мөрүүдийг бэлтгэж, eventId давхардлыг (outbox.id PRIMARY KEY) өөрчлөлтөөс ӨМНӨ шалгана */
  private prepareOutbox(effects: TransitionEffects | undefined): OutboxEntry[] {
    const rows: OutboxEntry[] = [];
    const seen = new Set(this.outboxRows.map((row) => row.id));
    for (const event of effects?.events ?? []) {
      if (seen.has(event.eventId)) throw new SigningUniqueViolationError('eventId');
      seen.add(event.eventId);
      rows.push({ id: event.eventId, type: event.type, payload: jsonClone(event) });
    }
    return rows;
  }

  private commitEffects(id: string, effects: TransitionEffects | undefined, outboxRows: OutboxEntry[]): void {
    for (const entry of effects?.audit ?? []) this.auditList(id).push(normalizeAudit(entry));
    this.outboxRows.push(...outboxRows);
  }
}
