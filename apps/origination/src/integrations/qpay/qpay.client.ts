import type { PaymentProviderPort } from '../payment-provider/payment-provider.port';

/** QPay merchant API v2-ийн клиент. Нийтлэг порт (createInvoice / checkInvoice / cancelInvoice) хангалттай. */
export type QPayClient = PaymentProviderPort & { readonly provider: 'QPAY' };

/** Real клиентийн env тохиргоо. */
export interface QPayConfig {
  baseUrl: string;
  username: string;
  password: string;
  invoiceCode: string;
  /** Нийтэд хандах боломжтой суурь URL (gateway-ийн `/api` угтвартай). callback_url = `<base>/payments/callbacks/qpay?invoice=<senderInvoiceNo>`. */
  callbackBaseUrl: string;
}
