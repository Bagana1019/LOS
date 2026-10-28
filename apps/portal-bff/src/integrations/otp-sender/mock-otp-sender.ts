import type { AnonymousContext } from '../../common/request-context';
import type { OtpSenderPort } from './otp-sender.port';

/** Хөгжүүлэлт/тест: SMS илгээхгүй, кодыг санах ойд хадгалж тест уншина. Лог руу бичихгүй. */
export class MockOtpSender implements OtpSenderPort {
  readonly sent: Array<{ customerId: string; code: string; ttlSec: number }> = [];

  async send(input: { customerId: string; code: string; ttlSec: number }, _ctx: AnonymousContext): Promise<void> {
    this.sent.push(input);
    if (this.sent.length > 100) this.sent.shift();
  }

  lastCodeFor(customerId: string): string | undefined {
    return [...this.sent].reverse().find((s) => s.customerId === customerId)?.code;
  }
}
