import { Module } from '@nestjs/common';
import { resolveIntegrationMode } from '../integration-mode';
import { MockUnScClient } from './mock-un-sc.client';
import { RealUnScClient } from './real-un-sc.client';
import { UN_SC_CLIENT, type UnScClient } from './un-sc.client';
import { assertUnScProductionConfig } from './un-sc.config';

/** INTEGRATION_MODE-оор mock / real сонгоно (CLAUDE.md §3.2.7). */
export function createUnScClient(env: Record<string, string | undefined> = process.env): UnScClient {
  if (resolveIntegrationMode(env) !== 'real') return new MockUnScClient();
  assertUnScProductionConfig(env); // production + real: тохиргоо буруу (http URL гэх мэт) бол bootstrap-д унана
  return new RealUnScClient({ env });
}

@Module({
  providers: [{ provide: UN_SC_CLIENT, useFactory: () => createUnScClient() }],
  exports: [UN_SC_CLIENT],
})
export class UnScModule {}
