import { Module } from '@nestjs/common';
import { resolveIntegrationMode } from '../integration-mode';
import { MockXypClient } from './mock-xyp.client';
import { RealXypClient } from './real-xyp.client';
import { XYP_CLIENT, type XypClient } from './xyp.client';

/** INTEGRATION_MODE-оор mock / real сонгоно (CLAUDE.md §3.2.7). */
export function createXypClient(env: Record<string, string | undefined> = process.env): XypClient {
  return resolveIntegrationMode(env) === 'real' ? new RealXypClient({ baseUrl: env.XYP_BASE_URL }) : new MockXypClient();
}

@Module({
  providers: [{ provide: XYP_CLIENT, useFactory: () => createXypClient() }],
  exports: [XYP_CLIENT],
})
export class XypIntegrationModule {}
