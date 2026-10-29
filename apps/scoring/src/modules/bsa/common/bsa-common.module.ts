// BSA-ийн дэд бүтцийн adapter-уудыг port token-уудаар нийлүүлэх global Nest модуль (infra.ports.ts).
// Тохиргоо = process.env (ConfigService-гүй `createX(env)` функцүүд), provider үүсэхэд л уншина → буруу тохиргоо app асахад шууд унана.
// repository (BSA_REPOSITORY) энд БАЙХГҮЙ — common/persistence модулийнх.
// Тестэд: Test.createTestingModule({ imports: [BsaCommonModule] }).overrideProvider(PII_CIPHER).useValue(...) гэх мэтээр солино.
import { Global, Module } from '@nestjs/common';
import { createPiiCipher, type ByteCipher } from './pii-cipher';
import { createObjectStore } from './object-store';
import { PrismaEventPublisher } from './event-publisher';
import { createImportQueue } from './import-queue';
import { createBsaSettingsProvider } from './settings';
import { BSA_SETTINGS, EVENT_PUBLISHER, IMPORT_QUEUE, OBJECT_STORE, PII_CIPHER, type PiiCipher } from './infra.ports';

const isByteCipher = (c: PiiCipher): c is PiiCipher & ByteCipher =>
  typeof (c as Partial<ByteCipher>).encryptBytes === 'function' && typeof (c as Partial<ByteCipher>).decryptBytes === 'function';

@Global()
@Module({
  providers: [
    { provide: PII_CIPHER, useFactory: () => createPiiCipher(process.env) },
    {
      provide: OBJECT_STORE,
      // PII_CIPHER-тэй ижил түлхүүрээр файлыг шифрлэнэ. Тест PII_CIPHER-ийг bytes шифрлэхгүй хувилбараар солисон бол env-ээс шийднэ
      useFactory: (cipher: PiiCipher) => createObjectStore(process.env, { cipher: isByteCipher(cipher) ? cipher : undefined }),
      inject: [PII_CIPHER],
    },
    { provide: EVENT_PUBLISHER, useFactory: () => new PrismaEventPublisher() },
    // Redis холболт анхны enqueue()/start() дээр л үүснэ. Nest shutdown-д onModuleDestroy → close()
    { provide: IMPORT_QUEUE, useFactory: () => createImportQueue(process.env) },
    { provide: BSA_SETTINGS, useFactory: () => createBsaSettingsProvider(process.env) },
  ],
  exports: [PII_CIPHER, OBJECT_STORE, EVENT_PUBLISHER, IMPORT_QUEUE, BSA_SETTINGS],
})
export class BsaCommonModule {}
