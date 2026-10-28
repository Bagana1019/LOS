// EsignModule-д шууд оруулах provider-ууд. `signingFilesProvider` нь PrismaService + OBJECT_STORAGE-ийг (FileModule экспортолно) inject хийнэ.
import type { ClassProvider } from '@nestjs/common';
import { DatabaseFieldCipher } from './database-field-cipher';
import { PrismaSigningFiles } from './prisma-signing-files';
import { FIELD_CIPHER, type SensitiveFieldCipher } from '../ports/field-cipher.port';
import { SIGNING_FILES, type SigningFiles } from '../ports/signing-files.port';

export const fieldCipherProvider: ClassProvider<SensitiveFieldCipher> = { provide: FIELD_CIPHER, useClass: DatabaseFieldCipher };
export const signingFilesProvider: ClassProvider<SigningFiles> = { provide: SIGNING_FILES, useClass: PrismaSigningFiles };
