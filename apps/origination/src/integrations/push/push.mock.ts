import { Logger } from '@nestjs/common';
import { ChannelError, ChannelErrorCode, maskAddress } from '../channel/channel-error';
import type { PushGateway, PushMessage, PushResult } from './push.gateway';

export interface MockPushRecord { token: string; title: string; body: string; data?: Record<string, string>; ref: string; providerMessageId: string }

/** Deterministic push mock: санах ойн outbox, `mock-push-<n>` ID; `invalidateToken(token)` — тухайн токен INVALID_TOKEN болно. */
export class MockPushGateway implements PushGateway {
  readonly mode = 'mock' as const;
  readonly outbox: MockPushRecord[] = [];
  private seq = 0;
  private failures: Array<{ retryable: boolean; code: ChannelErrorCode }> = [];
  private readonly invalid = new Set<string>();
  private readonly logger = new Logger('MockPush');

  failNext(n: number, opts: { retryable: boolean; code?: ChannelErrorCode }): void {
    for (let i = 0; i < n; i++) this.failures.push({ retryable: opts.retryable, code: opts.code ?? (opts.retryable ? 'PROVIDER_ERROR' : 'INVALID_TOKEN') });
  }

  invalidateToken(token: string): void { this.invalid.add(token); }

  reset(): void { this.outbox.length = 0; this.seq = 0; this.failures = []; this.invalid.clear(); }

  async send(message: PushMessage): Promise<PushResult> {
    const failure = this.failures.shift();
    if (failure) throw new ChannelError(failure.code, failure.retryable);
    if (this.invalid.has(message.token)) throw new ChannelError('INVALID_TOKEN', false);
    const providerMessageId = `mock-push-${++this.seq}`;
    this.outbox.push({ token: message.token, title: message.title, body: message.body, data: message.data, ref: message.reference, providerMessageId });
    this.logger.debug(`${providerMessageId} → ${maskAddress('PUSH', message.token)}`);
    return { providerMessageId };
  }
}
