import { requireEnv } from '../../shared/integration-mode';
import { IntegrationNotImplementedError } from '../channel/channel-error';
import type { PushGateway, PushMessage, PushResult } from './push.gateway';

export const PUSH_REQUIRED_ENV = ['FCM_PROJECT_ID', 'FCM_SERVICE_ACCOUNT_JSON'];

/**
 * FCM HTTP v1 (Android/Web) ба APNs (iOS) жинхэнэ холболт.
 * TODO(docs/04 "Хүний оролцоо" #1): Firebase төсөл, service account (FCM_PROJECT_ID, FCM_SERVICE_ACCOUNT_JSON), APNs түлхүүр гараагүй тул
 * OAuth2 токен авах, мессежийн хэлбэрийг таамаглаж зохиогоогүй. Хэрэгжүүлэхдээ: UNREGISTERED / INVALID_ARGUMENT(token) → ChannelError('INVALID_TOKEN', false),
 * QUOTA_EXCEEDED → RATE_LIMITED, UNAVAILABLE/INTERNAL/сүлжээ → retryable=true.
 */
export class RealPushGateway implements PushGateway {
  readonly mode = 'real' as const;
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async send(_message: PushMessage): Promise<PushResult> {
    requireEnv('push', PUSH_REQUIRED_ENV, this.env); // тохиргоо дутуу бол IntegrationNotConfiguredError
    throw new IntegrationNotImplementedError('push', 'Push (FCM/APNs) интеграци хараахан хэрэгжээгүй байна: Firebase төсөл, service account шаардлагатай (docs/04 "Хүний оролцоо" #1)');
  }
}
