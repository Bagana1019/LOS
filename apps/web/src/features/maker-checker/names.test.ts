import { describe, expect, it } from 'vitest';
import { isUuid, resolveName } from './names';

// F8-3: илгээгч, салбар UUID-аар биш нэрээр. Нэр олдохгүй бол UUID хоёрдогч текст хэвээр.
describe('resolveName', () => {
  const users = { u1: 'Бат-Эрдэнэ', blank: '   ' };

  it('returns the trimmed name of a known id', () => {
    expect(resolveName(users, 'u1')).toBe('Бат-Эрдэнэ');
  });

  it('returns null for an unknown id, a blank name, or a directory that is not loaded', () => {
    expect(resolveName(users, 'zzz')).toBeNull();
    expect(resolveName(users, 'blank')).toBeNull();
    expect(resolveName(undefined, 'u1')).toBeNull();
  });

  it('never resolves inherited object keys', () => {
    expect(resolveName(users, 'constructor')).toBeNull();
    expect(resolveName(users, '__proto__')).toBeNull();
    expect(resolveName(users, 'toString')).toBeNull();
  });
});

describe('isUuid', () => {
  it('detects UUIDs (any case) and nothing else', () => {
    expect(isUuid('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(isUuid('ABCDEF12-1111-4111-8111-111111111111')).toBe(true);
    expect(isUuid('blacklist.grey_valid_months')).toBe(false);
    expect(isUuid('CONSUMER')).toBe(false);
    expect(isUuid('')).toBe(false);
  });
});
