import { randomInt, randomUUID } from 'crypto';
import { IdGenerator } from '../ports';

/** Crockford base32: төөрөгдөх тэмдэггүй (I, L, O, U байхгүй). */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export class CryptoIdGenerator extends IdGenerator {
  uuid(): string {
    return randomUUID();
  }
  leaseSuffix(): string {
    let s = '';
    for (let i = 0; i < 6; i++) s += CROCKFORD_ALPHABET[randomInt(CROCKFORD_ALPHABET.length)];
    return s;
  }
}
