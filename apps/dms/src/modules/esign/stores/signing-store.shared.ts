// MemorySigningStore болон PrismaSigningStore-ийн хуваалцдаг дүрэм, хөрвүүлэлт. Хоёр гүйцэтгэл ижил семантиктай байх ёстой
// (signing-store.contract.ts хоёуланг нь шалгана).
import { ESignProvider, SigningFailureReason, SigningStatus } from '@los/contracts';
import type { SigningAuditEntry, SigningRequestRecord, NewSigningRequest } from '../ports/signing.store';
import { SigningConstraintError } from './errors';

/** Нэг гэрээнд ганцхан байх боломжтой төлвүүд (DB-ийн partial unique index-ийн WHERE-тэй ижил) */
export const ACTIVE_SIGNING_STATUSES: readonly SigningStatus[] = ['PENDING', 'IN_PROGRESS', 'FINALIZING'];

export function isActiveStatus(status: SigningStatus): boolean {
  return ACTIVE_SIGNING_STATUSES.includes(status);
}

/** Record-ийн бүх талбар — `satisfies` нь SigningRequestRecord өөрчлөгдвөл энд компайл алдаа өгнө */
const RECORD_FIELDS = {
  id: true, orgId: true, applicationId: true, contractId: true, contractNo: true, status: true, provider: true, providerRef: true,
  challengeCode: true, deepLink: true, sessionExpiresAt: true, sourceFileId: true, signedFileId: true, signatureFileId: true,
  originalSha256: true, signedSha256: true, signerCustomerId: true, signerName: true, signerRegisterEnc: true, signerPhoneEnc: true,
  signerRegisterMasked: true, signerPhoneMasked: true, tokenHash: true, linkExpiresAt: true, verificationCode: true,
  documentViewedAt: true, consentAt: true, attempts: true, certificate: true, providerTxnId: true, providerMock: true,
  failureReason: true, failureDetail: true, correlationId: true, createdBy: true, createdAt: true, updatedAt: true, signedAt: true,
} as const satisfies Record<keyof SigningRequestRecord, true>;

/** `transition`-ээр өөрчлөх боломжгүй: id, createdAt нь хувиршгүй; updatedAt-ыг store өөрөө тавина */
const STORE_OWNED_FIELDS: ReadonlySet<string> = new Set(['id', 'createdAt', 'updatedAt']);

export type SigningRecordPatch = Partial<Omit<SigningRequestRecord, 'id' | 'createdAt'>>;

/**
 * Patch-ийг цэвэрлэнэ: мэдэгдэхгүй түлхүүр, store-ын эзэмшдэг талбар (id/createdAt/updatedAt) болон `undefined`-ийг хасна.
 * (`{...record, status}` гэж бүтэн record тарааж өгөхөд id-г дарахаас хамгаална; `undefined` нь "өөрчлөхгүй" гэсэн Prisma семантиктай ижил.)
 */
export function sanitizePatch(patch: SigningRecordPatch): SigningRecordPatch {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined && Object.hasOwn(RECORD_FIELDS, key) && !STORE_OWNED_FIELDS.has(key)) clean[key] = value;
  }
  return clean as SigningRecordPatch;
}

/** NewSigningRequest → бүтэн record (PENDING, attempts 0, бусад nullable талбар null). Мэдэгдэхгүй талбарыг хуулахгүй. */
export function buildNewRecord(input: NewSigningRequest, now: Date): SigningRequestRecord {
  return {
    id: input.id,
    orgId: input.orgId,
    applicationId: input.applicationId,
    contractId: input.contractId,
    contractNo: input.contractNo,
    status: 'PENDING',
    provider: null,
    providerRef: null,
    challengeCode: null,
    deepLink: null,
    sessionExpiresAt: null,
    sourceFileId: input.sourceFileId,
    signedFileId: null,
    signatureFileId: null,
    originalSha256: input.originalSha256,
    signedSha256: null,
    signerCustomerId: input.signerCustomerId,
    signerName: input.signerName,
    signerRegisterEnc: input.signerRegisterEnc,
    signerPhoneEnc: input.signerPhoneEnc,
    signerRegisterMasked: input.signerRegisterMasked,
    signerPhoneMasked: input.signerPhoneMasked,
    tokenHash: input.tokenHash,
    linkExpiresAt: new Date(input.linkExpiresAt),
    verificationCode: null,
    documentViewedAt: null,
    consentAt: null,
    attempts: 0,
    certificate: null,
    providerTxnId: null,
    providerMock: false,
    failureReason: null,
    failureDetail: null,
    correlationId: input.correlationId,
    createdBy: input.createdBy,
    createdAt: new Date(now),
    updatedAt: new Date(now),
    signedAt: null,
  };
}

export function cloneRecord(record: SigningRequestRecord): SigningRequestRecord {
  return structuredClone(record);
}

/** JSONB-д хадгалахтай ижил хэлбэр: Date → ISO string, undefined хасагдана. Хоёр store-д ижил харагдуулахын тулд. */
export function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export interface NormalizedAuditEntry {
  type: SigningAuditEntry['type'];
  actor: string;
  at: Date;
  ip: string | null;
  userAgent: string | null;
  detail: Record<string, unknown>;
}

/** Аудитыг уншихад буцах хэлбэр: ip/userAgent байхгүй бол null, detail байхгүй бол {} */
export function normalizeAudit(entry: SigningAuditEntry): NormalizedAuditEntry {
  return {
    type: entry.type,
    actor: entry.actor,
    at: new Date(entry.at),
    ip: entry.ip ?? null,
    userAgent: entry.userAgent ?? null,
    detail: jsonClone(entry.detail ?? {}),
  };
}

const STATUS_VALUES: readonly string[] = SigningStatus;
const PROVIDER_VALUES: readonly string[] = ESignProvider;
const FAILURE_VALUES: readonly string[] = SigningFailureReason;

/**
 * Миграцийн CHECK constraint-уудын (status/provider/failure_reason/attempts/SIGNED бүрэн байх) санах ойн толь.
 * PrismaSigningStore үүнийг ашиглахгүй — DB өөрөө хамгаална; алдаа нь ижил `SigningConstraintError` хэлбэрээр гарна.
 */
export function assertRecordConstraints(record: SigningRequestRecord): void {
  if (!STATUS_VALUES.includes(record.status)) throw new SigningConstraintError('signing_request_status_check');
  if (record.provider !== null && !PROVIDER_VALUES.includes(record.provider)) throw new SigningConstraintError('signing_request_provider_check');
  if (record.failureReason !== null && !FAILURE_VALUES.includes(record.failureReason)) throw new SigningConstraintError('signing_request_failure_reason_check');
  if (!Number.isInteger(record.attempts) || record.attempts < 0) throw new SigningConstraintError('signing_request_attempts_check');
  if (record.status === 'SIGNED') {
    const complete = record.signedFileId !== null && record.signatureFileId !== null && record.signedSha256 !== null && record.verificationCode !== null && record.signedAt !== null;
    if (!complete) throw new SigningConstraintError('signing_request_signed_complete_check');
  }
}
