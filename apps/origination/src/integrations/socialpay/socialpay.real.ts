// SocialPay (Голомт банк) — бодит холболтын SKELETON.
// SocialPay-ийн API баримт, credential байхгүй тул protocol-ыг ТААМАГЛАЖ зохиохгүй (docs/04 "Хүний оролцоо" #1).
// Тохиргоо (env) шалгаж, дараа нь тодорхой NotImplemented алдаа шиднэ. Mock нь бүрэн (socialpay.mock.ts).
import { requireEnv } from '../../shared/integration-mode';
import type { IntegrationMode } from '@los/contracts';
import type { CreateProviderInvoiceRequest, ProviderCheckResult, ProviderInvoice, ProviderInvoiceRef } from '../payment-provider/payment-provider.port';
import { ProviderNotImplementedError } from '../payment-provider/provider-errors';
import type { SocialPayClient } from './socialpay.client';

// TODO(SocialPay API баримт ирсний дараа): env нэр, нэвтрэлт, invoice үүсгэх / шалгах / цуцлах дуудлагыг хэрэгжүүлж, fetch stub-тай unit тест бичнэ.
const REQUIRED_ENV = ['SOCIALPAY_BASE_URL', 'SOCIALPAY_MERCHANT_ID', 'SOCIALPAY_SECRET', 'SOCIALPAY_CALLBACK_BASE_URL'];

export class RealSocialPayClient implements SocialPayClient {
  readonly provider = 'SOCIALPAY' as const;
  readonly mode: IntegrationMode = 'real';
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  /** Бодит хэрэгжилт байхгүй тул тохиргоо бүрэн байсан ч хүсэлт хүлээж авахгүй. */
  isAvailable(): boolean { return false; }
  unavailableReason(): 'NOT_CONFIGURED' | 'NOT_IMPLEMENTED' { return REQUIRED_ENV.every((n) => !!this.env[n]) ? 'NOT_IMPLEMENTED' : 'NOT_CONFIGURED'; }

  private guard(): never {
    requireEnv('socialpay', REQUIRED_ENV, this.env); // дутуу бол IntegrationNotConfiguredError
    throw new ProviderNotImplementedError('SocialPay', 'SocialPay-ийн бодит холболт хараахан хэрэгжээгүй байна (API баримт, credential хүлээгдэж байна)');
  }

  createInvoice(_req: CreateProviderInvoiceRequest): Promise<ProviderInvoice> { return Promise.resolve().then(() => this.guard()); }
  checkInvoice(_ref: ProviderInvoiceRef): Promise<ProviderCheckResult> { return Promise.resolve().then(() => this.guard()); }
  cancelInvoice(_ref: ProviderInvoiceRef): Promise<void> { return Promise.resolve().then(() => this.guard()); }
}
