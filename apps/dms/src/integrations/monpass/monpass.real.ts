// FR-11.4 Monpass — БОДИТ adapter-ийн STUB. Албан ёсны API гэрээ байхгүйгээр endpoint/payload зохиохгүй.
// Тохиргоо дутуу бол NOT_CONFIGURED, бүрэн бол бүх method NOT_IMPLEMENTED шиднэ (webhook-ийг ХЭЗЭЭ Ч зөвшөөрөхгүй — fail closed).
//
// TODO(FR-11.4 / Monpass real): доорхыг хүн нийлүүлэхгүй бол хэрэгжүүлэх боломжгүй —
//  1. Monpass-ийн албан ёсны API specification (нэвтрэлт, гарын үсгийн хүсэлт нээх/төлөв асуух/цуцлах, алдааны загвар, TTL-ийн хязгаар).
//  2. Sandbox эрх: MONPASS_BASE_URL, MONPASS_CLIENT_ID, MONPASS_CLIENT_SECRET (+ манай callback URL-ийг allowlist-д оруулах).
//  3. CMS гарын үсгийн гинжийг шалгах CA trust anchor (root/intermediate гэрчилгээ), цуцлалтын шалгалт (OCSP/CRL) ба алгоритмын профайл.
//  4. Webhook-ийн баталгаажуулалтын схем (HMAC толгой + алгоритм / mTLS / JWT / IP allowlist, replay хамгаалалт) ба MONPASS_WEBHOOK_SECRET.
//  5. Гэрчилгээ иргэний регистрийг ямар талбарт (subject attribute / OID, формат) агуулдаг — SignerCertificate.subjectRegisterNo-г гарган авахад.
//  6. Hash-ыг ямар кодчилолоор илгээх, provider detached CMS-ийг хэрхэн (signed attributes, timestamp) үүсгэдэг, challenge код/deep link буцаадаг эсэх.
import type {
  CreateProviderSessionInput,
  ESignProviderPort,
  ProviderSession,
  ProviderSessionState,
  ProviderWebhookEvent,
  WebhookRequest,
} from '../esign/esign-provider.port';
import { loadRealProviderConfig, notImplemented, type RealProviderConfig, type RealProviderEnv } from '../esign/real-config';

export class RealMonpassProvider implements ESignProviderPort {
  readonly code = 'MONPASS' as const;
  readonly displayName = 'Monpass';
  readonly isMock = false;

  constructor(private readonly env: RealProviderEnv = process.env) {}

  async createSession(_input: CreateProviderSessionInput): Promise<ProviderSession> {
    this.requireConfig();
    throw notImplemented(this.displayName, 'createSession');
  }

  async getSession(_providerRef: string): Promise<ProviderSessionState> {
    this.requireConfig();
    throw notImplemented(this.displayName, 'getSession');
  }

  async cancelSession(_providerRef: string): Promise<void> {
    this.requireConfig();
    throw notImplemented(this.displayName, 'cancelSession');
  }

  parseWebhook(_req: WebhookRequest): ProviderWebhookEvent {
    this.requireConfig();
    throw notImplemented(this.displayName, 'parseWebhook');
  }

  /** Тохиргоог дуудлага бүрт уншина — дутуу бол NOT_CONFIGURED */
  private requireConfig(): RealProviderConfig {
    return loadRealProviderConfig('MONPASS', this.env);
  }
}
