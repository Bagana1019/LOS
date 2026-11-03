import { Module } from '@nestjs/common';
import { resolveIntegrationMode } from '../integration-mode';
import { MockNdshClient } from './mock-ndsh.client';
import { NDSH_CLIENT, type NdshClient } from './ndsh.client';
import { RealNdshClient } from './real-ndsh.client';

export function createNdshClient(env: Record<string, string | undefined> = process.env): NdshClient {
  return resolveIntegrationMode(env) === 'real' ? new RealNdshClient() : new MockNdshClient();
}

@Module({ providers: [{ provide: NDSH_CLIENT, useFactory: () => createNdshClient() }], exports: [NDSH_CLIENT] })
export class NdshIntegrationModule {}
