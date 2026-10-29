import { describe, expect, it } from 'vitest';
import {
  CROCKFORD_ALPHABET, formatVerificationCode, generateVerificationCode, isVerificationCode, parseVerificationCode, VERIFICATION_CODE_LENGTH,
} from './verification-code';

describe('verification code', () => {
  it('Crockford base32 ханд I, L, O, U байхгүй, 32 тэмдэгт', () => {
    expect(CROCKFORD_ALPHABET).toHaveLength(32);
    expect(new Set(CROCKFORD_ALPHABET).size).toBe(32);
    for (const banned of 'ILOU') expect(CROCKFORD_ALPHABET).not.toContain(banned);
  });

  it('12 тэмдэгт, зөвхөн хандаас; давтагдахгүй', () => {
    const codes = Array.from({ length: 2000 }, generateVerificationCode);
    for (const code of codes) {
      expect(code).toHaveLength(VERIFICATION_CODE_LENGTH);
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/);
      expect(isVerificationCode(code)).toBe(true);
    }
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('32 тэмдэгт бүгд тохиолдоно ба хуваарилалт ойролцоогоор жигд (modulo bias байхгүй)', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 3000; i++) for (const char of generateVerificationCode()) counts.set(char, (counts.get(char) ?? 0) + 1);
    expect(counts.size).toBe(32);
    const expected = (3000 * 12) / 32; // 1125
    for (const count of counts.values()) expect(Math.abs(count - expected)).toBeLessThan(expected * 0.2);
  });

  it('format: XXXX-XXXX-XXXX; хэлбэр буруу бол TypeError', () => {
    expect(formatVerificationCode('7K3QXM9ZB4TN')).toBe('7K3Q-XM9Z-B4TN');
    for (const bad of ['', '7K3QXM9ZB4T', '7K3QXM9ZB4TNN', '7k3qxm9zb4tn', '7K3QXM9ZB4TI', '7K3Q-XM9Z-B4TN']) {
      expect(() => formatVerificationCode(bad)).toThrow(TypeError);
    }
  });

  it('parse: бүлэглэсэн, бүлэглээгүй, жижиг үсэг, зайтай хэлбэрийг хадгалсан (ungrouped, том үсэг) хэлбэрт буцаана', () => {
    for (const input of ['7K3QXM9ZB4TN', '7K3Q-XM9Z-B4TN', '7k3q-xm9z-b4tn', ' 7K3Q XM9Z B4TN ', '7K3Q-XM9ZB4TN', '\t7k3qxm9zb4tn\n']) {
      expect(parseVerificationCode(input)).toBe('7K3QXM9ZB4TN');
    }
  });

  it('parse: Crockford-ын андуурагдах тэмдэгтүүд O→0, I/L→1', () => {
    expect(parseVerificationCode('O0IL7K3QXM9Z')).toBe('00117K3QXM9Z');
    expect(parseVerificationCode('o0il7k3qxm9z')).toBe('00117K3QXM9Z');
  });

  it('parse: U, буруу урт, тэмдэгт, төрөл, хэт урт оролт → null', () => {
    for (const bad of ['', '7K3QXM9ZB4T', '7K3QXM9ZB4TNN', '7K3QXM9ZB4TU', '7K3Q-XM9Z-B4T!', '7K3Q/XM9Z/B4TN', 'A'.repeat(65), null, undefined, 123456789012, {}]) {
      expect(parseVerificationCode(bad)).toBeNull();
    }
  });

  it('parse(format(code)) === code', () => {
    for (let i = 0; i < 100; i++) {
      const code = generateVerificationCode();
      expect(parseVerificationCode(formatVerificationCode(code))).toBe(code);
    }
  });

  it('isVerificationCode: бүлэглэсэн/жижиг үсэгтэй хэлбэрийг хүлээн авахгүй (хадгалсан хэлбэр л)', () => {
    expect(isVerificationCode('7K3Q-XM9Z-B4TN')).toBe(false);
    expect(isVerificationCode('7k3qxm9zb4tn')).toBe(false);
    expect(isVerificationCode(undefined)).toBe(false);
  });
});
