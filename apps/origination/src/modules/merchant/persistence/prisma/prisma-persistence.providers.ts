import type { Provider } from '@nestjs/common';
import { PiiCipher } from '../../ports';
import { LeaseRepository, MerchantRepository, OtpRepository, PlanRepository } from '../repositories';
import { DatabasePiiCipher } from './database-pii-cipher';
import { PrismaLeaseRepository } from './prisma-lease.repository';
import { PrismaMerchantRepository } from './prisma-merchant.repository';
import { PrismaOtpRepository } from './prisma-otp.repository';
import { PrismaPlanRepository } from './prisma-plan.repository';

/** Бодит Postgres persistence: 4 abstract repository (DI token) + PiiCipher. PrismaService-ийг Module 0-ийн глобал PrismaModule (src/prisma.service.ts) өгнө. */
export const prismaPersistenceProviders: Provider[] = [
  { provide: MerchantRepository, useClass: PrismaMerchantRepository },
  { provide: PlanRepository, useClass: PrismaPlanRepository },
  { provide: LeaseRepository, useClass: PrismaLeaseRepository },
  { provide: OtpRepository, useClass: PrismaOtpRepository },
  { provide: PiiCipher, useClass: DatabasePiiCipher },
];
