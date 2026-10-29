import { type MiddlewareConsumer, Module, type NestModule, RequestMethod } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { decryptedField, encryptedField } from '@los/database';
import { BlacklistController } from './blacklist.controller';
import { BlacklistLookupService } from './blacklist-lookup.service';
import { blacklistPrismaProvider } from './blacklist.prisma';
import { BLACKLIST_REPOSITORY } from './blacklist.repository';
import { BlacklistService } from './blacklist.service';
import { BLACKLIST_CLOCK, BLACKLIST_IDS, PII_CIPHER, type Clock, type IdGenerator, type PiiCipher } from './blacklist.tokens';
import { csvBodyMiddleware } from './csv-body.middleware';
import { PrismaBlacklistRepository } from './prisma-blacklist.repository';

// AES-256-GCM (@los/database crypto.ts); aad нь шифртекстийг `blacklist.register_no` баганад түгжинэ.
const AAD = 'blacklist.register_no';
const cipher: PiiCipher = { encrypt: (plain) => encryptedField(plain, AAD), decrypt: (c) => decryptedField(c, AAD) };
const clock: Clock = { now: () => new Date() };
const ids: IdGenerator = { uuid: randomUUID };

/** Дотоод хар жагсаалт (FR-13.1, BR-9). Эзэмшигч origination; kyc нь BlacklistEntryChanged event-ээр projection хөтлөнө. Хайлтыг (`BlacklistLookupService`) CustomerModule ашиглана. */
@Module({
  controllers: [BlacklistController],
  providers: [
    BlacklistService,
    BlacklistLookupService,
    blacklistPrismaProvider,
    { provide: BLACKLIST_REPOSITORY, useClass: PrismaBlacklistRepository },
    { provide: PII_CIPHER, useValue: cipher },
    { provide: BLACKLIST_CLOCK, useValue: clock },
    { provide: BLACKLIST_IDS, useValue: ids },
  ],
  exports: [BlacklistLookupService],
})
export class BlacklistModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(csvBodyMiddleware).forRoutes({ path: 'blacklist/import', method: RequestMethod.POST });
  }
}
