import type { PaymentProviderPort } from '../payment-provider/payment-provider.port';

/** SocialPay (Голомт банк)-ийн клиент. Нийтлэг порт хангалттай. */
export type SocialPayClient = PaymentProviderPort & { readonly provider: 'SOCIALPAY' };
