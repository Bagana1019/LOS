import { createHash } from 'crypto';
import { PiiCipher } from '../ports';

/**
 * !!! DEMO / TEST ONLY — ХЭЗЭЭ Ч PRODUCTION-Д БИШ !!!
 * Энэ нь шифрлэлт БИШ: base64 кодчилол (буцаж унших боломжтой) + түлхүүргүй sha256 hash.
 * Зөвхөн `persistence: 'memory'` үед холбогдоно (MerchantModule.register). Бодит хэрэгжүүлэлт:
 * `@los/database` encryptedField + HMAC (`PII_HASH_KEY`) — persistence/prisma provider-ээр орно.
 */
export class DemoPiiCipher extends PiiCipher {
  encrypt(plain: string): string {
    return `demo:${Buffer.from(plain, 'utf8').toString('base64')}`;
  }
  decrypt(cipher: string): string {
    if (!cipher.startsWith('demo:')) throw new Error('DemoPiiCipher: unexpected ciphertext');
    return Buffer.from(cipher.slice(5), 'base64').toString('utf8');
  }
  hash(plain: string): string {
    return createHash('sha256').update(plain, 'utf8').digest('hex');
  }
}
