import type { Provider } from '@nestjs/common';
import { Clock } from '@los/nest-common';
import { resolveIntegrationMode } from '../../shared/integration-mode';
import type { SocialPayClient } from './socialpay.client';
import { MockSocialPayClient } from './socialpay.mock';
import { RealSocialPayClient } from './socialpay.real';

export const SOCIALPAY_CLIENT = Symbol('SOCIALPAY_CLIENT');

/** INTEGRATION_MODE / INTEGRATION_MODE_SOCIALPAY: mock (анхдагч) | real (skeleton — NotImplemented). */
export function createSocialPayClient(clock: Pick<Clock, 'now'>, env: NodeJS.ProcessEnv = process.env): SocialPayClient {
  return resolveIntegrationMode('socialpay', env) === 'real' ? new RealSocialPayClient(env) : new MockSocialPayClient({ now: () => clock.now() });
}

export const socialPayClientProvider: Provider = { provide: SOCIALPAY_CLIENT, inject: [Clock], useFactory: (clock: Clock) => createSocialPayClient(clock) };
