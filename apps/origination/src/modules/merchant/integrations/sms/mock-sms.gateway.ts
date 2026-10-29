import { Logger } from '@nestjs/common';
import { maskPhone } from '../../common/masking';
import { SmsGateway } from '../../ports';

export interface SentSms { to: string; text: string }

const MAX_KEPT = 500;

/** DEMO/TEST: SMS-г санах ойд хадгална (тестэд `sent`-ээр уншина). Лог-д зөвхөн маскалсан утас — текст/код ХЭЗЭЭ Ч үгүй. */
export class MockSmsGateway extends SmsGateway {
  readonly sent: SentSms[] = [];
  private readonly logger = new Logger('MockSmsGateway');
  async send(toPhone: string, text: string): Promise<void> {
    this.sent.push({ to: toPhone, text });
    if (this.sent.length > MAX_KEPT) this.sent.shift();
    this.logger.log(`SMS (mock) queued to ${maskPhone(toPhone)}`);
  }
  /** Тестэд: тухайн дугаарт очсон сүүлийн SMS-ийн 6 оронтой код. */
  lastCodeFor(phone: string): string | null {
    const last = [...this.sent].reverse().find((m) => m.to === phone);
    return last ? (/\b(\d{6})\b/.exec(last.text)?.[1] ?? null) : null;
  }
}
