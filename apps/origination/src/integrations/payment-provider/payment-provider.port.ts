import type { IntegrationMode, PaymentDeeplink } from '@los/contracts';

// NFR-2 / CLAUDE.md §3.2.7: QPay, SocialPay нь нэг нийтлэг порт хэрэгжүүлнэ. Банкны шилжүүлэг өөр (BankGatewayPort — integrations/bank-transfer).
export type InvoiceProvider = 'QPAY' | 'SOCIALPAY';

export interface CreateProviderInvoiceRequest {
  /** Манай тал дахь давтагдашгүй дугаар (PaymentInvoice.senderInvoiceNo). Провайдерт idempotency түлхүүр болно. */
  senderInvoiceNo: string;
  amount: number;
  currency: string;
  /** Төлбөр хийгчид харагдах тайлбар (≤ 200 тэмдэгт). */
  description: string;
  /** Хүлээн авагчийг ялгах код (жишээ: хүсэлтийн дугаар). */
  receiverCode: string;
  expiresAt: Date;
}

export interface ProviderInvoice {
  providerInvoiceId: string;
  qrText: string | null;
  /** base64 PNG (data URL биш). */
  qrImage: string | null;
  deeplinks: PaymentDeeplink[];
  /** Нууц/токенгүй болгосон провайдерын хариу (PaymentInvoice.providerResponseJson). */
  raw: Record<string, unknown>;
}

export interface ProviderInvoiceRef { providerInvoiceId: string; senderInvoiceNo: string }

export interface ProviderPayment {
  providerPaymentId: string;
  amount: number;
  currency: string;
  paidAt: Date;
  payerName?: string | null;
  /** Бүтэн дансны дугаар байж болно — хадгалахдаа заавал нуугдмал болгоно (maskAccountNo). */
  payerAccount?: string | null;
  raw?: unknown;
}

export interface ProviderCheckResult { paid: boolean; payments: ProviderPayment[] }

export interface PaymentProviderPort {
  readonly provider: InvoiceProvider;
  readonly mode: IntegrationMode;
  /** Хүсэлт хүлээж авах боломжтой эсэх: mock үргэлж true; real горимд тохиргоо бүрэн + хэрэгжсэн байх ёстой. */
  isAvailable(): boolean;
  /** isAvailable()=false үед шалтгаан. */
  unavailableReason(): 'NOT_CONFIGURED' | 'NOT_IMPLEMENTED' | null;
  createInvoice(req: CreateProviderInvoiceRequest): Promise<ProviderInvoice>;
  checkInvoice(ref: ProviderInvoiceRef): Promise<ProviderCheckResult>;
  cancelInvoice(ref: ProviderInvoiceRef): Promise<void>;
}

/** Тестээс удирдах боломжтой mock-ийн нэмэлт интерфейс (CLAUDE.md §3.2.7: deterministic fixture). */
export interface SimulatableProvider {
  simulatePayment(providerInvoiceId: string, opts?: { amount?: number; paidAt?: Date; payerName?: string; payerAccount?: string }): ProviderPayment;
  failNext(opts?: FailNextOptions): void;
}

export type ProviderMethod = 'createInvoice' | 'checkInvoice' | 'cancelInvoice';
export interface FailNextOptions { method?: ProviderMethod; error?: Error; times?: number }

export function isSimulatable(p: unknown): p is SimulatableProvider {
  return !!p && typeof (p as SimulatableProvider).simulatePayment === 'function' && typeof (p as SimulatableProvider).failNext === 'function';
}
