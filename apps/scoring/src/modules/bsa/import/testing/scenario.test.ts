import { describe, expect, it } from 'vitest';
import { withoutCiphertext } from './scenario';

// Regression: main CI f0df864 — 'ZXQ' canary matched inside random ciphertext ("…LhxiZXQ9yUS3…") of a row_to_json dump.
const CIPHERTEXT = 't1:aUYennSkMNLhxiZXQ9yUS3ORtRRnvJsDzG';

describe('withoutCiphertext', () => {
  it('drops *_encrypted values so a short canary cannot collide with random ciphertext', () => {
    const dump = `{"id":"a","description_encrypted":"${CIPHERTEXT}","counterparty_name_encrypted":"t1:Zm9v"}`;
    expect(dump).toContain('ZXQ');
    expect(withoutCiphertext(dump)).not.toContain('ZXQ');
  });

  it('keeps plaintext columns, so a genuine leak of a short canary is still caught', () => {
    const dump = `{"description_encrypted":"${CIPHERTEXT}","note":"ZXQ-S04 leaked","detail":{"holder_name_encrypted":"t1:abc","raw":"Bold"}}`;
    const stripped = withoutCiphertext(dump);
    expect(stripped).toContain('ZXQ-S04');
    expect(stripped).toContain('Bold');
    expect(stripped).not.toContain('t1:');
  });

  it('leaves null encrypted values and unrelated keys untouched', () => {
    const dump = '{"iban_encrypted":null,"encrypted_at":"2026-11-19","status":"IMPORT_COMPLETED"}';
    expect(withoutCiphertext(dump)).toBe(dump);
  });
});
