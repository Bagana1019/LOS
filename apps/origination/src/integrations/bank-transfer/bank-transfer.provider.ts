import type { Provider } from '@nestjs/common';
import { Clock } from '@los/nest-common';
import { resolveIntegrationMode } from '../../shared/integration-mode';
import type { BankGatewayPort } from './bank-transfer.client';
import { MockBankGateway } from './bank-transfer.mock';
import { RealBankGateway } from './bank-transfer.real';

export const BANK_GATEWAY = Symbol('BANK_GATEWAY');

/** INTEGRATION_MODE / INTEGRATION_MODE_BANK_TRANSFER: mock (анхдагч) | real (skeleton — NotImplemented). */
export function createBankGateway(clock: Pick<Clock, 'now'>, env: NodeJS.ProcessEnv = process.env): BankGatewayPort {
  return resolveIntegrationMode('bank-transfer', env) === 'real' ? new RealBankGateway(env) : new MockBankGateway({ now: () => clock.now() });
}

export const bankGatewayProvider: Provider = { provide: BANK_GATEWAY, inject: [Clock], useFactory: (clock: Clock) => createBankGateway(clock) };
