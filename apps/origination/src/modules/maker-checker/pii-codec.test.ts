import { describe, expect, it } from 'vitest';
import { isEncryptedField } from '@los/database';
import { encryptedJsonCodec } from './pii-codec';

const ref = { orgId: 'org1', targetType: 'CUSTOMER', targetId: 'c-1' };
const value = { changes: { phone: '88001122', email: 'бат@example.mn 🙂' }, cleared: ['clanName'] };

describe('encryptedJsonCodec (PII in immutable change_request rows)', () => {
  it('seals to AES-GCM ciphertext plus a PII-free summary; no plaintext anywhere in the stored JSON', () => {
    const codec = encryptedJsonCodec((v) => ({ fields: Object.keys((v as typeof value).changes) }));
    const stored = codec.seal(value, ref) as { sealed: string; summary: unknown };
    expect(isEncryptedField(stored.sealed)).toBe(true);
    expect(stored.summary).toEqual({ fields: ['phone', 'email'] });
    expect(JSON.stringify(stored)).not.toMatch(/88001122|example/);
  });

  it('round-trips Unicode and emoji exactly', () => {
    const codec = encryptedJsonCodec();
    expect(codec.unseal(codec.seal(value, ref), ref)).toEqual(value);
  });

  it('two seals of the same value differ (random IV)', () => {
    const codec = encryptedJsonCodec();
    expect((codec.seal(value, ref) as { sealed: string }).sealed).not.toBe((codec.seal(value, ref) as { sealed: string }).sealed);
  });

  it('ciphertext is bound to its target: unsealing under another target or org throws', () => {
    const codec = encryptedJsonCodec();
    const stored = codec.seal(value, ref);
    expect(() => codec.unseal(stored, { ...ref, targetId: 'c-2' })).toThrow();
    expect(() => codec.unseal(stored, { ...ref, orgId: 'org2' })).toThrow();
  });

  it('rejects stored values that are not a sealed envelope (plaintext, null, tampered)', () => {
    const codec = encryptedJsonCodec();
    expect(() => codec.unseal(value, ref)).toThrow();
    expect(() => codec.unseal(null, ref)).toThrow();
    const stored = codec.seal(value, ref) as { sealed: string };
    expect(() => codec.unseal({ ...stored, sealed: `${stored.sealed.slice(0, -2)}AA` }, ref)).toThrow();
  });
});
