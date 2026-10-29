import { requireEnv } from '../../shared/integration-mode';
import { IntegrationNotImplementedError } from '../channel/channel-error';
import type { SmsGateway, SmsMessage, SmsResult } from './sms.gateway';

export const SMS_REQUIRED_ENV = ['SMS_API_URL', 'SMS_API_KEY', 'SMS_SENDER_ID'];

/**
 * Монголын SMS провайдерын (Mobicom / Unitel / Skytel / G-Mobile …) жинхэнэ холболт.
 * TODO(docs/04 "Хүний оролцоо" #1): провайдерын API-ын баримт, credential (SMS_API_URL, SMS_API_KEY, SMS_SENDER_ID) гараагүй тул
 * protocol-ыг таамаглаж зохиогоогүй. Баримт ирэхэд `send`-ийг энд хэрэгжүүлнэ: 4xx → ChannelError(retryable=false),
 * 429 → RATE_LIMITED, 5xx/сүлжээ/timeout → retryable=true.
 */
export class RealSmsGateway implements SmsGateway {
  readonly mode = 'real' as const;
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async send(_message: SmsMessage): Promise<SmsResult> {
    requireEnv('sms', SMS_REQUIRED_ENV, this.env); // тохиргоо дутуу бол IntegrationNotConfiguredError
    throw new IntegrationNotImplementedError('sms', 'SMS провайдерын интеграци хараахан хэрэгжээгүй байна: провайдерын API-ын баримт, credential шаардлагатай (docs/04 "Хүний оролцоо" #1)');
  }
}
