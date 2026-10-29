// SigningStore-ын Prisma/Postgres гүйцэтгэл (prod). Бүх бичилт (мөр + аудит + outbox) НЭГ транзакцид — CLAUDE.md §3.2.4.
// transition() нь compare-and-set: `UPDATE … WHERE id AND status IN from` — өрсөлдөгч түрүүлсэн бол 0 мөр → null.
import { Prisma } from '.prisma/client-dms';
import type { ESignProvider, SigningStatus } from '@los/contracts';
import { enqueueOutbox } from '@los/database';
import { isUuid, sanitizeDbError } from './db-errors';
import type { Clock } from '../../../integrations/esign/esign-provider.port';
import type { SensitiveFieldCipher } from '../ports/field-cipher.port';
import type { NewSigningRequest, SigningAuditEntry, SigningRequestRecord, SigningStore, TransitionEffects } from '../ports/signing.store';
import {
  ActiveSigningExistsError, SigningConstraintError, SigningRequestNotFoundError, SigningUniqueViolationError, type SigningUniqueField,
} from './errors';
import { toColumns, toJsonObject, toRecord } from './prisma-signing.mapper';
import { buildNewRecord, normalizeAudit, sanitizePatch, type SigningRecordPatch } from './signing-store.shared';

type Tx = Prisma.TransactionClient;
/** Бодит `PrismaService` (extends PrismaClient) эсвэл түүнтэй ижил хэлбэр (`$transaction`, `signingRequest`, `signingEvent`) */
type PrismaClientLike = Pick<import('.prisma/client-dms').PrismaClient, '$transaction' | 'signingRequest' | 'signingEvent'>;
type UniqueTarget = SigningUniqueField | 'contract';

// Prisma мессеж Postgres-ийн алдааг escape-тэй (\"name\") агуулдаг
const CHECK_VIOLATION = /violates check constraint \\?"([A-Za-z0-9_]+)\\?"/;

/** P2002-ийн `meta.target` (багана эсвэл constraint-ийн нэр) → аль unique зөрчигдсөн бэ */
function uniqueTarget(error: Prisma.PrismaClientKnownRequestError): UniqueTarget | null {
  const raw = error.meta?.target;
  const target = (Array.isArray(raw) ? raw.join(',') : String(raw ?? ''));
  if (error.meta?.modelName === 'Outbox') return /(^|,)id$|pkey/.test(target) ? 'eventId' : null;
  if (/contract_id|active_contract/.test(target)) return 'contract';
  if (/token_hash/.test(target)) return 'tokenHash';
  if (/verification_code/.test(target)) return 'verificationCode';
  if (/provider_ref/.test(target)) return 'providerRef';
  if (/(^|,)id$|pkey/.test(target)) return 'id';
  return null;
}

export class PrismaSigningStore implements SigningStore {
  constructor(
    private readonly prisma: PrismaClientLike,
    private readonly clock: Clock,
    private readonly cipher: SensitiveFieldCipher,
  ) {}

  async create(input: NewSigningRequest, effects?: TransitionEffects): Promise<SigningRequestRecord> {
    if (!isUuid(input.id)) throw new SigningConstraintError('signing_request_id_uuid');
    const record = buildNewRecord(input, this.clock());
    try {
      return await this.prisma.$transaction(async (tx) => {
        // toColumns: record бүтэн тул create-ийн шаардлагатай бүх талбар байгаа
        const row = await tx.signingRequest.create({ data: toColumns(record, this.cipher) as Prisma.SigningRequestUncheckedCreateInput });
        await this.writeEffects(tx, row.id, effects);
        return toRecord(row, this.cipher);
      });
    } catch (error) {
      throw this.mapError('signing.create', error, record.contractId);
    }
  }

  getById(id: string): Promise<SigningRequestRecord | null> {
    if (!isUuid(id)) return Promise.resolve(null);
    return this.findOne('signing.getById', { id });
  }

  getByTokenHash(tokenHash: string): Promise<SigningRequestRecord | null> {
    return this.findOne('signing.getByTokenHash', { tokenHash });
  }

  getByProviderRef(provider: ESignProvider, providerRef: string): Promise<SigningRequestRecord | null> {
    return this.findOne('signing.getByProviderRef', { provider_providerRef: { provider, providerRef } });
  }

  getByVerificationCode(code: string): Promise<SigningRequestRecord | null> {
    return this.findOne('signing.getByVerificationCode', { verificationCode: code });
  }

  /** Шинэ нь түрүүлж: createdAt буурах, ижил бол id буурах */
  async listByApplication(applicationId: string): Promise<SigningRequestRecord[]> {
    try {
      const rows = await this.prisma.signingRequest.findMany({ where: { applicationId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
      return rows.map((row) => toRecord(row, this.cipher));
    } catch (error) {
      throw this.mapError('signing.listByApplication', error);
    }
  }

  async findActiveByContract(contractId: string): Promise<SigningRequestRecord | null> {
    try {
      const row = await this.prisma.signingRequest.findFirst({ where: { contractId, status: { in: ['PENDING', 'IN_PROGRESS', 'FINALIZING'] } } });
      return row ? toRecord(row, this.cipher) : null;
    } catch (error) {
      throw this.mapError('signing.findActiveByContract', error);
    }
  }

  async transition(id: string, from: SigningStatus[], patch: SigningRecordPatch, effects?: TransitionEffects): Promise<SigningRequestRecord | null> {
    if (!isUuid(id)) return null;
    const data = { ...toColumns(sanitizePatch(patch), this.cipher), updatedAt: this.clock() };
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Compare-and-set: өрсөлдөгч tx түрүүлж commit хийсэн бол READ COMMITTED дор WHERE дахин үнэлэгдэж 0 мөр өөрчлөгдөнө
        const { count } = await tx.signingRequest.updateMany({ where: { id, status: { in: from } }, data });
        if (count === 0) return null;
        const row = await tx.signingRequest.findUniqueOrThrow({ where: { id } });
        await this.writeEffects(tx, id, effects);
        return toRecord(row, this.cipher);
      });
    } catch (error) {
      throw await this.mapTransitionError(id, error);
    }
  }

  async appendAudit(id: string, entry: SigningAuditEntry): Promise<void> {
    if (!isUuid(id)) throw new SigningRequestNotFoundError(id);
    try {
      await this.prisma.signingEvent.create({ data: this.auditData(id, entry) });
    } catch (error) {
      throw this.mapError('signing.appendAudit', error, undefined, id);
    }
  }

  async listAudit(id: string): Promise<SigningAuditEntry[]> {
    if (!isUuid(id)) return [];
    try {
      const rows = await this.prisma.signingEvent.findMany({ where: { signingRequestId: id }, orderBy: [{ at: 'asc' }, { id: 'asc' }] });
      return rows.map((row) => ({
        type: row.type as SigningAuditEntry['type'],
        actor: row.actor,
        at: row.at,
        ip: row.ip,
        userAgent: row.userAgent,
        detail: row.detail as Record<string, unknown>,
      }));
    } catch (error) {
      throw this.mapError('signing.listAudit', error);
    }
  }

  /** link_expires_at < now бөгөөд PENDING|IN_PROGRESS, session_expires_at < now бөгөөд IN_PROGRESS, эсвэл FINALIZING нь finalizingStaleBefore-оос өмнө шинэчлэгдсэн; link_expires_at өсөх, ижил бол id өсөх */
  async listExpirable(now: Date, finalizingStaleBefore: Date, limit: number): Promise<SigningRequestRecord[]> {
    if (limit <= 0) return [];
    try {
      const rows = await this.prisma.signingRequest.findMany({
        where: {
          OR: [
            { status: { in: ['PENDING', 'IN_PROGRESS'] }, linkExpiresAt: { lt: now } },
            // provider session дууссан IN_PROGRESS: poll/webhook-гүй баталгаажсан байж болох тул sweeper provider-оос асууна
            { status: 'IN_PROGRESS', sessionExpiresAt: { lt: now } },
            { status: 'FINALIZING', updatedAt: { lt: finalizingStaleBefore } },
          ],
        },
        orderBy: [{ linkExpiresAt: 'asc' }, { id: 'asc' }],
        take: Math.floor(limit),
      });
      return rows.map((row) => toRecord(row, this.cipher));
    } catch (error) {
      throw this.mapError('signing.listExpirable', error);
    }
  }

  private async findOne(operation: string, where: Prisma.SigningRequestWhereUniqueInput): Promise<SigningRequestRecord | null> {
    try {
      const row = await this.prisma.signingRequest.findUnique({ where });
      return row ? toRecord(row, this.cipher) : null;
    } catch (error) {
      throw this.mapError(operation, error);
    }
  }

  private auditData(id: string, entry: SigningAuditEntry): Prisma.SigningEventUncheckedCreateInput {
    const { type, actor, at, ip, userAgent, detail } = normalizeAudit(entry);
    return { signingRequestId: id, type, actor, at, ip, userAgent, detail: toJsonObject(detail) };
  }

  private async writeEffects(tx: Tx, id: string, effects: TransitionEffects | undefined): Promise<void> {
    if (effects?.audit?.length) await tx.signingEvent.createMany({ data: effects.audit.map((entry) => this.auditData(id, entry)) });
    for (const event of effects?.events ?? []) await enqueueOutbox(tx, event);
  }

  /** Domain error руу хөрвүүлнэ; бусад нь мөрийн утгагүй DbOperationError */
  private mapError(operation: string, error: unknown, contractId?: string, signingRequestId?: string): Error {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        const target = uniqueTarget(error);
        if (target === 'contract') return new ActiveSigningExistsError(contractId ?? 'unknown');
        if (target) return new SigningUniqueViolationError(target);
      }
      if (error.code === 'P2003' && signingRequestId !== undefined) return new SigningRequestNotFoundError(signingRequestId);
    }
    const constraint = error instanceof Error ? CHECK_VIOLATION.exec(error.message)?.[1] : undefined;
    if (constraint) return new SigningConstraintError(constraint);
    return sanitizeDbError(operation, error);
  }

  // transition-д гэрээний id мэдэгдэхгүй (мөр шинэчлэгдээгүй) тул идэвхтэй-давхардлын үед түүнийг тусад нь уншина
  private async mapTransitionError(id: string, error: unknown): Promise<Error> {
    const mapped = this.mapError('signing.transition', error, 'unknown');
    if (!(mapped instanceof ActiveSigningExistsError)) return mapped;
    const row = await this.prisma.signingRequest.findUnique({ where: { id }, select: { contractId: true } }).catch(() => null);
    return new ActiveSigningExistsError(row?.contractId ?? 'unknown');
  }
}
