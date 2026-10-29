import type { Provider } from '@nestjs/common';
import { resolveIntegrationMode } from '../../shared/integration-mode';
import type { PushGateway } from './push.gateway';
import { MockPushGateway } from './push.mock';
import { RealPushGateway } from './push.real';

export const PUSH_GATEWAY = Symbol('PUSH_GATEWAY');

/** INTEGRATION_MODE / INTEGRATION_MODE_PUSH: mock (анхдагч) | real (skeleton — NotImplemented). */
export function createPushGateway(env: NodeJS.ProcessEnv = process.env): PushGateway {
  return resolveIntegrationMode('push', env) === 'real' ? new RealPushGateway(env) : new MockPushGateway();
}

export const pushGatewayProvider: Provider = { provide: PUSH_GATEWAY, useFactory: () => createPushGateway() };
