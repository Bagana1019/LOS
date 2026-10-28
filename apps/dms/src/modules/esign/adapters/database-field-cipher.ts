// SensitiveFieldCipher-ийг @los/database-ийн `encryptedField` (AES-256-GCM, DATA_ENCRYPTION_KEY) дээр хэрэгжүүлнэ — CLAUDE.md §6.5.
// aad нь шифртекстийг энэ хүснэгтэд түгжинэ: өөр баганын утгыг энд тайлах боломжгүй.
import { Injectable } from '@nestjs/common';
import { decryptedField, encryptedField } from '@los/database';
import type { SensitiveFieldCipher } from '../ports/field-cipher.port';

const AAD = 'dms.signing_request';

@Injectable()
export class DatabaseFieldCipher implements SensitiveFieldCipher {
  encrypt(plain: string): string { return encryptedField(plain, AAD); }
  decrypt(cipher: string): string { return decryptedField(cipher, AAD); }
}
