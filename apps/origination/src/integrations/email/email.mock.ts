import { Logger } from '@nestjs/common';
import { ChannelError, ChannelErrorCode, maskAddress } from '../channel/channel-error';
import type { EmailGateway, EmailMessage, EmailResult } from './email.gateway';

export interface MockEmailRecord { to: string; subject: string; text: string; html?: string; ref: string; providerMessageId: string }

const SIMPLE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Deterministic имэйл mock: санах ойн outbox, `mock-email-<n>` ID. */
export class MockEmailGateway implements EmailGateway {
  readonly mode = 'mock' as const;
  readonly outbox: MockEmailRecord[] = [];
  private seq = 0;
  private failures: Array<{ retryable: boolean; code: ChannelErrorCode }> = [];
  private readonly logger = new Logger('MockEmail');

  failNext(n: number, opts: { retryable: boolean; code?: ChannelErrorCode }): void {
    for (let i = 0; i < n; i++) this.failures.push({ retryable: opts.retryable, code: opts.code ?? (opts.retryable ? 'PROVIDER_ERROR' : 'INVALID_ADDRESS') });
  }

  reset(): void { this.outbox.length = 0; this.seq = 0; this.failures = []; }

  async send(message: EmailMessage): Promise<EmailResult> {
    const failure = this.failures.shift();
    if (failure) throw new ChannelError(failure.code, failure.retryable);
    if (!SIMPLE_EMAIL.test(message.to)) throw new ChannelError('INVALID_ADDRESS', false);
    const providerMessageId = `mock-email-${++this.seq}`;
    this.outbox.push({ to: message.to, subject: message.subject, text: message.text, html: message.html, ref: message.reference, providerMessageId });
    this.logger.debug(`${providerMessageId} → ${maskAddress('EMAIL', message.to)}`);
    return { providerMessageId };
  }
}
