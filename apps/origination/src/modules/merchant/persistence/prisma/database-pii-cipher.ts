import { createHmac } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { decryptedField, encryptedField } from '@los/database';
import { isProduction, MIN_REAL_SECRET_LENGTH, readIntegrationMode } from '../../config/pos.config';
import { PiiCipher } from '../../ports';

/** DEV ЗОРИУЛАЛТТАЙ — зөвхөн production биш, INTEGRATION_MODE=mock үед (POS_OTP_SECRET-ийн DEV_OTP_SECRET-тэй адил). */
export const DEV_PII_HASH_KEY = 'DEV-ONLY-INSECURE-PII-HASH-KEY--NEVER-USE-IN-PRODUCTION';

/**
 * POS-BR-7 / CLAUDE.md §6.5: регистр, дансны дугаарыг `@los/database`-ийн encryptedField/decryptedField (pgcrypto wrapper)-ээр шифрлэнэ;
 * хайлтын hash нь HMAC-SHA256 (hex), түлхүүр нь env `PII_HASH_KEY`. production эсвэл INTEGRATION_MODE=real үед заавал (анхдагч түлхүүр БАЙХГҮЙ) БА
 * ≥ 16 тэмдэгт (POS_OTP_SECRET-тэй адил): регистр нь бага орон зайтай (2 үсэг + төрсөн огноо бүхий 8 цифр) тул богино түлхүүр DB/DWH dump-аас hash-ийг brute force хийх боломж өгнө.
 * dev/mock-д л DEV түлхүүрээр ажиллаж анхааруулга логлоно (өөр хөгжүүлэгчийн `pnpm dev` env хувьсагчгүйгээр асах ёстой).
 *
 * `encrypt`/`decrypt` нь Module 0-ийн AES-256-GCM (`DATA_ENCRYPTION_KEY[S]`, production-д заавал; NODE_ENV=test-д тогтмол тестийн түлхүүр) — түлхүүр алга бол асуултад биш эхний шифрлэлтэд унана (шифрлэлгүй PII хадгалахгүй).
 */
@Injectable()
export class DatabasePiiCipher extends PiiCipher {
  private readonly hashKey: Buffer;

  constructor() {
    super();
    const key = process.env.PII_HASH_KEY?.trim();
    const strict = isProduction() || readIntegrationMode() === 'real';
    if (key) {
      if (strict && key.length < MIN_REAL_SECRET_LENGTH) {
        throw new Error(`PII_HASH_KEY must be at least ${MIN_REAL_SECRET_LENGTH} characters when NODE_ENV=production or INTEGRATION_MODE=real`);
      }
      this.hashKey = Buffer.from(key, 'utf8');
      return;
    }
    if (strict) {
      throw new Error('PII_HASH_KEY environment variable is required for DatabasePiiCipher (HMAC key for buyer register hash); there is no default key');
    }
    new Logger('DatabasePiiCipher').warn('PII_HASH_KEY is not set — using the DEV-ONLY hash key (never allowed in production / INTEGRATION_MODE=real)');
    this.hashKey = Buffer.from(DEV_PII_HASH_KEY, 'utf8');
  }

  encrypt(plain: string): string {
    return encryptedField(plain);
  }

  decrypt(cipher: string): string {
    return decryptedField(cipher);
  }

  /** HMAC-SHA256 hex. Нормчлол: Unicode NFC, бүх хоосон зайг хасна, том үсэг (регистр "уе12345678" = "УЕ 12345678"). Хайх талд мөн ижил функц. */
  hash(plain: string): string {
    const normalized = plain.normalize('NFC').replace(/\s+/g, '').toUpperCase();
    return createHmac('sha256', this.hashKey).update(normalized, 'utf8').digest('hex');
  }
}
