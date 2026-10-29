import type { Provider } from '@nestjs/common';
import { resolveIntegrationMode } from '../../shared/integration-mode';
import type { SmsGateway } from './sms.gateway';
import { MockSmsGateway } from './sms.mock';
import { RealSmsGateway } from './sms.real';

export const SMS_GATEWAY = Symbol('SMS_GATEWAY');

/** INTEGRATION_MODE / INTEGRATION_MODE_SMS: mock (анхдагч) | real (skeleton — NotImplemented). */
export function createSmsGateway(env: NodeJS.ProcessEnv = process.env): SmsGateway {
  return resolveIntegrationMode('sms', env) === 'real' ? new RealSmsGateway(env) : new MockSmsGateway();
}

export const smsGatewayProvider: Provider = { provide: SMS_GATEWAY, useFactory: () => createSmsGateway() };
