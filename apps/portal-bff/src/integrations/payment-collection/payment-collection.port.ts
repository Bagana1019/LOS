import type {
  PortalCreatePaymentCommand,
  PortalPayment,
  PortalPaymentList,
  PortalPaymentListQuery,
  PortalPaymentMethodLimit,
} from '@los/contracts';
import type { CallContext } from '../../common/request-context';

export const PAYMENT_COLLECTION = Symbol('PAYMENT_COLLECTION');

/**
 * Эргэн төлөлт хүлээн авах (QPay / SocialPay / банкны данс). Төлбөрийн бичлэг, провайдерын нэхэмжлэх,
 * callback-ийн баталгаажуулалт, Core руу тусгах нь origination-ы үүрэг; portal-bff зөвхөн эхлүүлж, төлөв асууна.
 */
export interface PaymentCollectionPort {
  /** Зээл тус бүрийн идэвхтэй төлбөрийн хэрэгсэл ба дээд/доод хязгаар. */
  listMethods(ctx: CallContext, loanId: string): Promise<PortalPaymentMethodLimit[]>;
  /** `idempotencyKey` — downstream мөн (customerId, key)-ээр давхардлыг хаана. */
  create(ctx: CallContext, cmd: PortalCreatePaymentCommand, idempotencyKey: string): Promise<PortalPayment>;
  get(ctx: CallContext, paymentId: string): Promise<PortalPayment>;
  list(ctx: CallContext, loanId: string, query: PortalPaymentListQuery): Promise<PortalPaymentList>;
}
