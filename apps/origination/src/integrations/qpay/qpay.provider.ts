import type { Provider } from '@nestjs/common';
import { Clock } from '@los/nest-common';
import { resolveIntegrationMode } from '../../shared/integration-mode';
import type { QPayClient } from './qpay.client';
import { MockQPayClient } from './qpay.mock';
import { assertQPayProductionConfig, RealQPayClient } from './qpay.real';

export const QPAY_CLIENT = Symbol('QPAY_CLIENT');

/**
 * INTEGRATION_MODE / INTEGRATION_MODE_QPAY: mock (анхдагч) | real.
 * Real + production: тохиргоо дутуу / sandbox / http бол bootstrap-д унана (assertQPayProductionConfig).
 * Real + production биш: апп унагахгүй — дуудлага дээр IntegrationNotConfiguredError.
 */
export function createQPayClient(clock: Pick<Clock, 'now'>, env: NodeJS.ProcessEnv = process.env): QPayClient {
  const now = () => clock.now();
  if (resolveIntegrationMode('qpay', env) !== 'real') return new MockQPayClient({ now });
  assertQPayProductionConfig(env);
  return new RealQPayClient({ env, now });
}

export const qpayClientProvider: Provider = { provide: QPAY_CLIENT, inject: [Clock], useFactory: (clock: Clock) => createQPayClient(clock) };
