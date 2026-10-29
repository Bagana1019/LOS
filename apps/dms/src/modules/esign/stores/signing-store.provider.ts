// SIGNING_STORE: PostgreSQL (dms schema). Тестэд MemorySigningStore-ыг `overrideProvider(SIGNING_STORE)`-ээр солино.
import type { FactoryProvider } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../integrations/esign/esign-provider.port';
import { PrismaService } from '../../../prisma.service';
import { FIELD_CIPHER, type SensitiveFieldCipher } from '../ports/field-cipher.port';
import { SIGNING_STORE, type SigningStore } from '../ports/signing.store';
import { PrismaSigningStore } from './prisma-signing.store';

export const signingStoreProvider: FactoryProvider<SigningStore> = {
  provide: SIGNING_STORE,
  inject: [PrismaService, CLOCK, FIELD_CIPHER],
  useFactory: (prisma: PrismaService, clock: Clock, cipher: SensitiveFieldCipher) => new PrismaSigningStore(prisma, clock, cipher),
};
