// FR-11.4 Цахим гарын үсгийн үйлчилгээ: хүсэлт үүсгэх, зээлдэгчийн линкийн урсгал, provider-тэй тулгах (poll / webhook / sweeper),
// finalization (шалгах → QR+штамп → DMS-д хадгалах → SIGNED) ба verify.
//
// Бүх төлөв шилжилт SigningStore.transition (compare-and-set) дамжина: poll, webhook, sweeper зэрэг өрсөлдөхөд яг нэг нь хожиж,
// SIGNED файлын багц, ContractSigned event нь ЯГ нэг гарна. Өөрчлөлт + аудит + outbox event нэг транзакцид (CLAUDE.md §3.2.4).
// PII (регистр, утас, нэр), токен нь лог/алдаа/audit/event-д орохгүй — зөвхөн id, төлөв, алдааны нэр/код (CLAUDE.md §6.5).
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ESIGN_CONSENT_VERSION,
  ESignProvider,
  type CreateSigningRequest,
  type ProviderOption,
  type PublicSigningSession,
  type SigningFailureReason,
  type SigningRequestView,
  type SigningStatus,
  type SigningVerification,
  type StartPublicSigning,
} from '@los/contracts';
import {
  CLOCK,
  ESignProviderError,
  type Clock,
  type ESignProviderPort,
  type ProviderSession,
  type ProviderSessionState,
  type ProviderSignature,
  type WebhookRequest,
} from '../../integrations/esign/esign-provider.port';
import { ProviderRegistry } from '../../integrations/esign/provider.registry';
import { sha256Hex, timingSafeEqualHex } from './domain/digest';
import { verifyProviderSignature } from './domain/finalization';
import { looksLikePdf, signatureFileName, signedPdfName, sourceDocumentName } from './domain/files';
import { maskName, maskPhone, maskRegister, normalizeRegister } from './domain/identity';
import { contractSigned, contractSigningFailed, contractSigningRequested, type EventOrigin } from './domain/signing-events';
import { canTransition, isActive } from './domain/status-machine';
import { generateLinkToken, hashToken, isLinkTokenShape } from './domain/tokens';
import { formatVerificationCode, generateVerificationCode, parseVerificationCode } from './domain/verification-code';
import { ESIGN_CONFIG, type EsignConfig } from './esign.config';
import {
  SigningConflictError,
  SigningFinalizationError,
  SigningGoneError,
  SigningNotFoundError,
  SigningProviderUnavailableError,
  SigningTooManyAttemptsError,
  SigningValidationError,
  SigningWebhookRejectedError,
} from './errors';
import { FIELD_CIPHER, type SensitiveFieldCipher } from './ports/field-cipher.port';
import { PDF_STAMPER, InvalidPdfError, type PdfStamper } from './ports/pdf-stamper.port';
import { FileIntegrityError, FileNotFoundError, SIGNING_FILES, type SigningFileContent, type SigningFiles } from './ports/signing-files.port';
import {
  SIGNING_STORE,
  type SigningAuditEntry,
  type SigningAuditType,
  type SigningRequestRecord,
  type SigningStore,
  type TransitionEffects,
} from './ports/signing.store';
import { ActiveSigningExistsError, SigningUniqueViolationError } from './stores/errors';

/** Ажилтны (дотоод) үйлдлийн контекст — gateway-ийн `X-User-Id`, `X-Correlation-Id` */
export interface RequestContext {
  actorId: string | null;
  correlationId: string;
  /** Ажилтны дуудлагад заавал (gateway-ийн `X-Org-Id`); өгвөл өөр байгууллагын хүсэлт "олдсонгүй" болно */
  orgId?: string;
}

/** `CreateSigningRequest` + дуудагчийн байгууллага (REST биш `X-Org-Id`-аас) */
export type CreateSigningInput = CreateSigningRequest & { orgId: string };

/** Зээлдэгчийн хүсэлтийн холболтын мэдээлэл — зөвхөн audit-д бичигдэнэ */
export interface ClientMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export interface SigningDocument {
  fileName: string;
  mime: string;
  bytes: Buffer;
  sha256: string;
}

export interface SweepResult {
  scanned: number;
  signed: number;
  expired: number;
  declined: number;
  failed: number;
  /** FINALIZING-д гацсан байсныг дахин оролдсон */
  retried: number;
  errors: number;
}

type RecordPatch = Partial<Omit<SigningRequestRecord, 'id' | 'createdAt'>>;
type TerminalTarget = 'DECLINED' | 'EXPIRED' | 'FAILED' | 'CANCELLED';

/** Провайдерын session-ий талбарууд: session дуусахад зээлдэгчид харуулахаа больно */
const SESSION_CLEARED = { challengeCode: null, deepLink: null, sessionExpiresAt: null } as const;
/** Зээлдэгч дахин сонгох боломжтой болгож PENDING рүү буцаахад session-ий бүх мөрийг цэвэрлэнэ */
const SESSION_RESET = { ...SESSION_CLEARED, provider: null, providerRef: null, providerMock: false } as const;

/** Provider session-ий төгсгөл → хүсэлтийн төгсгөлийн төлөв, шалтгаан (дахин оролдох боломжгүй үед) */
const SESSION_END_OUTCOME = {
  DECLINED: { to: 'DECLINED', reason: 'DECLINED' },
  EXPIRED: { to: 'EXPIRED', reason: 'EXPIRED' },
  FAILED: { to: 'FAILED', reason: 'PROVIDER_ERROR' },
} as const satisfies Record<string, { to: TerminalTarget; reason: SigningFailureReason }>;

type ProviderReading = { port: ESignProviderPort; state: ProviderSessionState } | { port: null; state: { state: 'EXPIRED' } };
type SignedFileRef = Pick<SigningRequestRecord, 'id' | 'orgId' | 'signedSha256'> & { signedFileId: string };

const SWEEP_BATCH_SIZE = 100;
/** Verification code давхцахад дахин үүсгэх оролдлого (60 бит тул бараг хэрэгжихгүй) */
const MAX_CODE_ATTEMPTS = 5;
const MAX_IP_LENGTH = 64;
const MAX_USER_AGENT_LENGTH = 256;
const HOUR_MS = 60 * 60 * 1000;
const PDF_MIME = 'application/pdf';
const SIGNATURE_MIME = 'application/pkcs7-signature';
const ZERO_SWEEP: SweepResult = { scanned: 0, signed: 0, expired: 0, declined: 0, failed: 0, retried: 0, errors: 0 };

/** Finalization-ий дахин оролдоход утгагүй (байнгын) алдаа: хүсэлт FAILED болно */
class FinalizationFailure extends Error {
  constructor(readonly reason: 'IDENTITY_MISMATCH' | 'INTEGRITY_ERROR', readonly detail: string) {
    super(`finalization failed: ${reason}/${detail}`);
    this.name = 'FinalizationFailure';
  }
}

/** Лог руу ЗӨВХӨН дуудагчийн өгсөн id/төлөв/тоо орно — PII-г талбарт хэзээ ч дамжуулахгүй */
const logLine = (event: string, fields: Record<string, string | number | boolean | null> = {}): string => JSON.stringify({ event, ...fields });

function describeError(error: unknown): Record<string, string> {
  if (error instanceof ESignProviderError) return { errorName: error.name, errorCode: error.code };
  if (error instanceof Error) return { errorName: error.name };
  return { errorName: 'UnknownError' };
}

function cleanMeta(value: string | null | undefined, max: number): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex -- header-ээс орж ирсэн утгаас хяналтын тэмдэгтийг арилгана (log/audit injection)
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
  return cleaned === '' ? null : cleaned;
}

@Injectable()
export class SigningService {
  private readonly logger = new Logger(SigningService.name);

  constructor(
    @Inject(SIGNING_STORE) private readonly store: SigningStore,
    @Inject(SIGNING_FILES) private readonly files: SigningFiles,
    @Inject(PDF_STAMPER) private readonly stamper: PdfStamper,
    @Inject(FIELD_CIPHER) private readonly cipher: SensitiveFieldCipher,
    @Inject(ProviderRegistry) private readonly providers: ProviderRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ESIGN_CONFIG) private readonly config: EsignConfig,
  ) {}

  // ───────────────────────── Ажилтны (origination → dms) API ─────────────────────────

  /** Хүсэлт үүсгэж, зээлдэгчийн ганцаарчилсан линк (`signingUrl`) буцаана. Токен ЗӨВХӨН энэ буцаах утгаар гарна — хадгалагдахгүй */
  async createRequest(dto: CreateSigningInput, ctx: RequestContext): Promise<{ record: SigningRequestRecord; signingUrl: string }> {
    const registerNo = normalizeRegister(dto.signer.registerNo);
    if (registerNo.length < 8) throw new SigningValidationError('INVALID_SIGNER');
    const source = await this.readSourceForCreate(dto.orgId, dto.sourceFileId);

    const active = await this.store.findActiveByContract(dto.contractId);
    if (active) {
      if (!dto.supersedeActive) throw new SigningConflictError('ACTIVE_EXISTS', active.id);
      await this.supersede(active, ctx);
    }

    const now = this.clock();
    const id = randomUUID();
    const token = generateLinkToken();
    const linkExpiresAt = new Date(now.getTime() + (dto.ttlHours ?? this.config.linkTtlHours) * HOUR_MS);
    const origin: EventOrigin = { now, actorId: ctx.actorId, correlationId: ctx.correlationId };
    const subject = { id, orgId: dto.orgId, applicationId: dto.applicationId, contractId: dto.contractId, contractNo: dto.contractNo };
    try {
      const record = await this.store.create(
        {
          ...subject,
          sourceFileId: dto.sourceFileId,
          originalSha256: source.sha256,
          signerCustomerId: dto.signer.customerId,
          signerName: dto.signer.fullName,
          signerRegisterEnc: this.cipher.encrypt(registerNo),
          signerPhoneEnc: this.cipher.encrypt(dto.signer.phone),
          signerRegisterMasked: maskRegister(registerNo),
          signerPhoneMasked: maskPhone(dto.signer.phone),
          tokenHash: hashToken(token),
          linkExpiresAt,
          correlationId: ctx.correlationId,
          createdBy: ctx.actorId,
        },
        {
          audit: [
            {
              type: 'CREATED',
              actor: ctx.actorId ?? 'SYSTEM',
              at: now,
              // preferredProvider-ийг record-д багана байхгүй тул энд хадгалж, public урсгал CREATED мөрөөс уншина
              detail: { preferredProvider: dto.preferredProvider ?? null, superseded: active !== null, linkTtlHours: dto.ttlHours ?? this.config.linkTtlHours },
            },
          ],
          events: [contractSigningRequested({ ...subject, linkExpiresAt }, origin)],
        },
      );
      this.logger.log(logLine('esign.created', { signingRequestId: record.id, contractId: record.contractId, correlationId: ctx.correlationId }));
      return { record, signingUrl: this.signingUrl(token) };
    } catch (error) {
      // Зэрэгцээ create: DB-ийн partial unique index хожигдсон хүсэлтийг барина
      if (error instanceof ActiveSigningExistsError) throw new SigningConflictError('ACTIVE_EXISTS');
      throw error;
    }
  }

  /** Токеныг шинэчилж (хуучин нь тэр даруй үхнэ) линкийн хугацааг сунгана. Зөвхөн PENDING | IN_PROGRESS */
  async resend(id: string, ctx: RequestContext): Promise<{ record: SigningRequestRecord; signingUrl: string }> {
    const record = await this.get(id, ctx.orgId);
    if (record.status !== 'PENDING' && record.status !== 'IN_PROGRESS') throw new SigningConflictError('INVALID_STATE');
    const now = this.clock();
    const token = generateLinkToken();
    // Хуучин хугацаанаас богиносгохгүй (хүсэлт 168 цагаар үүссэн байж болно)
    const linkExpiresAt = new Date(Math.max(record.linkExpiresAt.getTime(), now.getTime() + this.config.linkTtlHours * HOUR_MS));
    const rotated = await this.store.transition(
      id,
      [record.status],
      { tokenHash: hashToken(token), linkExpiresAt },
      { audit: [{ type: 'LINK_ROTATED', actor: ctx.actorId ?? 'SYSTEM', at: now, detail: { linkExpiresAt: linkExpiresAt.toISOString() } }] },
    );
    if (!rotated) throw new SigningConflictError('INVALID_STATE');
    this.logger.log(logLine('esign.link_rotated', { signingRequestId: id, correlationId: ctx.correlationId }));
    return { record: rotated, signingUrl: this.signingUrl(token) };
  }

  /** PENDING | IN_PROGRESS → CANCELLED. Аль хэдийн CANCELLED бол өөрчлөлтгүй буцаана (idempotent) */
  async cancel(id: string, ctx: RequestContext): Promise<SigningRequestRecord> {
    const record = await this.get(id, ctx.orgId);
    if (record.status === 'CANCELLED') return record;
    if (record.status !== 'PENDING' && record.status !== 'IN_PROGRESS') throw new SigningConflictError('INVALID_STATE');
    const cancelled = await this.terminate(record, {
      from: [record.status],
      to: 'CANCELLED',
      reason: 'CANCELLED',
      auditType: 'CANCELLED',
      actor: ctx.actorId ?? 'SYSTEM',
      origin: { actorId: ctx.actorId, correlationId: ctx.correlationId },
    });
    if (!cancelled) throw new SigningConflictError('INVALID_STATE');
    await this.cancelProviderSession(record);
    return cancelled;
  }

  /** `orgId` өгвөл өөр байгууллагын хүсэлт олдоогүйтэй ижил (404) — org-ийн оршихуйг задруулахгүй */
  async get(id: string, orgId?: string): Promise<SigningRequestRecord> {
    const record = await this.store.getById(id);
    if (!record || (orgId !== undefined && record.orgId !== orgId)) throw new SigningNotFoundError();
    return record;
  }

  /** Шинэ нь түрүүлж */
  async listByApplication(applicationId: string, orgId?: string): Promise<SigningRequestRecord[]> {
    const records = await this.store.listByApplication(applicationId);
    return orgId === undefined ? records : records.filter((record) => record.orgId === orgId);
  }

  /** Ажилтны харагдац — ЗӨВХӨН далдалсан PII. `signingUrl` нь create/resend-ийн хариунд л */
  toView(record: SigningRequestRecord, signingUrl?: string): SigningRequestView {
    return {
      id: record.id,
      orgId: record.orgId,
      applicationId: record.applicationId,
      contractId: record.contractId,
      contractNo: record.contractNo,
      status: record.status,
      provider: record.provider,
      providerMock: record.providerMock,
      signerCustomerId: record.signerCustomerId,
      signerNameMasked: maskName(record.signerName),
      signerPhoneMasked: record.signerPhoneMasked,
      linkExpiresAt: record.linkExpiresAt.toISOString(),
      signedAt: record.signedAt?.toISOString() ?? null,
      signedFileId: record.signedFileId,
      signatureFileId: record.signatureFileId,
      verificationCode: record.verificationCode === null ? null : formatVerificationCode(record.verificationCode),
      failureReason: record.failureReason,
      createdAt: record.createdAt.toISOString(),
      ...(signingUrl === undefined ? {} : { signingUrl }),
    };
  }

  /** Гарын үсэгтэй PDF (ажилтан). `ctx` өгвөл татсан аудитад хэн татсаныг бичнэ */
  async getSignedDocument(id: string, ctx?: RequestContext): Promise<SigningDocument> {
    const record = this.requireSigned(await this.get(id, ctx?.orgId));
    const file = await this.readSignedPdf(record);
    await this.auditDownload(record, ctx?.actorId ?? 'SYSTEM', undefined);
    return { fileName: file.name, mime: file.mime, bytes: file.bytes, sha256: file.sha256 };
  }

  /** Provider-ийн CMS (`.p7s`) гарын үсэг (ажилтан) */
  async getSignature(id: string, ctx?: RequestContext): Promise<SigningDocument> {
    const record = this.requireSigned(await this.get(id, ctx?.orgId));
    const file = await this.files.read(record.orgId, record.signatureFileId);
    await this.auditDownload(record, ctx?.actorId ?? 'SYSTEM', undefined);
    return { fileName: file.name, mime: file.mime, bytes: file.bytes, sha256: file.sha256 };
  }

  // ───────────────────────── Зээлдэгчийн (public, токентой) API ─────────────────────────

  async getPublicSession(token: string, meta: ClientMeta): Promise<PublicSigningSession> {
    const record = await this.settle(await this.resolveToken(token));
    if (record.documentViewedAt === null && (record.status === 'PENDING' || record.status === 'IN_PROGRESS') && !this.isExpired(record)) {
      await this.store.appendAudit(record.id, this.audit('OPENED', 'BORROWER', this.clock(), meta));
    }
    return this.publicSession(record);
  }

  /** Эх гэрээний PDF-ийг зээлдэгчид үзүүлж, "үзсэн" гэж тэмдэглэнэ. Зөвхөн PENDING | IN_PROGRESS */
  async getDocumentForReview(token: string, meta: ClientMeta): Promise<SigningDocument> {
    const record = await this.settle(await this.resolveToken(token));
    this.assertOpen(record);
    const source = await this.readSourceForReview(record);
    if (record.documentViewedAt === null) {
      const now = this.clock();
      // Төлөв шилжсэн бол (null) үзсэн тэмдэг тавихгүй — тухайн шилжилт өөрөө үр дүнгээ шийдсэн
      await this.store.transition(record.id, [record.status], { documentViewedAt: now }, { audit: [this.audit('DOCUMENT_VIEWED', 'BORROWER', now, meta)] });
    }
    return { fileName: source.name, mime: PDF_MIME, bytes: source.bytes, sha256: source.sha256 };
  }

  /** Зөвшөөрөл өгч provider сонгон session нээнэ (PENDING → IN_PROGRESS) */
  async start(token: string, dto: StartPublicSigning, meta: ClientMeta): Promise<PublicSigningSession> {
    const record = await this.settle(await this.resolveToken(token));
    this.assertOpen(record);
    if (record.status !== 'PENDING') throw new SigningConflictError('INVALID_STATE');
    if (record.documentViewedAt === null) throw new SigningValidationError('DOCUMENT_NOT_VIEWED');
    if ((dto.consent as boolean) !== true) throw new SigningValidationError('CONSENT_REQUIRED');
    // Зээлдэгч харсан текстийн хувилбар одоогийнхтой таарна (текст өөрчлөгдсөн бол дахин харуулж зөвшөөрүүлнэ)
    if (dto.consentVersion !== ESIGN_CONSENT_VERSION) throw new SigningValidationError('CONSENT_VERSION_MISMATCH');
    if (record.attempts >= this.config.maxAttempts) throw new SigningTooManyAttemptsError(this.config.maxAttempts);

    const port = this.providers.list().find((candidate) => candidate.code === dto.provider);
    if (!port) throw new SigningValidationError('PROVIDER_NOT_AVAILABLE');
    const pinned = await this.pinnedProvider(record);
    if (pinned !== null && pinned !== dto.provider) throw new SigningValidationError('PROVIDER_NOT_ALLOWED');

    const now = this.clock();
    const remainingSeconds = Math.floor((record.linkExpiresAt.getTime() - now.getTime()) / 1000);
    if (remainingSeconds < 1) throw new SigningGoneError('EXPIRED', record.status);

    let session: ProviderSession;
    try {
      session = await port.createSession({
        signingRequestId: record.id,
        document: { name: sourceDocumentName(record.contractNo), digest: { algorithm: 'SHA-256', hex: record.originalSha256 } },
        signer: { fullName: record.signerName, registerNo: this.cipher.decrypt(record.signerRegisterEnc), phone: this.cipher.decrypt(record.signerPhoneEnc) },
        callbackUrl: `${this.config.callbackBaseUrl}/public/esign/callback/${port.code.toLowerCase()}`,
        ttlSeconds: Math.min(this.config.sessionTtlSeconds, remainingSeconds),
        correlationId: record.correlationId,
      });
    } catch (error) {
      throw this.providerFailure('createSession', port.code, error);
    }

    const attempt = record.attempts + 1;
    let started: SigningRequestRecord | null;
    try {
      started = await this.move(
        record,
        ['PENDING'],
        'IN_PROGRESS',
        {
          provider: port.code,
          providerRef: session.providerRef,
          providerMock: port.isMock,
          challengeCode: session.challengeCode,
          deepLink: session.deepLink,
          sessionExpiresAt: session.expiresAt,
          attempts: attempt,
          consentAt: now,
          failureReason: null,
          failureDetail: null,
        },
        {
          audit: [
            this.audit('CONSENT_GIVEN', 'BORROWER', now, meta, { provider: port.code, consentVersion: dto.consentVersion }),
            this.audit('PROVIDER_SESSION_STARTED', 'BORROWER', now, meta, { provider: port.code, attempt, ttlSeconds: Math.min(this.config.sessionTtlSeconds, remainingSeconds) }),
          ],
        },
      );
    } catch (error) {
      await this.cancelSessionQuietly(port, session.providerRef);
      throw error;
    }
    if (!started) {
      // Зэрэгцээ start эсвэл expire хожсон: бидний нээсэн session-ийг хаана
      await this.cancelSessionQuietly(port, session.providerRef);
      throw new SigningConflictError('INVALID_STATE');
    }
    return this.publicSession(started);
  }

  /** Статус poll: IN_PROGRESS бол provider-оос асууж, шилжилт хийж, SIGNED болсон бол finalize хийнэ */
  async refresh(token: string, _meta: ClientMeta): Promise<PublicSigningSession> {
    return this.publicSession(await this.advanceTolerant(await this.resolveToken(token)));
  }

  /** Зээлдэгч татгалзана. Provider session нээлттэй (IN_PROGRESS) үед л боломжтой — PENDING нь машины шилжилтэд байхгүй */
  async decline(token: string, meta: ClientMeta): Promise<PublicSigningSession> {
    const record = await this.settle(await this.resolveToken(token));
    if (record.status === 'DECLINED') return this.publicSession(record);
    this.assertOpen(record);
    if (record.status !== 'IN_PROGRESS') throw new SigningConflictError('INVALID_STATE');
    const declined = await this.terminate(record, {
      from: ['IN_PROGRESS'],
      to: 'DECLINED',
      reason: 'DECLINED',
      detail: 'BORROWER',
      auditType: 'FAILED',
      actor: 'BORROWER',
      meta,
      origin: { actorId: null, correlationId: record.correlationId },
    });
    if (!declined) throw new SigningConflictError('INVALID_STATE');
    await this.cancelProviderSession(record);
    return this.publicSession(declined);
  }

  async getSignedDocumentForBorrower(token: string, meta: ClientMeta): Promise<SigningDocument> {
    const record = await this.resolveToken(token);
    if (record.status !== 'SIGNED') {
      if (isActive(record.status)) throw new SigningConflictError('INVALID_STATE');
      throw new SigningGoneError(record.status === 'EXPIRED' ? 'EXPIRED' : 'TERMINAL', record.status);
    }
    // Токен нь bearer credential: гарын үсэг зурагдсанаас хойш `signedCopyTtlDays` хүртэл л өөрийн хувийг татна (линкийн хугацаа дууссан ч); дараа нь ажилтан getSignedDocument-ээр өгнө
    if (this.isSignedCopyExpired(record)) throw new SigningGoneError('EXPIRED', record.status);
    if (!record.signedFileId) throw new SigningConflictError('INVALID_STATE');
    const file = await this.readSignedPdf({ id: record.id, orgId: record.orgId, signedFileId: record.signedFileId, signedSha256: record.signedSha256 });
    await this.auditDownload(record, 'BORROWER', meta);
    return { fileName: file.name, mime: file.mime, bytes: file.bytes, sha256: file.sha256 };
  }

  /** QR-ийн хуудас: зөвхөн SIGNED. Регистр, утас, файлын id БУЦААХГҮЙ. `valid` = хадгалсан гарын үсэгтэй PDF бүрэн бүтэн эсэх */
  async verify(code: string): Promise<SigningVerification> {
    const parsed = parseVerificationCode(code);
    const record = parsed === null ? null : await this.store.getByVerificationCode(parsed);
    if (!record || record.status !== 'SIGNED' || !record.certificate || !record.provider || !record.signedAt || !record.signedSha256 || !record.signedFileId) {
      throw new SigningNotFoundError();
    }
    return {
      valid: await this.isSignedFileIntact({ id: record.id, orgId: record.orgId, signedFileId: record.signedFileId, signedSha256: record.signedSha256 }),
      contractNo: record.contractNo,
      signerNameMasked: maskName(record.signerName),
      provider: record.provider,
      signedAt: record.signedAt.toISOString(),
      originalSha256: record.originalSha256,
      signedSha256: record.signedSha256,
      certificateIssuer: record.certificate.issuer,
      certificateSerial: record.certificate.serialNumber,
      mock: record.providerMock,
    };
  }

  // ───────────────────────── Provider webhook, sweeper ─────────────────────────

  /**
   * Webhook-ийг provider-ийн өөрийн шалгалтаар (гарын үсэг/нууц) баталгаажуулж, ЗӨВХӨН `providerRef`-ийг авна.
   * Төлөвийг webhook-ийн биеэс ХЭЗЭЭ Ч итгэхгүй — provider.getSession-оор дахин асууж шийднэ. `providerCode`: `tridum` | `MONPASS` …
   */
  async handleWebhook(providerCode: string, req: WebhookRequest): Promise<void> {
    const code = ESignProvider.find((candidate) => candidate === providerCode.toUpperCase());
    const port = code ? this.providers.list().find((candidate) => candidate.code === code) : undefined;
    if (!port) throw new SigningNotFoundError();
    let providerRef: string;
    try {
      providerRef = port.parseWebhook(req).providerRef;
    } catch (error) {
      this.logger.warn(logLine('esign.webhook.rejected', { provider: port.code, ...describeError(error) }));
      throw new SigningWebhookRejectedError();
    }
    const record = await this.store.getByProviderRef(port.code, providerRef);
    if (!record) {
      // Баталгаажсан ч бидэнд үл мэдэгдэх session (өөр орчин) — provider дахин илгээхгүйн тулд 2xx
      this.logger.warn(logLine('esign.webhook.unknown_session', { provider: port.code }));
      return;
    }
    await this.store.appendAudit(record.id, this.audit('WEBHOOK_RECEIVED', 'PROVIDER', this.clock(), undefined, { provider: port.code }));
    await this.advance(record);
  }

  /**
   * Хугацаа дууссан PENDING | IN_PROGRESS-ийг хаана (IN_PROGRESS бол эхлээд provider-оос асууна: аль хэдийн SIGNED бол finalize),
   * FINALIZING-д гацсаныг дахин оролдоно. Бичлэг тус бүрийн алдааг тусад нь барина — нэг нь бусдыг зогсоохгүй.
   */
  async sweep(): Promise<SweepResult> {
    const now = this.clock();
    const staleBefore = new Date(now.getTime() - this.config.finalizingStaleSec * 1000);
    const due = await this.store.listExpirable(now, staleBefore, SWEEP_BATCH_SIZE);
    const result: SweepResult = { ...ZERO_SWEEP, scanned: due.length };
    for (const record of due) {
      const stale = record.status === 'FINALIZING';
      if (stale) result.retried++;
      try {
        const after = stale ? await this.retryStaleFinalizing(record) : await this.advance(record);
        if (after.status === 'SIGNED') result.signed++;
        else if (after.status === 'EXPIRED') result.expired++;
        else if (after.status === 'DECLINED') result.declined++;
        else if (after.status === 'FAILED') result.failed++;
      } catch (error) {
        result.errors++;
        this.logger.warn(logLine('esign.sweep.record_failed', { signingRequestId: record.id, ...describeError(error) }));
      }
    }
    return result;
  }

  // ───────────────────────── Төлөв ба provider-ийн тулгалт ─────────────────────────

  /** Poll, webhook, sweeper-ийн НЭГДСЭН зам: одоогийн төлвийг provider-тэй тулгаж, шаардлагатай шилжилтийг (CAS) хийнэ */
  private async advance(record: SigningRequestRecord): Promise<SigningRequestRecord> {
    switch (record.status) {
      case 'PENDING':
        return this.isExpired(record) ? this.expire(record) : record;
      case 'IN_PROGRESS':
        return this.syncSession(record);
      default:
        // FINALIZING-ийг өөр ажилтан гүйцэтгэж байна (гацсаныг sweeper тусад нь авна); төгсгөлийн төлөв өөрчлөгдөхгүй
        return record;
    }
  }

  private async syncSession(record: SigningRequestRecord): Promise<SigningRequestRecord> {
    let reading: ProviderReading;
    try {
      reading = await this.readProviderState(record);
    } catch (error) {
      // Provider байнга боломжгүй (тохиргоо хасагдсан гэх мэт) бөгөөд линк дууссан бол хүсэлт үүрд гацахгүй
      if (error instanceof SigningProviderUnavailableError && !error.retryable && this.isExpired(record)) return this.expire(record);
      throw error;
    }
    return reading.port === null ? this.endSession(record, 'EXPIRED') : this.applyProviderState(record, reading.port, reading.state);
  }

  private async readProviderState(record: SigningRequestRecord): Promise<ProviderReading> {
    // Бүрэн бүтэн бус мөр (provider/ref байхгүй IN_PROGRESS) — session алдагдсан гэж үзнэ
    if (!record.provider || !record.providerRef) return { port: null, state: { state: 'EXPIRED' } };
    let port: ESignProviderPort;
    try {
      port = this.providers.get(record.provider);
    } catch (error) {
      throw this.providerFailure('lookup', record.provider, error);
    }
    try {
      return { port, state: await port.getSession(record.providerRef) };
    } catch (error) {
      if (error instanceof ESignProviderError && error.code === 'UNKNOWN_SESSION') return { port, state: { state: 'EXPIRED' } };
      throw this.providerFailure('getSession', record.provider, error);
    }
  }

  private async applyProviderState(record: SigningRequestRecord, port: ESignProviderPort, state: ProviderSessionState): Promise<SigningRequestRecord> {
    switch (state.state) {
      case 'PENDING':
        return this.isExpired(record) ? this.expire(record) : record;
      case 'SIGNED':
        return this.finalize(record, port, state.signature);
      case 'DECLINED':
        return this.endSession(record, 'DECLINED');
      case 'EXPIRED':
        return this.endSession(record, 'EXPIRED');
      case 'FAILED':
        return this.endSession(record, 'FAILED', state.code);
    }
  }

  /** Provider session өөрөө дууссан (татгалзсан / хугацаа дууссан / алдаатай) */
  private async endSession(record: SigningRequestRecord, outcome: 'DECLINED' | 'EXPIRED' | 'FAILED', providerCode?: string): Promise<SigningRequestRecord> {
    const canRetry = outcome !== 'DECLINED' && record.attempts < this.config.maxAttempts && !this.isExpired(record);
    const ended = this.audit('PROVIDER_SESSION_ENDED', 'PROVIDER', this.clock(), undefined, {
      provider: record.provider,
      outcome,
      attempt: record.attempts,
      willRetry: canRetry,
      ...(providerCode === undefined ? {} : { providerCode: safeCode(providerCode) }),
    });
    if (canRetry) {
      // Линк хүчинтэй, оролдлого үлдсэн: зээлдэгч дахин provider сонгож болно
      const reset = await this.move(record, ['IN_PROGRESS'], 'PENDING', { ...SESSION_RESET, failureReason: SESSION_END_OUTCOME[outcome].reason }, { audit: [ended] });
      return reset ?? this.reload(record);
    }
    const { to, reason } = SESSION_END_OUTCOME[outcome];
    const next = await this.terminate(record, {
      from: ['IN_PROGRESS'],
      to,
      reason,
      detail: providerCode === undefined ? undefined : safeCode(providerCode),
      auditType: 'FAILED',
      actor: 'SYSTEM',
      origin: { actorId: null, correlationId: record.correlationId },
      precedingAudit: [ended],
    });
    return next ?? this.reload(record);
  }

  private async expire(record: SigningRequestRecord): Promise<SigningRequestRecord> {
    const expired = await this.terminate(record, {
      from: [record.status],
      to: 'EXPIRED',
      reason: 'EXPIRED',
      auditType: 'FAILED',
      actor: 'SYSTEM',
      origin: { actorId: null, correlationId: record.correlationId },
    });
    if (!expired) return this.reload(record);
    if (record.status === 'IN_PROGRESS') await this.cancelProviderSession(record);
    return expired;
  }

  /** Өмнөх ажилтан гацсан FINALIZING-ийг IN_PROGRESS руу буцаагаад provider-оос дахин асууж finalize хийнэ */
  private async retryStaleFinalizing(record: SigningRequestRecord): Promise<SigningRequestRecord> {
    const reverted = await this.move(record, ['FINALIZING'], 'IN_PROGRESS', {}, {});
    // null: гацсан гэгдсэн ажилтан дөнгөж дуусгасан — шинэ төлөвийг л буцаана
    return reverted ? this.syncSession(reverted) : this.reload(record);
  }

  /**
   * Зөвхөн public урсгалд: хугацаа дууссан хүсэлтийг тэр дор нь шилжүүлнэ (sweeper хүлээлгүй). Provider түр боломжгүй бол
   * шилжүүлэхгүй — харагдац `EXPIRED` гэж харуулж, sweeper дараа нь дуусгана.
   */
  private async settle(record: SigningRequestRecord): Promise<SigningRequestRecord> {
    if ((record.status !== 'PENDING' && record.status !== 'IN_PROGRESS') || !this.isExpired(record)) return record;
    return this.advanceTolerant(record);
  }

  /** `advance`, гэхдээ линк аль хэдийн дууссан хүсэлтэд provider түр боломжгүй бол алдаагүй (харагдац `EXPIRED`) буцаана */
  private async advanceTolerant(record: SigningRequestRecord): Promise<SigningRequestRecord> {
    try {
      return await this.advance(record);
    } catch (error) {
      if (error instanceof SigningProviderUnavailableError && this.isExpired(record)) return record;
      throw error;
    }
  }

  // ───────────────────────── Finalization ─────────────────────────

  /**
   * (1) CAS IN_PROGRESS→FINALIZING (түгжээ) · (2) гарын үсгийн шалгалт · (3) эх PDF-ийг дахин уншиж hash тулгах ·
   * (4) давтагдашгүй код · (5) штамп · (6) PDF + .p7s хадгалах · (7) CAS FINALIZING→SIGNED + audit + ContractSigned (НЭГ транзакц).
   * Байнгын алдаа → FAILED (+ ContractSigningFailed). Түр алдаа → IN_PROGRESS руу буцааж, дараагийн poll/webhook/sweeper дахин оролдоно.
   */
  private async finalize(record: SigningRequestRecord, port: ESignProviderPort, signature: ProviderSignature): Promise<SigningRequestRecord> {
    const locked = await this.move(record, ['IN_PROGRESS'], 'FINALIZING', {}, {});
    if (!locked) return this.reload(record);

    let outcome: SigningRequestRecord | FinalizationFailure;
    try {
      outcome = await this.runFinalization(locked, port, signature);
    } catch (error) {
      const permanent = this.classifyPermanent(error);
      if (!permanent) return this.abortFinalization(locked, error);
      outcome = permanent;
    }
    return outcome instanceof FinalizationFailure ? this.failFinalization(locked, outcome) : outcome;
  }

  private async runFinalization(locked: SigningRequestRecord, port: ESignProviderPort, signature: ProviderSignature): Promise<SigningRequestRecord | FinalizationFailure> {
    const verdict = verifyProviderSignature({
      originalSha256: locked.originalSha256,
      expectedRegisterNo: this.cipher.decrypt(locked.signerRegisterEnc),
      consentAt: locked.consentAt ?? locked.createdAt,
      now: this.clock(),
      signature,
    });
    if (!verdict.ok) return new FinalizationFailure(verdict.reason, verdict.detail);

    // Эх файл гарын үсэг зурах үед ашигласантай ижил хэвээр эсэхийг дахин баталгаажуулна (хуурамчаар солигдсоныг илрүүлэх)
    const source = await this.files.read(locked.orgId, locked.sourceFileId);
    if (!timingSafeEqualHex(sha256Hex(source.bytes), locked.originalSha256)) return new FinalizationFailure('INTEGRITY_ERROR', 'SOURCE_TAMPERED');

    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
      const code = generateVerificationCode();
      if (await this.store.getByVerificationCode(code)) continue;

      const stamped = await this.stamper.stamp({
        pdf: source.bytes,
        contractNo: locked.contractNo,
        signerName: locked.signerName,
        signerRegisterMasked: locked.signerRegisterMasked,
        provider: port.code,
        providerDisplayName: port.displayName,
        certificate: signature.certificate,
        signedAt: signature.signedAt,
        originalSha256: locked.originalSha256,
        signatureCms: signature.signatureCms,
        verificationCode: code,
        verifyUrl: `${this.config.publicBaseUrl}/verify/${code}`,
        mock: port.isMock,
      });
      const signedFile = await this.files.save({ orgId: locked.orgId, name: signedPdfName(locked.contractNo), mime: PDF_MIME, bytes: stamped, uploadedBy: null });
      const signatureFile = await this.files.save({ orgId: locked.orgId, name: signatureFileName(locked.contractNo), mime: SIGNATURE_MIME, bytes: signature.signatureCms, uploadedBy: null });

      const now = this.clock();
      const facts = { provider: port.code, signedFileId: signedFile.id, signatureFileId: signatureFile.id, signedSha256: signedFile.sha256, signedAt: signature.signedAt, verificationCode: code };
      let signed: SigningRequestRecord | null;
      try {
        signed = await this.move(
          locked,
          ['FINALIZING'],
          'SIGNED',
          {
            signedFileId: signedFile.id,
            signatureFileId: signatureFile.id,
            signedSha256: signedFile.sha256,
            verificationCode: code,
            signedAt: signature.signedAt,
            certificate: signature.certificate,
            providerTxnId: signature.providerTxnId,
            providerMock: port.isMock,
            failureReason: null,
            failureDetail: null,
            ...SESSION_CLEARED,
          },
          {
            audit: [
              this.audit('SIGNED', 'SYSTEM', now, undefined, {
                provider: port.code,
                providerTxnId: signature.providerTxnId,
                certificateSerial: signature.certificate.serialNumber,
                originalSha256: locked.originalSha256,
                signedSha256: signedFile.sha256,
                mock: port.isMock,
              }),
            ],
            events: [contractSigned(locked, facts, { now, actorId: null, correlationId: locked.correlationId })],
          },
        );
      } catch (error) {
        // Үүссэн кодыг өөр хүсэлт яг энэ мөчид авсан (pre-check-ээс хойш) — өөр код сонгож дахин штамплана
        if (error instanceof SigningUniqueViolationError && error.field === 'verificationCode') continue;
        throw error;
      }
      if (!signed) {
        // Гацсан гэгдэж sweeper буцаасан зэрэг өөр ажилтан дуусгасан: бидний хадгалсан файлууд хэний ч заадаггүй үлдэнэ
        this.logger.warn(logLine('esign.finalize.lost_race', { signingRequestId: locked.id, orphanSignedFileId: signedFile.id, orphanSignatureFileId: signatureFile.id }));
        return this.reload(locked);
      }
      return signed;
    }
    throw new Error('could not allocate a unique verification code');
  }

  /** Байнгын (дахин оролдоход утгагүй) алдаа мөн эсэхийг ялгана; үгүй бол `null` (түр алдаа) */
  private classifyPermanent(error: unknown): FinalizationFailure | null {
    if (error instanceof FileNotFoundError) return new FinalizationFailure('INTEGRITY_ERROR', 'SOURCE_FILE_MISSING');
    if (error instanceof FileIntegrityError) return new FinalizationFailure('INTEGRITY_ERROR', 'SOURCE_FILE_CORRUPT');
    if (error instanceof InvalidPdfError) return new FinalizationFailure('INTEGRITY_ERROR', 'SOURCE_PDF_INVALID');
    return null;
  }

  private async failFinalization(locked: SigningRequestRecord, failure: FinalizationFailure): Promise<SigningRequestRecord> {
    const failed = await this.terminate(locked, {
      from: ['FINALIZING'],
      to: 'FAILED',
      reason: failure.reason,
      detail: failure.detail,
      auditType: 'FAILED',
      actor: 'SYSTEM',
      origin: { actorId: null, correlationId: locked.correlationId },
    });
    this.logger.error(logLine('esign.finalize.failed', { signingRequestId: locked.id, reason: failure.reason, detail: failure.detail, correlationId: locked.correlationId }));
    return failed ?? this.reload(locked);
  }

  /** Түр алдаа: линк дуусаагүй бол дахин оролдох боломжтой болгож шидэнэ; дууссан бол үүрд оролдохгүй — FAILED */
  private async abortFinalization(locked: SigningRequestRecord, error: unknown): Promise<SigningRequestRecord> {
    this.logger.error(logLine('esign.finalize.transient_error', { signingRequestId: locked.id, correlationId: locked.correlationId, ...describeError(error) }));
    if (this.isExpired(locked)) return this.failFinalization(locked, new FinalizationFailure('INTEGRITY_ERROR', 'FINALIZE_RETRIES_EXHAUSTED'));
    await this.move(locked, ['FINALIZING'], 'IN_PROGRESS', {}, {});
    throw new SigningFinalizationError();
  }

  // ───────────────────────── Нийтлэг туслахууд ─────────────────────────

  /** Нэг CAS шилжилт. Машины хүснэгтэд байхгүй шилжилт бол програмчлалын алдаа. Өрсөлдөгч түрүүлсэн бол `null` */
  private async move(
    record: SigningRequestRecord,
    from: readonly SigningStatus[],
    to: SigningStatus,
    patch: RecordPatch,
    effects: TransitionEffects,
  ): Promise<SigningRequestRecord | null> {
    for (const source of from) {
      if (!canTransition(source, to)) throw new Error(`illegal signing transition ${source} -> ${to}`);
    }
    const next = await this.store.transition(record.id, [...from], { ...patch, status: to }, effects);
    if (next) this.logger.log(logLine('esign.transition', { signingRequestId: record.id, from: record.status, to, correlationId: next.correlationId }));
    return next;
  }

  /** Төгсгөлийн (SIGNED-ээс бусад) шилжилт: failureReason + аудит + ContractSigningFailed event нэг транзакцид */
  private async terminate(
    record: SigningRequestRecord,
    options: {
      from: readonly SigningStatus[];
      to: TerminalTarget;
      reason: SigningFailureReason;
      detail?: string;
      auditType: SigningAuditType;
      actor: string;
      meta?: ClientMeta;
      origin: Pick<EventOrigin, 'actorId' | 'correlationId'>;
      precedingAudit?: SigningAuditEntry[];
    },
  ): Promise<SigningRequestRecord | null> {
    const now = this.clock();
    const detail = { reason: options.reason, ...(options.detail === undefined ? {} : { detail: options.detail }) };
    return this.move(
      record,
      options.from,
      options.to,
      { failureReason: options.reason, failureDetail: options.detail ?? null, ...SESSION_CLEARED },
      {
        audit: [...(options.precedingAudit ?? []), this.audit(options.auditType, options.actor, now, options.meta, detail)],
        events: [contractSigningFailed(record, options.reason, { now, ...options.origin })],
      },
    );
  }

  /** Ажилтан шинэ хүсэлт үүсгэхэд идэвхтэй хуучныг цуцална. FINALIZING-ийг цуцалж болохгүй (гарын үсэг аль хэдийн ирсэн) */
  private async supersede(active: SigningRequestRecord, ctx: RequestContext): Promise<void> {
    if (active.status === 'FINALIZING') throw new SigningConflictError('ACTIVE_EXISTS', active.id);
    const cancelled = await this.terminate(active, {
      from: [active.status],
      to: 'CANCELLED',
      reason: 'CANCELLED',
      detail: 'SUPERSEDED',
      auditType: 'SUPERSEDED',
      actor: ctx.actorId ?? 'SYSTEM',
      origin: { actorId: ctx.actorId, correlationId: ctx.correlationId },
    });
    if (!cancelled) throw new SigningConflictError('ACTIVE_EXISTS', active.id);
    await this.cancelProviderSession(active);
  }

  private async reload(record: SigningRequestRecord): Promise<SigningRequestRecord> {
    return (await this.store.getById(record.id)) ?? record;
  }

  private isExpired(record: SigningRequestRecord): boolean {
    return this.clock().getTime() >= record.linkExpiresAt.getTime();
  }

  private signingUrl(token: string): string {
    return `${this.config.publicBaseUrl}/sign/${token}`;
  }

  private audit(type: SigningAuditType, actor: string, at: Date, meta?: ClientMeta, detail?: Record<string, unknown>): SigningAuditEntry {
    return { type, actor, at, ip: cleanMeta(meta?.ip, MAX_IP_LENGTH), userAgent: cleanMeta(meta?.userAgent, MAX_USER_AGENT_LENGTH), ...(detail === undefined ? {} : { detail }) };
  }

  private async auditDownload(record: SigningRequestRecord, actor: string, meta: ClientMeta | undefined): Promise<void> {
    await this.store.appendAudit(record.id, this.audit('SIGNED_DOWNLOADED', actor, this.clock(), meta));
  }

  /** Алдаа/дэлгэрэнгүйг (provider-ийн мессеж) гадагш гаргахгүйгээр лог бичиж, нэгдсэн алдаа үүсгэнэ */
  private providerFailure(operation: string, provider: string, error: unknown): SigningProviderUnavailableError {
    this.logger.warn(logLine('esign.provider.error', { operation, provider, ...describeError(error) }));
    return new SigningProviderUnavailableError(error instanceof ESignProviderError ? error.retryable : true);
  }

  /** Session-ийг цуцлах нь best-effort: үр дүн нь төлөвт нөлөөлөхгүй (төлөв аль хэдийн шилжсэн), session өөрөө хугацаандаа дуусна */
  private async cancelProviderSession(record: SigningRequestRecord): Promise<void> {
    if (!record.provider || !record.providerRef) return;
    try {
      await this.providers.get(record.provider).cancelSession(record.providerRef);
    } catch (error) {
      this.logger.warn(logLine('esign.provider.cancel_failed', { signingRequestId: record.id, provider: record.provider, ...describeError(error) }));
    }
  }

  private async cancelSessionQuietly(port: ESignProviderPort, providerRef: string): Promise<void> {
    try {
      await port.cancelSession(providerRef);
    } catch (error) {
      this.logger.warn(logLine('esign.provider.cancel_failed', { provider: port.code, ...describeError(error) }));
    }
  }

  // ───────────────────────── Токен, файл, харагдац ─────────────────────────

  /** Үл мэдэгдэх болон солигдсон токен — яг ижил `SigningNotFoundError` (хүчинтэй байсан эсэхийг илтгэхгүй) */
  private async resolveToken(token: string): Promise<SigningRequestRecord> {
    if (!isLinkTokenShape(token)) throw new SigningNotFoundError();
    const record = await this.store.getByTokenHash(hashToken(token));
    if (!record) throw new SigningNotFoundError();
    return record;
  }

  /** Линк нээлттэй байх ёстой үйлдэл (үзэх, эхлүүлэх, татгалзах): PENDING | IN_PROGRESS бөгөөд хугацаа дуусаагүй */
  private assertOpen(record: SigningRequestRecord): void {
    if (record.status === 'FINALIZING') throw new SigningConflictError('INVALID_STATE');
    if (record.status === 'PENDING' || record.status === 'IN_PROGRESS') {
      if (this.isExpired(record)) throw new SigningGoneError('EXPIRED', record.status);
      return;
    }
    throw new SigningGoneError(record.status === 'EXPIRED' ? 'EXPIRED' : 'TERMINAL', record.status);
  }

  private requireSigned(record: SigningRequestRecord): SigningRequestRecord & { signedFileId: string; signatureFileId: string } {
    if (record.status !== 'SIGNED' || !record.signedFileId || !record.signatureFileId) throw new SigningConflictError('INVALID_STATE');
    return { ...record, signedFileId: record.signedFileId, signatureFileId: record.signatureFileId };
  }

  private async readSourceForCreate(orgId: string, fileId: string): Promise<{ sha256: string }> {
    let file: SigningFileContent;
    try {
      file = await this.files.read(orgId, fileId);
    } catch (error) {
      if (error instanceof FileNotFoundError) throw new SigningValidationError('SOURCE_FILE_NOT_FOUND');
      if (error instanceof FileIntegrityError) throw new SigningValidationError('SOURCE_FILE_HASH_MISMATCH');
      throw error;
    }
    if (!looksLikePdf(file.bytes)) throw new SigningValidationError('NOT_A_PDF');
    const sha256 = sha256Hex(file.bytes);
    if (!timingSafeEqualHex(sha256, file.sha256)) throw new SigningValidationError('SOURCE_FILE_HASH_MISMATCH');
    return { sha256 };
  }

  /** Зээлдэгчид үзүүлэх файл нь provider-д илгээсэн hash-тай ижил байх ёстой — эс бөгөөс үзүүлэхгүй */
  private async readSourceForReview(record: SigningRequestRecord): Promise<SigningFileContent> {
    let file: SigningFileContent;
    try {
      file = await this.files.read(record.orgId, record.sourceFileId);
    } catch (error) {
      if (error instanceof FileNotFoundError) throw new SigningValidationError('SOURCE_FILE_NOT_FOUND');
      if (error instanceof FileIntegrityError) throw new SigningValidationError('SOURCE_FILE_HASH_MISMATCH');
      throw error;
    }
    if (!timingSafeEqualHex(sha256Hex(file.bytes), record.originalSha256)) {
      this.logger.error(logLine('esign.source.tampered', { signingRequestId: record.id }));
      throw new SigningValidationError('SOURCE_FILE_HASH_MISMATCH');
    }
    return file;
  }

  private async readSignedPdf(record: SignedFileRef): Promise<SigningFileContent> {
    const file = await this.files.read(record.orgId, record.signedFileId);
    if (record.signedSha256 === null || !timingSafeEqualHex(sha256Hex(file.bytes), record.signedSha256)) {
      this.logger.error(logLine('esign.signed_file.tampered', { signingRequestId: record.id }));
      throw new SigningValidationError('SIGNED_FILE_HASH_MISMATCH');
    }
    return file;
  }

  /** verify хуудасны `valid`: файл устсан/өөрчлөгдсөн бол false; дэд бүтцийн алдааг (түр) дамжуулна */
  private async isSignedFileIntact(record: SignedFileRef): Promise<boolean> {
    try {
      await this.readSignedPdf(record);
      return true;
    } catch (error) {
      if (error instanceof SigningValidationError || error instanceof FileNotFoundError || error instanceof FileIntegrityError) return false;
      throw error;
    }
  }

  /** preferredProvider-ийг CREATED аудитаас уншина (record-д багана байхгүй). Заагаагүй бол `null` */
  private async pinnedProvider(record: SigningRequestRecord): Promise<ProviderOption['code'] | null> {
    const created = (await this.store.listAudit(record.id)).find((entry) => entry.type === 'CREATED');
    const pinned = created?.detail?.preferredProvider;
    return ESignProvider.find((code) => code === pinned) ?? null;
  }

  /** SIGNED үед гарын үсэг зурагдсан огнооноос `signedCopyTtlDays` хоногийн дараа; бусад төлөвт null */
  private signedCopyExpiresAt(record: SigningRequestRecord): Date | null {
    if (record.status !== 'SIGNED' || record.signedAt === null) return null;
    return new Date(record.signedAt.getTime() + this.config.signedCopyTtlDays * 24 * HOUR_MS);
  }

  private isSignedCopyExpired(record: SigningRequestRecord): boolean {
    const expiresAt = this.signedCopyExpiresAt(record);
    return expiresAt === null || this.clock().getTime() >= expiresAt.getTime();
  }

  private option(port: ESignProviderPort): ProviderOption {
    return { code: port.code, displayName: port.displayName, mock: port.isMock };
  }

  /** Зээлдэгчийн харагдац. Хугацаа нь дууссан боловч sweeper хараахан шилжүүлээгүй хүсэлтийг `EXPIRED` гэж харуулна */
  private async publicSession(record: SigningRequestRecord): Promise<PublicSigningSession> {
    const expiredByTime = (record.status === 'PENDING' || record.status === 'IN_PROGRESS') && this.isExpired(record);
    const status: SigningStatus = expiredByTime ? 'EXPIRED' : record.status;
    let providers: ProviderOption[] = [];
    if (record.status === 'PENDING' && !expiredByTime) {
      const pinned = await this.pinnedProvider(record);
      providers = this.providers.list().filter((port) => pinned === null || port.code === pinned).map((port) => this.option(port));
    } else if (record.provider) {
      providers = this.providers.list().filter((port) => port.code === record.provider).map((port) => this.option(port));
    }
    const inProgress = status === 'IN_PROGRESS';
    return {
      status,
      contractNo: record.contractNo,
      signerNameMasked: maskName(record.signerName),
      linkExpiresAt: record.linkExpiresAt.toISOString(),
      providers,
      provider: record.provider,
      challengeCode: inProgress ? record.challengeCode : null,
      deepLink: inProgress ? record.deepLink : null,
      sessionExpiresAt: inProgress ? (record.sessionExpiresAt?.toISOString() ?? null) : null,
      documentViewed: record.documentViewedAt !== null,
      failureReason: expiredByTime ? 'EXPIRED' : record.failureReason,
      signedAt: record.signedAt?.toISOString() ?? null,
      verificationCode: record.status === 'SIGNED' && record.verificationCode !== null ? formatVerificationCode(record.verificationCode) : null,
      signedDocumentAvailable: record.status === 'SIGNED' && record.signedFileId !== null && !this.isSignedCopyExpired(record),
      signedCopyExpiresAt: this.signedCopyExpiresAt(record)?.toISOString() ?? null,
      consentVersion: ESIGN_CONSENT_VERSION,
      providerMock: record.providerMock,
    };
  }
}

/** Provider-ийн алдааны кодыг audit/failure_detail-д бичихөөс өмнө цэвэрлэнэ (богино, зөвхөн код хэлбэртэй тэмдэгт) */
function safeCode(code: string): string {
  return code.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) || 'UNKNOWN';
}
