import { Module } from '@nestjs/common';
import { resolveIntegrationMode } from '../integration-mode';
import { FATF_CLIENT, type FatfClient } from './fatf.client';
import { MockFatfClient } from './mock-fatf.client';
import { RealFatfClient } from './real-fatf.client';

/** INTEGRATION_MODE-оор mock / real сонгоно (CLAUDE.md §3.2.7). */
export function createFatfClient(env: Record<string, string | undefined> = process.env): FatfClient {
  return resolveIntegrationMode(env) === 'real' ? new RealFatfClient() : new MockFatfClient();
}

@Module({
  providers: [{ provide: FATF_CLIENT, useFactory: () => createFatfClient() }],
  exports: [FATF_CLIENT],
})
export class FatfModule {}
