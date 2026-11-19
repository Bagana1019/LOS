import { Module } from '@nestjs/common';
import { resolveIntegrationMode } from '../integration-mode';
import { FATF_CLIENT, type FatfClient } from './fatf.client';
import { assertFatfProductionConfig } from './fatf.config';
import { MockFatfClient } from './mock-fatf.client';
import { RealFatfClient } from './real-fatf.client';

/** INTEGRATION_MODE-оор mock / real сонгоно (CLAUDE.md §3.2.7). */
export function createFatfClient(env: Record<string, string | undefined> = process.env): FatfClient {
  if (resolveIntegrationMode(env) !== 'real') return new MockFatfClient();
  assertFatfProductionConfig(env); // production + real: FATF_LIST_FILE дутуу / буруу бол bootstrap-д унана
  return new RealFatfClient({ env });
}

@Module({
  providers: [{ provide: FATF_CLIENT, useFactory: () => createFatfClient() }],
  exports: [FATF_CLIENT],
})
export class FatfModule {}
