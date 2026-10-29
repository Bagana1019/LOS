import type { AnonymousContext } from '../../common/request-context';

export const OTP_SENDER = Symbol('OTP_SENDER');

/**
 * OTP-г харилцагчийн БҮРТГЭЛТЭЙ утас руу SMS-ээр илгээнэ. Утсыг энд дамжуулахгүй — зөвхөн customerId;
 * хүлээн авагчийн дугаарыг мэдэгдлийн систем (origination.notification) өөрөө тодорхойлно.
 */
export interface OtpSenderPort {
  send(input: { customerId: string; code: string; ttlSec: number }, ctx: AnonymousContext): Promise<void>;
}
