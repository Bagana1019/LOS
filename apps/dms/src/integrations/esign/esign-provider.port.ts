// Цахим гарын үсгийн provider-ийн (Tridum, Monpass) нэгдсэн interface — CLAUDE.md §3.2.7.
// Бодит гүйцэтгэл: integrations/<name>/{<name>.mock.ts,<name>.real.ts}; сонголт INTEGRATION_MODE-оор (provider.registry.ts).
// Загвар: "remote signing" — бид зөвхөн баримтын HASH-ийг илгээнэ (PDF өөрөө provider рүү явахгүй), зээлдэгч утасны апп дээрээ
// баталгаажуулна, provider CMS (PKCS#7, detached) гарын үсэг + гэрчилгээг буцаана.
import type { ESignProvider as ESignProviderCode } from '@los/contracts';

export interface DocumentDigest { algorithm: 'SHA-256'; hex: string }

export interface SignerIdentity {
  fullName: string;
  /** Нормчилсон (том үсэг, зайгүй) регистр — provider-д гарын үсэг зурагчийг таниулахад. ЛОГТ БИЧИХГҮЙ. */
  registerNo: string;
  /** E.164 эсвэл 8 оронтой дотоод дугаар — ЛОГТ БИЧИХГҮЙ. */
  phone: string;
}

export interface CreateProviderSessionInput {
  /** Бидний signing_request.id — provider-ийн merchant reference болгон дамжуулна */
  signingRequestId: string;
  document: { name: string; digest: DocumentDigest };
  signer: SignerIdentity;
  /** Provider webhook хүлээн авах public URL; null бол зөвхөн polling */
  callbackUrl: string | null;
  ttlSeconds: number;
  correlationId: string;
}

export interface ProviderSession {
  providerRef: string;
  /** Зээлдэгчид харуулах, утасны апп дээрх кодтой тулгах богино код (жишээ 4 оронтой). Байхгүй байж болно. */
  challengeCode: string | null;
  /** Утсан дээр provider апп-ыг шууд нээх deep link. Байхгүй байж болно. */
  deepLink: string | null;
  expiresAt: Date;
}

export interface SignerCertificate {
  subjectName: string;
  /** Гэрчилгээнд бичигдсэн регистр — бидний хүлээсэн регистртэй тулгана (IDENTITY_MISMATCH) */
  subjectRegisterNo: string;
  issuer: string;
  serialNumber: string;
  notBefore: Date;
  notAfter: Date;
}

export interface ProviderSignature {
  /** CMS/PKCS#7 detached гарын үсэг (DER) */
  signatureCms: Buffer;
  signedDigestHex: string;
  digestAlgorithm: 'SHA-256';
  signedAt: Date;
  providerTxnId: string;
  certificate: SignerCertificate;
}

export type ProviderSessionState =
  | { state: 'PENDING' }
  | { state: 'SIGNED'; signature: ProviderSignature }
  | { state: 'DECLINED' }
  | { state: 'EXPIRED' }
  | { state: 'FAILED'; code: string; message: string };

export interface WebhookRequest { headers: Record<string, string | undefined>; rawBody: Buffer }
/** Баталгаажсан webhook-ийн агуулга. Төлөвийг ХЭЗЭЭ Ч webhook-оос биш `getSession()`-оор дахин авч шийднэ. */
export interface ProviderWebhookEvent { providerRef: string }

export interface ESignProviderPort {
  readonly code: ESignProviderCode;
  readonly displayName: string;
  /** true бол үйлдвэрлэлд ХЭЗЭЭ Ч ашиглагдахгүй; штамп дээр "ТЕСТ" тэмдэглэгээ зурагдана */
  readonly isMock: boolean;
  createSession(input: CreateProviderSessionInput): Promise<ProviderSession>;
  getSession(providerRef: string): Promise<ProviderSessionState>;
  /** Idempotent: аль хэдийн дууссан/цуцлагдсан session дээр алдаа шидэхгүй */
  cancelSession(providerRef: string): Promise<void>;
  /** Гарын үсэг/нууц буруу бол `ESignProviderError('INVALID_WEBHOOK')` шиднэ */
  parseWebhook(req: WebhookRequest): ProviderWebhookEvent;
}

export type ESignProviderErrorCode = 'UNAVAILABLE' | 'REJECTED' | 'NOT_CONFIGURED' | 'NOT_IMPLEMENTED' | 'INVALID_WEBHOOK' | 'UNKNOWN_SESSION';
export class ESignProviderError extends Error {
  constructor(readonly code: ESignProviderErrorCode, message: string, readonly retryable = false) { super(message); this.name = 'ESignProviderError'; }
}

/** DI token: `ESignProviderPort[]` — integrations.module.ts INTEGRATION_MODE-оор mock/real жагсаалт үүсгэнэ */
export const ESIGN_PROVIDERS = Symbol('ESIGN_PROVIDERS');
/** DI token: `() => Date` — тестэд цаг удирдахад */
export const CLOCK = Symbol('CLOCK');
export type Clock = () => Date;
