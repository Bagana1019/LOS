// signing_request / signing_event хадгалалтын port. Гүйцэтгэл: prisma-signing.store.ts (prod), memory-signing.store.ts (тест, dev).
// Бүх өөрчлөлт нь (мөр + аудит + outbox event) НЭГ транзакцид — CLAUDE.md §3.2.4.
import type { DomainEvent, ESignProvider, SigningFailureReason, SigningStatus } from '@los/contracts';
import type { SignerCertificate } from '../../../integrations/esign/esign-provider.port';

export interface SigningRequestRecord {
  id: string;
  orgId: string;
  applicationId: string;
  contractId: string;
  contractNo: string;
  status: SigningStatus;
  provider: ESignProvider | null;
  providerRef: string | null;
  /** Зээлдэгчид харуулах код / deep link — provider session-тэй хамт; session дуусахад null болно */
  challengeCode: string | null;
  deepLink: string | null;
  sessionExpiresAt: Date | null;
  /** dms.file id-ууд (cross-schema FK биш) */
  sourceFileId: string;
  signedFileId: string | null;
  signatureFileId: string | null;
  originalSha256: string;
  signedSha256: string | null;
  signerCustomerId: string;
  signerName: string;
  /** Шифрлэгдсэн (SensitiveFieldCipher). Дэлгэцэнд ЗӨВХӨН masked хэлбэрээр гарна */
  signerRegisterEnc: string;
  signerPhoneEnc: string;
  signerRegisterMasked: string;
  signerPhoneMasked: string;
  /** Линкийн токен — зөвхөн SHA-256 hash хадгална */
  tokenHash: string;
  linkExpiresAt: Date;
  /** Нийтэд харагдах (QR) богино код; гарын үсэг зурагдсан үед л тавигдана, unique */
  verificationCode: string | null;
  documentViewedAt: Date | null;
  consentAt: Date | null;
  /** provider session эхлүүлсэн оролдлогын тоо (хязгаар ESIGN_MAX_ATTEMPTS) */
  attempts: number;
  certificate: SignerCertificate | null;
  providerTxnId: string | null;
  /** provider mock эсэх (штамп, verify хуудсанд) */
  providerMock: boolean;
  failureReason: SigningFailureReason | null;
  failureDetail: string | null;
  correlationId: string;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  signedAt: Date | null;
}

export type NewSigningRequest = Omit<SigningRequestRecord, 'createdAt' | 'updatedAt' | 'signedAt' | 'status' | 'attempts' | 'provider' | 'providerRef' | 'challengeCode' | 'deepLink' | 'sessionExpiresAt' | 'signedFileId' | 'signatureFileId' | 'signedSha256' | 'verificationCode' | 'documentViewedAt' | 'consentAt' | 'certificate' | 'providerTxnId' | 'providerMock' | 'failureReason' | 'failureDetail'>;

export type SigningAuditType =
  | 'CREATED' | 'LINK_ROTATED' | 'OPENED' | 'DOCUMENT_VIEWED' | 'CONSENT_GIVEN'
  | 'PROVIDER_SESSION_STARTED' | 'PROVIDER_SESSION_ENDED' | 'WEBHOOK_RECEIVED'
  | 'SIGNED' | 'FAILED' | 'CANCELLED' | 'SIGNED_DOWNLOADED' | 'SUPERSEDED';

export interface SigningAuditEntry {
  type: SigningAuditType;
  /** 'BORROWER' | 'SYSTEM' | 'PROVIDER' | хэрэглэгчийн id */
  actor: string;
  at: Date;
  ip?: string | null;
  userAgent?: string | null;
  detail?: Record<string, unknown>;
}

export interface TransitionEffects { events?: DomainEvent[]; audit?: SigningAuditEntry[] }

export interface SigningStore {
  create(record: NewSigningRequest, effects?: TransitionEffects): Promise<SigningRequestRecord>;
  getById(id: string): Promise<SigningRequestRecord | null>;
  getByTokenHash(tokenHash: string): Promise<SigningRequestRecord | null>;
  getByProviderRef(provider: ESignProvider, providerRef: string): Promise<SigningRequestRecord | null>;
  getByVerificationCode(code: string): Promise<SigningRequestRecord | null>;
  listByApplication(applicationId: string): Promise<SigningRequestRecord[]>;
  /** PENDING | IN_PROGRESS | FINALIZING төлөвтэй */
  findActiveByContract(contractId: string): Promise<SigningRequestRecord | null>;
  /**
   * Compare-and-set: одоогийн төлөв `from`-д байвал л `patch`-ийг хэрэглэнэ; үгүй бол `null` (өрсөлдөгч нь түрүүлсэн).
   * `patch`, `effects.audit`, `effects.events` — нэг транзакцид. Төлөв хэвээр үлдэх patch-д `from`-д тухайн төлвөө өг.
   */
  transition(id: string, from: SigningStatus[], patch: Partial<Omit<SigningRequestRecord, 'id' | 'createdAt'>>, effects?: TransitionEffects): Promise<SigningRequestRecord | null>;
  appendAudit(id: string, entry: SigningAuditEntry): Promise<void>;
  listAudit(id: string): Promise<SigningAuditEntry[]>;
  /** link_expires_at < now бөгөөд PENDING|IN_PROGRESS, эсвэл FINALIZING нь `finalizingStaleBefore`-оос эртний */
  listExpirable(now: Date, finalizingStaleBefore: Date, limit: number): Promise<SigningRequestRecord[]>;
}
export const SIGNING_STORE = Symbol('SIGNING_STORE');
