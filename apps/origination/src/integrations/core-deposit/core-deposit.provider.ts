import type { Provider } from '@nestjs/common';
import { resolveIntegrationMode } from '../../shared/integration-mode';
import type { CoreDepositPort } from './core-deposit.port';
import { MockCoreDepositPort } from './core-deposit.mock';
import { RealCoreDepositPort } from './core-deposit.real';

export const CORE_DEPOSIT_PORT = Symbol('CORE_DEPOSIT_PORT');

/** INTEGRATION_MODE / INTEGRATION_MODE_CORE_DEPOSIT: mock (анхдагч) | real (skeleton — NotImplemented). */
export function createCoreDepositPort(env: NodeJS.ProcessEnv = process.env): CoreDepositPort {
  return resolveIntegrationMode('core-deposit', env) === 'real' ? new RealCoreDepositPort(env) : new MockCoreDepositPort();
}

export const coreDepositProvider: Provider = { provide: CORE_DEPOSIT_PORT, useFactory: () => createCoreDepositPort() };
