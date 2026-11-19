import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { mockIntegrationsInProduction } from './integration-mode';

type Env = Record<string, string | undefined>;

/** Mock-оор ажиллаж буй интеграци байвал `warn` дуудаж нэрсийг буцаана (N3). Нэр нь env-ийн утга биш тул нууц алдагдахгүй. */
export function reportMockIntegrations(warn: (message: string) => void, env: Env = process.env): string[] {
  const mocked = mockIntegrationsInProduction(env);
  if (mocked.length) warn(`NODE_ENV=production but these integrations run in MOCK mode (fake success, no real call): ${mocked.join(', ')}`);
  return mocked;
}

/** Startup-д нэг удаа: production дээр INTEGRATION_MODE_<X>=mock үлдсэнийг ил болгоно. Хориглохгүй — staging ижил NODE_ENV-ээр ажилладаг (H3). */
@Injectable()
export class IntegrationModeReporter implements OnModuleInit {
  private readonly logger = new Logger(IntegrationModeReporter.name);

  onModuleInit(): void {
    reportMockIntegrations((message) => this.logger.warn(message));
  }
}
