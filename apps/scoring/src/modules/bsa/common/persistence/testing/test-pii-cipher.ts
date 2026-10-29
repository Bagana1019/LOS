// ЗӨВХӨН ТЕСТЭД: PiiCipher-ийн жинхэнэ шиг хэрэгжүүлэлт (AES-256-GCM, санамсаргүй nonce; hash = HMAC-SHA256). Түлхүүр тест дотроо тогтмол,
// ҮЙЛДВЭРЛЭЛТЭД ХЭЗЭЭ Ч АШИГЛАХГҮЙ — жинхэнэ PII_CIPHER нь common/ дахь тусдаа adapter.
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import type { PiiCipher } from '../../infra.ports';

const TEST_KEY = Buffer.alloc(32, 7);

export class TestPiiCipher implements PiiCipher {
  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', TEST_KEY, iv);
    const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return `t1:${Buffer.concat([iv, c.getAuthTag(), body]).toString('base64')}`;
  }
  decrypt(cipherText: string): string {
    if (!cipherText.startsWith('t1:')) throw new Error('TestPiiCipher: not an encrypted value (plaintext leaked into storage?)');
    const raw = Buffer.from(cipherText.slice(3), 'base64');
    const d = createDecipheriv('aes-256-gcm', TEST_KEY, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  }
  hash(plain: string): string {
    return createHmac('sha256', TEST_KEY).update(plain).digest('hex');
  }
}
