// Nest DI: decorator metadata-гүй (esbuild) орчинд ч PrismaBsaRepository-ийн хамаарал `@Inject`-ээр зөв шийдэгдэх ёстой.
import 'reflect-metadata';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { PII_CIPHER } from '../infra.ports';
import { BSA_REPOSITORY } from './bsa.repository';
import { PrismaBsaRepository } from './prisma-bsa.repository';
import { BsaPersistenceModule } from './persistence.module';
import { PrismaService } from './prisma.service';
import { TestPiiCipher } from './testing/test-pii-cipher';

@Module({ providers: [{ provide: PII_CIPHER, useClass: TestPiiCipher }], exports: [PII_CIPHER] })
class FakeCipherModule {}

@Global()
@Module({ providers: [{ provide: PII_CIPHER, useClass: TestPiiCipher }], exports: [PII_CIPHER] })
class GlobalCipherModule {}

describe('BsaPersistenceModule', () => {
  it('wires PrismaBsaRepository behind BSA_REPOSITORY using an imported PII_CIPHER (no DB connection until init)', async () => {
    const mod = await Test.createTestingModule({ imports: [BsaPersistenceModule.register({ imports: [FakeCipherModule] })] }).compile();
    const repo = mod.get(BSA_REPOSITORY);
    expect(repo).toBeInstanceOf(PrismaBsaRepository);
    expect(mod.get(PrismaBsaRepository)).toBe(repo);
    expect(mod.get(PrismaService)).toBeDefined();
    for (const group of ['analyses', 'importJobs', 'transactions', 'events', 'config', 'retention'] as const) expect(repo[group]).toBeDefined();
    expect(typeof repo.runInTransaction).toBe('function');
  });

  it('resolves PII_CIPHER from a @Global() module as well', async () => {
    const mod = await Test.createTestingModule({ imports: [GlobalCipherModule, BsaPersistenceModule.register()] }).compile();
    expect(mod.get(BSA_REPOSITORY)).toBeInstanceOf(PrismaBsaRepository);
  });

  it('fails fast when no PII_CIPHER is available (PII must never be stored unencrypted)', async () => {
    await expect(Test.createTestingModule({ imports: [BsaPersistenceModule.register()] }).compile()).rejects.toThrow(/PII_CIPHER|Nest can't resolve/);
  });
});
