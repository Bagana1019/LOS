import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { decryptedField, encryptedField } from '@los/database';
import { FatfModule } from '../../integrations/fatf/fatf.module';
import { UnScModule } from '../../integrations/un-sc/un-sc.module';
import { AmlController } from './aml.controller';
import { amlPrismaProvider } from './aml.prisma';
import { AML_CLOCK, AML_IDS, AML_POLICY_PROVIDER, AML_REPOSITORY, PII_CIPHER } from './aml.ports';
import { AmlService } from './aml.service';
import { BlacklistProjectionService } from './blacklist-projection.service';
import { PrismaAmlRepository } from './repository/prisma-aml.repository';
import { StaticAmlPolicyProvider } from './static-policy.provider';
import { WatchlistService } from './watchlist.service';

const AAD = 'aml_check.register_no';

/** Compliance & AML: UN/FATF/дотоод хар жагсаалтын автомат тулгалт (FR-2.5, FR-3.4, BR-9). Дэлгэрэнгүй: docs/05-compliance-aml.md. */
@Module({
  imports: [UnScModule, FatfModule],
  controllers: [AmlController],
  providers: [
    AmlService,
    WatchlistService,
    BlacklistProjectionService,
    amlPrismaProvider,
    { provide: AML_REPOSITORY, useClass: PrismaAmlRepository },
    { provide: AML_POLICY_PROVIDER, useClass: StaticAmlPolicyProvider },
    // AES-256-GCM (@los/database crypto.ts); aad нь шифртекстийг `aml_check.register_no` баганад түгжинэ.
    { provide: PII_CIPHER, useValue: { encrypt: (plain: string) => encryptedField(plain, AAD), decrypt: (c: string) => decryptedField(c, AAD) } },
    { provide: AML_CLOCK, useValue: { now: () => new Date() } },
    { provide: AML_IDS, useValue: { uuid: () => randomUUID() } },
  ],
  exports: [AmlService, BlacklistProjectionService],
})
export class AmlModule {}
