import type { Provider } from '@nestjs/common';
import { resolveIntegrationMode } from '../../shared/integration-mode';
import type { EmailGateway } from './email.gateway';
import { MockEmailGateway } from './email.mock';
import { RealEmailGateway } from './email.real';

export const EMAIL_GATEWAY = Symbol('EMAIL_GATEWAY');

/** INTEGRATION_MODE / INTEGRATION_MODE_EMAIL: mock (анхдагч) | real (SMTP; тохиргоо дутуу бол дуудлага дээр IntegrationNotConfiguredError). */
export function createEmailGateway(env: NodeJS.ProcessEnv = process.env): EmailGateway {
  return resolveIntegrationMode('email', env) === 'real' ? new RealEmailGateway({ env }) : new MockEmailGateway();
}

export const emailGatewayProvider: Provider = { provide: EMAIL_GATEWAY, useFactory: () => createEmailGateway() };
