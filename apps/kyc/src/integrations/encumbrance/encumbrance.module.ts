import { Module } from '@nestjs/common';
import { resolveIntegrationMode } from '../integration-mode';
import { ENCUMBRANCE_REGISTRY, type EncumbranceRegistry } from './encumbrance.registry';
import { MockEncumbranceRegistry } from './mock-encumbrance.registry';
import { RealEncumbranceRegistry } from './real-encumbrance.registry';

/** INTEGRATION_MODE-оор mock / real сонгоно (CLAUDE.md §3.2.7). */
export function createEncumbranceRegistry(env: Record<string, string | undefined> = process.env): EncumbranceRegistry {
  return resolveIntegrationMode(env) === 'real'
    ? new RealEncumbranceRegistry({ zmsBaseUrl: env.ZMS_BASE_URL, ebBaseUrl: env.EB_BASE_URL })
    : new MockEncumbranceRegistry();
}

@Module({
  providers: [{ provide: ENCUMBRANCE_REGISTRY, useFactory: () => createEncumbranceRegistry() }],
  exports: [ENCUMBRANCE_REGISTRY],
})
export class EncumbranceIntegrationModule {}
