import { describe, expect, it } from 'vitest';
import { MIN_INTERNAL_AUTH_SECRET_LENGTH } from '@los/nest-common';
import { assertDirectoryToken, configuredDirectoryToken } from './directory-token';

// GATEWAY_DIRECTORY_TOKEN: INTERNAL_AUTH_SECRET-тэй ижил дүрэм (production-д ≥16 тэмдэгт, .env.example-ийн загвар биш) + INTERNAL_AUTH_SECRET-тэй ЗӨРҮҮТЭЙ байх ёстой.
const STRONG = 'directory-token-for-tests-0123';
const prod = (extra: Record<string, string | undefined>) => ({ NODE_ENV: 'production', ...extra });

describe('configuredDirectoryToken', () => {
  it('тохируулаагүй / хоосон / зөвхөн хоосон зай → null (хаалттай)', () => {
    expect(configuredDirectoryToken({})).toBeNull();
    expect(configuredDirectoryToken({ GATEWAY_DIRECTORY_TOKEN: '' })).toBeNull();
    expect(configuredDirectoryToken({ GATEWAY_DIRECTORY_TOKEN: '   ' })).toBeNull();
  });

  it('утгыг trim хийж буцаана', () => {
    expect(configuredDirectoryToken({ GATEWAY_DIRECTORY_TOKEN: `  ${STRONG}  ` })).toBe(STRONG);
  });

  it('production бус орчинд сул утга зөвшөөрөгдөнө (dev/test)', () => {
    expect(configuredDirectoryToken({ NODE_ENV: 'development', GATEWAY_DIRECTORY_TOKEN: 'dev-directory-token-change-me' })).toBe('dev-directory-token-change-me');
    expect(configuredDirectoryToken({ NODE_ENV: 'test', GATEWAY_DIRECTORY_TOKEN: 'x' })).toBe('x');
  });

  it('production-д богино / загвар / INTERNAL_AUTH_SECRET-тэй ижил утга → null', () => {
    expect(configuredDirectoryToken(prod({ GATEWAY_DIRECTORY_TOKEN: 'a'.repeat(MIN_INTERNAL_AUTH_SECRET_LENGTH - 1) }))).toBeNull();
    expect(configuredDirectoryToken(prod({ GATEWAY_DIRECTORY_TOKEN: 'dev-directory-token-change-me' }))).toBeNull();
    expect(configuredDirectoryToken(prod({ GATEWAY_DIRECTORY_TOKEN: STRONG, INTERNAL_AUTH_SECRET: STRONG }))).toBeNull();
  });

  it('production-д зөв (урт, загвар биш, тусдаа) утгыг буцаана; яг ≥16 тэмдэгт хүрнэ', () => {
    expect(configuredDirectoryToken(prod({ GATEWAY_DIRECTORY_TOKEN: STRONG, INTERNAL_AUTH_SECRET: 'another-internal-secret-0123' }))).toBe(STRONG);
    const exact = 'k'.repeat(MIN_INTERNAL_AUTH_SECRET_LENGTH);
    expect(configuredDirectoryToken(prod({ GATEWAY_DIRECTORY_TOKEN: exact }))).toBe(exact);
  });
});

describe('assertDirectoryToken (bootstrap)', () => {
  it('production бус орчинд хэзээ ч шидэхгүй', () => {
    expect(() => assertDirectoryToken({ NODE_ENV: 'development', GATEWAY_DIRECTORY_TOKEN: 'x' })).not.toThrow();
    expect(() => assertDirectoryToken({})).not.toThrow();
  });

  it('production-д тохируулаагүй бол эхлэхийг хориглохгүй (лавлах унтарна → 503, экспорт id-тай)', () => {
    expect(() => assertDirectoryToken(prod({}))).not.toThrow();
    expect(() => assertDirectoryToken(prod({ GATEWAY_DIRECTORY_TOKEN: '   ' }))).not.toThrow();
  });

  it('production-д тохируулсан боловч богино бол эхлэхгүй', () => {
    expect(() => assertDirectoryToken(prod({ GATEWAY_DIRECTORY_TOKEN: 'short' }))).toThrow(/GATEWAY_DIRECTORY_TOKEN.*at least 16/);
  });

  it('production-д .env.example-ийн загвар утга бол эхлэхгүй (урт нь хангалттай ч)', () => {
    expect(() => assertDirectoryToken(prod({ GATEWAY_DIRECTORY_TOKEN: 'dev-directory-token-change-me' }))).toThrow(/placeholder/);
  });

  it('production-д INTERNAL_AUTH_SECRET-тэй ижил бол эхлэхгүй (хоёр нууц тусдаа)', () => {
    expect(() => assertDirectoryToken(prod({ GATEWAY_DIRECTORY_TOKEN: STRONG, INTERNAL_AUTH_SECRET: STRONG }))).toThrow(/INTERNAL_AUTH_SECRET/);
  });

  it('production-д зөв утга бол шидэхгүй', () => {
    expect(() => assertDirectoryToken(prod({ GATEWAY_DIRECTORY_TOKEN: STRONG, INTERNAL_AUTH_SECRET: 'another-internal-secret-0123' }))).not.toThrow();
  });
});
