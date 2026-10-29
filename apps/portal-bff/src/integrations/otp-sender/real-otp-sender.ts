import { z } from 'zod';
import type { AnonymousContext } from '../../common/request-context';
import { InternalHttpClient } from '../internal-http.client';
import type { OtpSenderPort } from './otp-sender.port';

/** origination.notification-ийн SMS adapter-ээр илгээнэ. Код лог/аудитад орохгүй. */
export class RealOtpSender implements OtpSenderPort {
  constructor(private readonly http: InternalHttpClient) {}

  async send(input: { customerId: string; code: string; ttlSec: number }, ctx: AnonymousContext): Promise<void> {
    await this.http.json({
      method: 'POST',
      path: '/api/internal/portal/otp',
      ctx: { ...ctx, customerId: input.customerId },
      body: { code: input.code, ttlSec: input.ttlSec },
      schema: z.object({}).passthrough(),
    });
  }
}
