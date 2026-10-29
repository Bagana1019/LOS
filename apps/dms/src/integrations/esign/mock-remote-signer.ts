// FR-11.4 Tridum / Monpass mock-д нийтлэг "remote signing" симулятор (CLAUDE.md §3.2.7 — deterministic fixture).
// Fixture нь signer.registerNo-ийн СҮҮЛИЙН 2 цифрээр, цаг нь инжектлэсэн Clock-оор шийдэгдэнэ (setTimeout/random байхгүй).
// Гарын үсэг нь ЯГ ХУУРМАГ (MOCK-CMS) — баталгаажуулах боломжгүй; штамп дээр isMock=true тул "ТЕСТ" тэмдэглэгээ зурагдана.
// Регистр, нэр, утас лог/алдааны мессежид ХЭЗЭЭ Ч орохгүй.
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ESignProvider as ESignProviderCode } from '@los/contracts';
import { z } from 'zod';
import {
  ESignProviderError,
  type Clock,
  type CreateProviderSessionInput,
  type DocumentDigest,
  type ESignProviderPort,
  type ProviderSession,
  type ProviderSessionState,
  type ProviderWebhookEvent,
  type WebhookRequest,
} from './esign-provider.port';

export const MOCK_CA_ISSUER = 'LOS MOCK CA (ТЕСТ)';
export const MOCK_CMS_MARKER = 'MOCK-CMS';
export const MOCK_FAILURE_CODE = 'MOCK_PROVIDER_ERROR';
/** Webhook-ийн гарын үсэг: hex HMAC-SHA256(rawBody, webhookSecret) */
export const MOCK_WEBHOOK_SIGNATURE_HEADER = 'x-mock-signature';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Хугацаа дууссан session-ийг санах ойгоос хэдий хойно цэвэрлэх (dev процессын санах ой ургахаас сэргийлнэ) */
const SESSION_RETENTION_MS = DAY_MS;
const SHA256_HEX = /^[0-9a-f]{64}$/i;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*$/;

export type MockFixture = 'APPROVE' | 'DECLINE' | 'NEVER_APPROVE' | 'PROVIDER_ERROR' | 'IDENTITY_MISMATCH' | 'DIGEST_MISMATCH';

const FIXTURE_BY_SUFFIX: ReadonlyMap<string, MockFixture> = new Map<string, MockFixture>([
  ['00', 'DECLINE'], // зээлдэгч татгалзана
  ['99', 'NEVER_APPROVE'], // хэзээ ч батлахгүй — ttl дуусахад EXPIRED
  ['55', 'PROVIDER_ERROR'], // FAILED(MOCK_PROVIDER_ERROR)
  ['77', 'IDENTITY_MISMATCH'], // гарын үсэг зурагдсан ч гэрчилгээний регистр зөрнө
  ['11', 'DIGEST_MISMATCH'], // гарын үсэг зурагдсан ч hash зөрнө
]);

/** Регистрийн сүүлийн 2 цифрээр fixture сонгоно; таарахгүй бол `APPROVE` */
export function selectMockFixture(registerNo: string): MockFixture {
  return FIXTURE_BY_SUFFIX.get(registerNo.slice(-2)) ?? 'APPROVE';
}

/** Тест болон dev controller-д: зээлдэгчийн үйлдлийг шууд хийлгэх (хугацаа хүлээхгүй) */
export interface MockSigningControl {
  /** Энэ provider тухайн session-ийг эзэмшиж байгаа эсэх */
  owns(providerRef: string): boolean;
  /** Зээлдэгч одоо баталлаа. Session PENDING биш (татгалзсан/дууссан/цуцлагдсан/алдаатай) бол REJECTED; аль хэдийн SIGNED бол no-op */
  approveNow(providerRef: string): void;
  /** Зээлдэгч одоо татгалзлаа. Session PENDING биш бол REJECTED; аль хэдийн DECLINED бол no-op */
  declineNow(providerRef: string): void;
}

export function isMockSigningControl<T>(value: T): value is T & MockSigningControl {
  const v = value as Partial<MockSigningControl> | null;
  return typeof v?.owns === 'function' && typeof v.approveNow === 'function' && typeof v.declineNow === 'function';
}

export interface MockRemoteSignerOptions {
  code: ESignProviderCode;
  displayName: string;
  refPrefix: 'TRD-MOCK' | 'MPS-MOCK';
  /** URL scheme (`mock-tridum`) — deep link нь `<scheme>://sign/<providerRef>` */
  deepLinkScheme: string;
  clock: Clock;
  /** Зээлдэгчийн "үйлдэл" session нээгдснээс хойш хэдэн мс-д гарах вэ (clock-based) */
  approveAfterMs: number;
  /** Webhook гарын үсэг + хуурмаг CMS-ийн HMAC түлхүүр */
  webhookSecret: string;
}

/** Provider тус бүрийн mock-д дамжуулах нийтлэг тохиргоо (code/prefix/scheme нь provider-ийн ангид тогтсон) */
export type MockProviderOptions = Pick<MockRemoteSignerOptions, 'clock' | 'approveAfterMs' | 'webhookSecret'>;

interface MockSession {
  readonly providerRef: string;
  readonly digestHex: string;
  readonly signer: { readonly fullName: string; readonly registerNo: string };
  readonly fixture: MockFixture;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  decision: { readonly kind: 'APPROVE' | 'DECLINE'; readonly atMs: number } | null;
  cancelledAtMs: number | null;
}

const webhookBodySchema = z.object({ providerRef: z.string().min(1).max(128) });

export class MockRemoteSigner implements ESignProviderPort, MockSigningControl {
  readonly code: ESignProviderCode;
  readonly displayName: string;
  readonly isMock = true;
  private readonly sessions = new Map<string, MockSession>();

  constructor(private readonly options: MockRemoteSignerOptions) {
    if (!options.webhookSecret) throw new Error('MockRemoteSigner: webhookSecret must not be empty');
    if (!Number.isInteger(options.approveAfterMs) || options.approveAfterMs < 0) throw new Error('MockRemoteSigner: approveAfterMs must be a non-negative integer');
    if (!URL_SCHEME.test(options.deepLinkScheme)) throw new Error('MockRemoteSigner: deepLinkScheme must be a valid URL scheme');
    this.code = options.code;
    this.displayName = options.displayName;
  }

  async createSession(input: CreateProviderSessionInput): Promise<ProviderSession> {
    const digestHex = normalizeDigest(input.document.digest);
    if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds <= 0) throw new ESignProviderError('REJECTED', 'ttlSeconds must be a positive integer');
    if (!input.signer.registerNo.trim() || !input.signer.fullName.trim()) throw new ESignProviderError('REJECTED', 'signer identity is required');

    const nowMs = this.nowMs();
    this.purgeStale(nowMs);
    const providerRef = `${this.options.refPrefix}-${randomUUID()}`;
    const session: MockSession = {
      providerRef,
      digestHex,
      signer: { fullName: input.signer.fullName, registerNo: input.signer.registerNo },
      fixture: selectMockFixture(input.signer.registerNo),
      createdAtMs: nowMs,
      expiresAtMs: nowMs + input.ttlSeconds * 1000,
      decision: null,
      cancelledAtMs: null,
    };
    this.sessions.set(providerRef, session);
    return {
      providerRef,
      challengeCode: challengeCode(digestHex, providerRef),
      deepLink: `${this.options.deepLinkScheme}://sign/${providerRef}`,
      expiresAt: new Date(session.expiresAtMs),
    };
  }

  async getSession(providerRef: string): Promise<ProviderSessionState> {
    return this.resolve(this.require(providerRef), this.nowMs());
  }

  /** Idempotent: үл мэдэгдэх/дууссан/цуцлагдсан session дээр алдаа шидэхгүй; зөвхөн PENDING session-ийг цуцлана */
  async cancelSession(providerRef: string): Promise<void> {
    const session = this.sessions.get(providerRef);
    if (!session) return; // dev процесс дахин ачаалагдахад мэдэгдэхгүй ref үлддэг — цуцлалт саад болохгүй
    const nowMs = this.nowMs();
    if (this.resolve(session, nowMs).state === 'PENDING') session.cancelledAtMs = nowMs;
  }

  parseWebhook(req: WebhookRequest): ProviderWebhookEvent {
    const given = headerValue(req.headers, MOCK_WEBHOOK_SIGNATURE_HEADER);
    if (given === undefined || !SHA256_HEX.test(given)) throw invalidWebhook('signature header missing or malformed');
    const expected = createHmac('sha256', this.options.webhookSecret).update(req.rawBody).digest();
    if (!timingSafeEqual(expected, Buffer.from(given, 'hex'))) throw invalidWebhook('signature mismatch');

    let payload: unknown;
    try {
      payload = JSON.parse(req.rawBody.toString('utf8'));
    } catch {
      throw invalidWebhook('body is not valid JSON');
    }
    const parsed = webhookBodySchema.safeParse(payload);
    if (!parsed.success) throw invalidWebhook('body is missing providerRef');
    // Өөр provider-ийн ref-ээр эндээс нэвтрэхээс сэргийлнэ
    if (!parsed.data.providerRef.startsWith(`${this.options.refPrefix}-`)) throw invalidWebhook('providerRef belongs to another provider');
    return { providerRef: parsed.data.providerRef };
  }

  owns(providerRef: string): boolean {
    return this.sessions.has(providerRef);
  }

  approveNow(providerRef: string): void {
    this.decide(providerRef, 'APPROVE');
  }

  declineNow(providerRef: string): void {
    this.decide(providerRef, 'DECLINE');
  }

  private decide(providerRef: string, kind: 'APPROVE' | 'DECLINE'): void {
    const session = this.require(providerRef);
    const nowMs = this.nowMs();
    const current = this.resolve(session, nowMs).state;
    if (current === (kind === 'APPROVE' ? 'SIGNED' : 'DECLINED')) return;
    if (current !== 'PENDING') throw new ESignProviderError('REJECTED', `mock session is ${current}, not pending`);
    // Тодорхой үйлдэл нь fixture-ийн төлөвлөсөн үр дүнг давна (77/11 нь "юу гарын үсэгт орсон" тул approve дээр хэвээр үлдэнэ)
    session.decision = { kind, atMs: nowMs };
  }

  private resolve(session: MockSession, nowMs: number): ProviderSessionState {
    if (session.decision) return session.decision.kind === 'APPROVE' ? this.signed(session, session.decision.atMs) : { state: 'DECLINED' };
    if (session.cancelledAtMs !== null || nowMs >= session.expiresAtMs) return { state: 'EXPIRED' };
    const outcomeAtMs = session.createdAtMs + this.options.approveAfterMs;
    if (session.fixture === 'NEVER_APPROVE' || nowMs < outcomeAtMs) return { state: 'PENDING' };
    switch (session.fixture) {
      case 'DECLINE':
        return { state: 'DECLINED' };
      case 'PROVIDER_ERROR':
        return { state: 'FAILED', code: MOCK_FAILURE_CODE, message: 'mock provider simulated a failure' };
      default:
        return this.signed(session, outcomeAtMs);
    }
  }

  /** Бүх утга session-ээс deterministic гарна — давтан getSession ижил гарын үсэг буцаана */
  private signed(session: MockSession, signedAtMs: number): ProviderSessionState {
    const ref = session.providerRef;
    const providerTxnId = derive('txn', ref);
    const serialNumber = derive('serial', ref);
    const signedDigestHex = session.fixture === 'DIGEST_MISMATCH' ? sha256Hex(`tampered:${session.digestHex}`) : session.digestHex;
    const subjectRegisterNo = session.fixture === 'IDENTITY_MISMATCH' ? otherRegisterNo(session.signer.registerNo) : session.signer.registerNo;
    const signedAt = new Date(signedAtMs);
    return {
      state: 'SIGNED',
      signature: {
        signatureCms: this.fakeCms({ providerRef: ref, providerTxnId, signedDigestHex, serialNumber, signedAt }),
        signedDigestHex,
        digestAlgorithm: 'SHA-256',
        signedAt,
        providerTxnId,
        certificate: {
          subjectName: session.signer.fullName,
          subjectRegisterNo,
          issuer: MOCK_CA_ISSUER,
          serialNumber,
          notBefore: new Date(session.createdAtMs - DAY_MS),
          notAfter: new Date(session.createdAtMs + 365 * DAY_MS),
        },
      },
    };
  }

  /** `MOCK-CMS\n<JSON>\n<hex HMAC>` — зориуд DER биш, PII (регистр/нэр) оруулахгүй */
  private fakeCms(fields: { providerRef: string; providerTxnId: string; signedDigestHex: string; serialNumber: string; signedAt: Date }): Buffer {
    const json = JSON.stringify({
      mock: true,
      notice: 'NOT A REAL SIGNATURE - LOS MOCK PROVIDER',
      provider: this.code,
      providerRef: fields.providerRef,
      providerTxnId: fields.providerTxnId,
      digestAlgorithm: 'SHA-256',
      signedDigestHex: fields.signedDigestHex,
      certificateSerial: fields.serialNumber,
      signedAt: fields.signedAt.toISOString(),
    });
    const body = `${MOCK_CMS_MARKER}\n${json}`;
    const mac = createHmac('sha256', this.options.webhookSecret).update(body).digest('hex');
    return Buffer.from(`${body}\n${mac}`, 'utf8');
  }

  private require(providerRef: string): MockSession {
    const session = this.sessions.get(providerRef);
    if (!session) throw new ESignProviderError('UNKNOWN_SESSION', 'unknown provider session');
    return session;
  }

  private nowMs(): number {
    return this.options.clock().getTime();
  }

  private purgeStale(nowMs: number): void {
    for (const [ref, session] of this.sessions) {
      if (nowMs - session.expiresAtMs > SESSION_RETENTION_MS) this.sessions.delete(ref);
    }
  }
}

function normalizeDigest(digest: DocumentDigest): string {
  if (digest.algorithm !== 'SHA-256' || !SHA256_HEX.test(digest.hex)) throw new ESignProviderError('REJECTED', 'document digest must be SHA-256 hex');
  return digest.hex.toLowerCase();
}

const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');
const derive = (label: string, providerRef: string): string => sha256Hex(`${label}:${providerRef}`).slice(0, 16).toUpperCase();

/** 4 оронтой код = sha256(digest hex + providerRef)-ийн эхний 4 байт mod 10000 */
function challengeCode(digestHex: string, providerRef: string): string {
  const n = createHash('sha256').update(digestHex + providerRef).digest().readUInt32BE(0);
  return String(n % 10_000).padStart(4, '0');
}

/** Гарын үсэг зурагчийнхаас ЗААВАЛ ялгаатай регистр (fixture 77 нь `…77`-оор төгсдөг тул `…00` ялгаатай) */
function otherRegisterNo(registerNo: string): string {
  const digits = createHash('sha256').update(`register:${registerNo}`).digest().readUIntBE(0, 6) % 1_000_000;
  return `ЯЯ${String(digits).padStart(6, '0')}00`;
}

function headerValue(headers: Record<string, string | undefined>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

const invalidWebhook = (reason: string): ESignProviderError => new ESignProviderError('INVALID_WEBHOOK', `invalid webhook: ${reason}`);
