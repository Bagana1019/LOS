import { Logger } from '@nestjs/common';
import { ChannelError, ChannelErrorCode, maskAddress } from '../channel/channel-error';
import type { SmsGateway, SmsMessage, SmsResult } from './sms.gateway';

export interface MockSmsRecord { to: string; text: string; ref: string; providerMessageId: string }
export interface FailNextOptions { retryable: boolean; code?: ChannelErrorCode }

const E164_MN = /^\+976[1-9]\d{7}$/;

/** Deterministic SMS mock (CLAUDE.md §3.2.7): санах ойн outbox, `mock-sms-<n>` ID. Жинхэнэ сүлжээ ашиглахгүй. */
export class MockSmsGateway implements SmsGateway {
  readonly mode = 'mock' as const;
  readonly outbox: MockSmsRecord[] = [];
  private seq = 0;
  private failures: Array<{ retryable: boolean; code: ChannelErrorCode }> = [];
  private readonly logger = new Logger('MockSms');

  /** Дараагийн `n` илгээлтийг амжилтгүй болгоно. code өгөөгүй бол retryable ? PROVIDER_ERROR : INVALID_ADDRESS. */
  failNext(n: number, opts: FailNextOptions): void {
    for (let i = 0; i < n; i++) this.failures.push({ retryable: opts.retryable, code: opts.code ?? (opts.retryable ? 'PROVIDER_ERROR' : 'INVALID_ADDRESS') });
  }

  reset(): void { this.outbox.length = 0; this.seq = 0; this.failures = []; }

  async send(message: SmsMessage): Promise<SmsResult> {
    const failure = this.failures.shift();
    if (failure) throw new ChannelError(failure.code, failure.retryable);
    if (!E164_MN.test(message.to)) throw new ChannelError('INVALID_ADDRESS', false);
    const providerMessageId = `mock-sms-${++this.seq}`;
    this.outbox.push({ to: message.to, text: message.text, ref: message.reference, providerMessageId });
    this.logger.debug(`${providerMessageId} → ${maskAddress('SMS', message.to)}`);
    return { providerMessageId };
  }
}
