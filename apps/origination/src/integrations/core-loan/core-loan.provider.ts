import type { Provider } from '@nestjs/common';
import { resolveIntegrationMode } from '../../shared/integration-mode';
import type { CoreLoanPort } from './core-loan.port';
import { MockCoreLoanPort } from './core-loan.mock';
import { RealCoreLoanPort } from './core-loan.real';

export const CORE_LOAN_PORT = Symbol('CORE_LOAN_PORT');

/** INTEGRATION_MODE / INTEGRATION_MODE_CORE_LOAN: mock (анхдагч) | real (skeleton — NotImplemented). */
export function createCoreLoanPort(env: NodeJS.ProcessEnv = process.env): CoreLoanPort {
  return resolveIntegrationMode('core-loan', env) === 'real' ? new RealCoreLoanPort(env) : new MockCoreLoanPort();
}
export const coreLoanProvider: Provider = { provide: CORE_LOAN_PORT, useFactory: () => createCoreLoanPort() };
