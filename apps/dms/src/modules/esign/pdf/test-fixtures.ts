// FR-11.4 pdf/ дотрох тестүүдийн нийтлэг StampInput fixture (production-д ашиглагдахгүй).
import { createHash } from 'node:crypto';
import type { StampInput } from '../ports/pdf-stamper.port';

export const SIGNED_AT = new Date('2026-10-28T03:15:42.000Z');
export const VERIFICATION_CODE = '7K3QXM9ZB4TN';
export const GROUPED_CODE = '7K3Q-XM9Z-B4TN';
export const VERIFY_URL = `http://localhost:3000/verify/${VERIFICATION_CODE}`;
export const CMS_BYTES = Buffer.from([0x4d, 0x4f, 0x43, 0x4b, 0x2d, 0x43, 0x4d, 0x53, 0x00, 0xff, 0x80, 0x01, 0x02, 0x7f]);

export function sampleStampInput(pdf: Buffer, overrides: Partial<StampInput> = {}): StampInput {
  return {
    pdf,
    contractNo: 'ГЭР-2026-000123',
    signerName: 'Бат-Эрдэнэ Болд',
    signerRegisterMasked: 'УА****5678',
    provider: 'TRIDUM',
    providerDisplayName: 'Tridum',
    certificate: {
      subjectName: 'Бат-Эрдэнэ Болд',
      subjectRegisterNo: 'УА12345678',
      issuer: 'LOS MOCK CA (ТЕСТ)',
      serialNumber: '4A:3F:00:9C:11:7E:22:B5',
      notBefore: new Date('2026-01-01T00:00:00Z'),
      notAfter: new Date('2028-01-01T00:00:00Z'),
    },
    signedAt: SIGNED_AT,
    originalSha256: createHash('sha256').update(pdf).digest('hex'),
    signatureCms: CMS_BYTES,
    verificationCode: VERIFICATION_CODE,
    verifyUrl: VERIFY_URL,
    mock: true,
    ...overrides,
  };
}
