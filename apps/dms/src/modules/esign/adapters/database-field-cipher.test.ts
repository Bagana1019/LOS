import { describe, expect, it } from 'vitest';
import { DatabaseFieldCipher } from './database-field-cipher';

describe('DatabaseFieldCipher', () => {
  const cipher = new DatabaseFieldCipher();

  it('шифрлээд тайлахад анхны утга гарна, шифртекст нь plaintext агуулахгүй', () => {
    const encrypted = cipher.encrypt('УА12345678');
    expect(encrypted).not.toContain('УА12345678');
    expect(cipher.decrypt(encrypted)).toBe('УА12345678');
  });

  it('нэг утгыг хоёр удаа шифрлэхэд өөр шифртекст (random iv)', () => {
    expect(cipher.encrypt('+97699112233')).not.toBe(cipher.encrypt('+97699112233'));
  });

  it('эвдэрсэн шифртекстийг тайлж чадахгүй', () => {
    const encrypted = cipher.encrypt('УА12345678');
    expect(() => cipher.decrypt(`${encrypted.slice(0, -2)}AA`)).toThrow();
  });
});
