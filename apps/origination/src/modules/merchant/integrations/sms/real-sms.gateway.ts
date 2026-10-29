import { DomainError } from '../../domain/errors';
import { SmsGateway } from '../../ports';

/** SMS operator-ын credential хүлээгдэж байна (docs/05 §11) — идэвхжих хүртэл үргэлж SMS_UNAVAILABLE. */
export class RealSmsGateway extends SmsGateway {
  async send(): Promise<void> {
    throw new DomainError('SMS_UNAVAILABLE', 'SMS operator is not configured');
  }
}
