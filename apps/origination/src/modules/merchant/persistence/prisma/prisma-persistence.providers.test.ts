import { afterEach, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { PiiCipher } from '../../ports';
import { LeaseRepository, MerchantRepository, OtpRepository, PlanRepository } from '../repositories';
import { DatabasePiiCipher } from './database-pii-cipher';
import { PrismaLeaseRepository } from './prisma-lease.repository';
import { PrismaMerchantRepository } from './prisma-merchant.repository';
import { PrismaOtpRepository } from './prisma-otp.repository';
import { prismaPersistenceProviders } from './prisma-persistence.providers';
import { PrismaPlanRepository } from './prisma-plan.repository';
import { PrismaService } from './prisma.service';

// DI wiring: backend-core модуль `prismaPersistenceProviders`-ийг тарихад бүх abstract token бодит класстай холбогдох ёстой (DB холболтгүйгээр).
describe('prismaPersistenceProviders', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('wires every abstract repository token and the PII cipher', async () => {
    vi.stubEnv('PII_HASH_KEY', 'unit-test-hmac-key');
    const moduleRef = await Test.createTestingModule({ providers: [{ provide: PrismaService, useValue: {} }, ...prismaPersistenceProviders] }).compile();
    expect(moduleRef.get(MerchantRepository)).toBeInstanceOf(PrismaMerchantRepository);
    expect(moduleRef.get(PlanRepository)).toBeInstanceOf(PrismaPlanRepository);
    expect(moduleRef.get(LeaseRepository)).toBeInstanceOf(PrismaLeaseRepository);
    expect(moduleRef.get(OtpRepository)).toBeInstanceOf(PrismaOtpRepository);
    expect(moduleRef.get(PiiCipher)).toBeInstanceOf(DatabasePiiCipher);
    await moduleRef.close();
  });

  it('fails fast at bootstrap when PII_HASH_KEY is missing in real/production mode', async () => {
    vi.stubEnv('PII_HASH_KEY', '');
    vi.stubEnv('INTEGRATION_MODE', 'real');
    await expect(Test.createTestingModule({ providers: [{ provide: PrismaService, useValue: {} }, ...prismaPersistenceProviders] }).compile()).rejects.toThrow(/PII_HASH_KEY/);
  });
});
