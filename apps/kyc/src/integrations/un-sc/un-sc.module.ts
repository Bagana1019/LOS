import { Module } from '@nestjs/common';
import { resolveIntegrationMode } from '../integration-mode';
import { MockUnScClient } from './mock-un-sc.client';
import { RealUnScClient } from './real-un-sc.client';
import { UN_SC_CLIENT, type UnScClient } from './un-sc.client';

/** INTEGRATION_MODE-оор mock / real сонгоно (CLAUDE.md §3.2.7). */
export function createUnScClient(env: Record<string, string | undefined> = process.env): UnScClient {
  return resolveIntegrationMode(env) === 'real' ? new RealUnScClient() : new MockUnScClient();
}

@Module({
  providers: [{ provide: UN_SC_CLIENT, useFactory: () => createUnScClient() }],
  exports: [UN_SC_CLIENT],
})
export class UnScModule {}
