import type { Provider } from '@nestjs/common';
import { Clock } from '@los/nest-common';
import { resolveIntegrationMode } from '../../shared/integration-mode';
import type { QPayClient } from './qpay.client';
import { MockQPayClient } from './qpay.mock';
import { RealQPayClient } from './qpay.real';

export const QPAY_CLIENT = Symbol('QPAY_CLIENT');

/** INTEGRATION_MODE / INTEGRATION_MODE_QPAY: mock (анхдагч) | real. Real нь тохиргоо дутуу бол апп унагахгүй — дуудлага дээр IntegrationNotConfiguredError. */
export function createQPayClient(clock: Pick<Clock, 'now'>, env: NodeJS.ProcessEnv = process.env): QPayClient {
  const now = () => clock.now();
  return resolveIntegrationMode('qpay', env) === 'real' ? new RealQPayClient({ env, now }) : new MockQPayClient({ now });
}

export const qpayClientProvider: Provider = { provide: QPAY_CLIENT, inject: [Clock], useFactory: (clock: Clock) => createQPayClient(clock) };
