import { describe, expect, it } from 'vitest';
import { generateLinkToken, hashToken, isLinkTokenShape, LINK_TOKEN_LENGTH } from './tokens';

describe('link token', () => {
  it('32 байт → base64url 43 тэмдэгт, padding-гүй', () => {
    const token = generateLinkToken();
    expect(token).toHaveLength(LINK_TOKEN_LENGTH);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('давтагдахгүй (1000 токен)', () => {
    expect(new Set(Array.from({ length: 1000 }, generateLinkToken)).size).toBe(1000);
  });

  it('base64url-ийн 64 тэмдэгт бүгд тохиолдоно (хазайлтгүй санамсаргүй)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) for (const char of generateLinkToken()) seen.add(char);
    expect(seen.size).toBe(64);
  });

  it('isLinkTokenShape: зөв хэлбэрийг л хүлээн авна', () => {
    expect(isLinkTokenShape(generateLinkToken())).toBe(true);
    for (const bad of ['', 'abc', 'A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}=`, `${'A'.repeat(42)}+`, `${'A'.repeat(42)}/`, `${'A'.repeat(42)} `, `${'A'.repeat(42)}Ө`, null, undefined, 42, {}]) {
      expect(isLinkTokenShape(bad)).toBe(false);
    }
  });

  it('hashToken: sha256 hex (тогтмол вектор), токеноос ялгаатай, нэг токен нэг hash', () => {
    expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const token = generateLinkToken();
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toBe(token);
    expect(hashToken(token)).not.toBe(hashToken(generateLinkToken()));
  });
});
