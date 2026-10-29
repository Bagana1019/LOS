import { DomainError } from '../domain/errors';
import { MockSmsGateway } from '../integrations/sms/mock-sms.gateway';

/** Тестэд: SMS operator-ын гэмтлийг дуурайдаг боломжтой MockSmsGateway. */
export class ControllableSms extends MockSmsGateway {
  failing = false;
  override async send(toPhone: string, text: string): Promise<void> {
    if (this.failing) throw new DomainError('SMS_UNAVAILABLE', 'SMS operator is not configured');
    return super.send(toPhone, text);
  }
}
