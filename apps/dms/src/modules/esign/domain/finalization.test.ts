import { describe, expect, it } from 'vitest';
import type { ProviderSignature } from '../../../integrations/esign/esign-provider.port';
import { CLOCK_SKEW_MS, verifyProviderSignature, type SignatureCheckInput } from './finalization';
import { sha256Hex } from './digest';

const NOW = new Date('2026-10-28T03:10:00.000Z');
const CONSENT_AT = new Date('2026-10-28T03:05:00.000Z');
const SIGNED_AT = new Date('2026-10-28T03:07:00.000Z');
const ORIGINAL = sha256Hex('contract bytes');

function input(overrides: { signature?: Partial<ProviderSignature>; certificate?: Partial<ProviderSignature['certificate']> } & Partial<Omit<SignatureCheckInput, 'signature'>> = {}): SignatureCheckInput {
  const { signature, certificate, ...rest } = overrides;
  return {
    originalSha256: ORIGINAL,
    expectedRegisterNo: 'УА12345678',
    consentAt: CONSENT_AT,
    now: NOW,
    signature: {
      signedDigestHex: ORIGINAL,
      digestAlgorithm: 'SHA-256',
      signedAt: SIGNED_AT,
      signatureCms: Buffer.from('cms'),
      certificate: {
        subjectName: 'Бат-Эрдэнэ Болд',
        subjectRegisterNo: 'УА12345678',
        issuer: 'CA',
        serialNumber: '01',
        notBefore: new Date('2026-01-01T00:00:00Z'),
        notAfter: new Date('2027-01-01T00:00:00Z'),
        ...certificate,
      },
      ...signature,
    },
    ...rest,
  };
}

const fail = (reason: string, detail: string) => ({ ok: false, reason, detail });

describe('verifyProviderSignature', () => {
  it('бүгд зөв бол ok', () => {
    expect(verifyProviderSignature(input())).toEqual({ ok: true });
  });

  it('digest зөрөх → INTEGRITY_ERROR(DIGEST_MISMATCH); том/жижиг hex-ийг ялгахгүй', () => {
    expect(verifyProviderSignature(input({ signature: { signedDigestHex: sha256Hex('other') } }))).toEqual(fail('INTEGRITY_ERROR', 'DIGEST_MISMATCH'));
    expect(verifyProviderSignature(input({ signature: { signedDigestHex: ORIGINAL.toUpperCase() } }))).toEqual({ ok: true });
    expect(verifyProviderSignature(input({ signature: { signedDigestHex: '' } }))).toEqual(fail('INTEGRITY_ERROR', 'DIGEST_MISMATCH'));
  });

  it('digest алгоритм SHA-256 биш бол татгалзана', () => {
    expect(verifyProviderSignature(input({ signature: { digestAlgorithm: 'SHA-1' as 'SHA-256' } }))).toEqual(fail('INTEGRITY_ERROR', 'UNSUPPORTED_DIGEST_ALGORITHM'));
  });

  it('хоосон CMS → INTEGRITY_ERROR', () => {
    expect(verifyProviderSignature(input({ signature: { signatureCms: Buffer.alloc(0) } }))).toEqual(fail('INTEGRITY_ERROR', 'EMPTY_SIGNATURE'));
  });

  it('гэрчилгээний регистр зөрөх → IDENTITY_MISMATCH', () => {
    expect(verifyProviderSignature(input({ certificate: { subjectRegisterNo: 'УА12345679' } }))).toEqual(fail('IDENTITY_MISMATCH', 'CERTIFICATE_REGISTER_MISMATCH'));
    expect(verifyProviderSignature(input({ certificate: { subjectRegisterNo: '' } }))).toEqual(fail('IDENTITY_MISMATCH', 'CERTIFICATE_REGISTER_MISMATCH'));
  });

  it('регистрийг нормчилж тулгана: латин look-alike, жижиг үсэг, зай', () => {
    expect(verifyProviderSignature(input({ certificate: { subjectRegisterNo: ' ya-12345678 ' } }))).toEqual({ ok: true });
    expect(verifyProviderSignature(input({ expectedRegisterNo: 'ya12345678', certificate: { subjectRegisterNo: 'УА 12345678' } }))).toEqual({ ok: true });
  });

  it('digest ба регистр хоёул зөрвөл digest (INTEGRITY_ERROR) түрүүлнэ', () => {
    const result = verifyProviderSignature(input({ signature: { signedDigestHex: sha256Hex('other') }, certificate: { subjectRegisterNo: 'ХХ00000000' } }));
    expect(result).toEqual(fail('INTEGRITY_ERROR', 'DIGEST_MISMATCH'));
  });

  describe('гэрчилгээний хүчинтэй хугацаа (гарын үсэг зурсан мөчид)', () => {
    it('хилийн утга хүртэл хүчинтэй', () => {
      expect(verifyProviderSignature(input({ certificate: { notBefore: SIGNED_AT } }))).toEqual({ ok: true });
      expect(verifyProviderSignature(input({ certificate: { notAfter: SIGNED_AT } }))).toEqual({ ok: true });
    });

    it('1 мс өмнө/хойно хүчингүй', () => {
      expect(verifyProviderSignature(input({ certificate: { notBefore: new Date(SIGNED_AT.getTime() + 1) } }))).toEqual(fail('INTEGRITY_ERROR', 'CERTIFICATE_NOT_VALID_AT_SIGNING'));
      expect(verifyProviderSignature(input({ certificate: { notAfter: new Date(SIGNED_AT.getTime() - 1) } }))).toEqual(fail('INTEGRITY_ERROR', 'CERTIFICATE_NOT_VALID_AT_SIGNING'));
    });

    it('одоогийн цаг биш, гарын үсэг зурсан мөчөөр шалгана (гэрчилгээ дараа нь дууссан ч хүчинтэй)', () => {
      const later = new Date(SIGNED_AT.getTime() + 60_000);
      expect(verifyProviderSignature(input({ now: new Date('2030-01-01T00:00:00Z'), certificate: { notAfter: later } }))).toEqual({ ok: true });
    });
  });

  describe('signedAt үнэмшил', () => {
    it('зөвшөөрлөөс өмнө хэлбэлзлээс илүү → SIGNED_BEFORE_CONSENT; хилийн утга хүртэл зөвшөөрнө', () => {
      const edge = new Date(CONSENT_AT.getTime() - CLOCK_SKEW_MS);
      expect(verifyProviderSignature(input({ signature: { signedAt: edge } }))).toEqual({ ok: true });
      expect(verifyProviderSignature(input({ signature: { signedAt: new Date(edge.getTime() - 1) } }))).toEqual(fail('INTEGRITY_ERROR', 'SIGNED_BEFORE_CONSENT'));
    });

    it('ирээдүйд хэлбэлзлээс илүү → SIGNED_IN_FUTURE; хилийн утга хүртэл зөвшөөрнө', () => {
      const edge = new Date(NOW.getTime() + CLOCK_SKEW_MS);
      expect(verifyProviderSignature(input({ signature: { signedAt: edge } }))).toEqual({ ok: true });
      expect(verifyProviderSignature(input({ signature: { signedAt: new Date(edge.getTime() + 1) } }))).toEqual(fail('INTEGRITY_ERROR', 'SIGNED_IN_FUTURE'));
    });

    it('хүчингүй огноо (NaN) → INVALID_DATE', () => {
      expect(verifyProviderSignature(input({ signature: { signedAt: new Date('nope') } }))).toEqual(fail('INTEGRITY_ERROR', 'INVALID_DATE'));
      expect(verifyProviderSignature(input({ certificate: { notAfter: new Date('nope') } }))).toEqual(fail('INTEGRITY_ERROR', 'INVALID_DATE'));
    });
  });

  it('үр дүнд регистр, нэр орохгүй', () => {
    const result = verifyProviderSignature(input({ certificate: { subjectRegisterNo: 'ХХ00000000' } }));
    expect(JSON.stringify(result)).not.toMatch(/ХХ0000|УА1234|Бат/);
  });

  it('CLOCK_SKEW_MS нь 2 минут', () => {
    expect(CLOCK_SKEW_MS).toBe(120_000);
  });
});
