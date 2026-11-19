import { Module } from '@nestjs/common';
import { resolveIntegrationMode } from '../integration-mode';
import { MockXypClient } from './mock-xyp.client';
import { RealXypClient } from './real-xyp.client';
import { XYP_CLIENT, type XypClient } from './xyp.client';
import { assertXypProductionConfig } from './xyp.config';

/** INTEGRATION_MODE-оор mock / real сонгоно (CLAUDE.md §3.2.7). */
export function createXypClient(env: Record<string, string | undefined> = process.env): XypClient {
  if (resolveIntegrationMode(env) !== 'real') return new MockXypClient();
  assertXypProductionConfig(env); // production + real: тохиргоо дутуу / http WSDL бол bootstrap-д унана
  return new RealXypClient({ env });
}

@Module({
  providers: [{ provide: XYP_CLIENT, useFactory: () => createXypClient() }],
  exports: [XYP_CLIENT],
})
export class XypIntegrationModule {}
