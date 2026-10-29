// PrismaSigningStore-ийн мөр ↔ SigningRequestRecord хөрвүүлэлт. Гэрчилгээний регистр (subjectRegisterNo) нь PII тул Json-д ШИФРЛЭГДЭЖ хадгалагдана.
import { Prisma, type SigningRequest as SigningRequestRow } from '.prisma/client-dms';
import type { ESignProvider, SigningFailureReason, SigningStatus } from '@los/contracts';
import { z } from 'zod';
import type { SignerCertificate } from '../../../integrations/esign/esign-provider.port';
import type { SensitiveFieldCipher } from '../ports/field-cipher.port';
import type { SigningRequestRecord } from '../ports/signing.store';

const storedCertificate = z.object({
  subjectName: z.string(),
  subjectRegisterNo: z.string(),
  issuer: z.string(),
  serialNumber: z.string(),
  notBefore: z.string().datetime(),
  notAfter: z.string().datetime(),
});

export function encodeCertificate(certificate: SignerCertificate, cipher: SensitiveFieldCipher): Prisma.InputJsonObject {
  return {
    subjectName: certificate.subjectName,
    subjectRegisterNo: cipher.encrypt(certificate.subjectRegisterNo),
    issuer: certificate.issuer,
    serialNumber: certificate.serialNumber,
    notBefore: certificate.notBefore.toISOString(),
    notAfter: certificate.notAfter.toISOString(),
  };
}

export function decodeCertificate(json: Prisma.JsonValue, cipher: SensitiveFieldCipher): SignerCertificate {
  const parsed = storedCertificate.safeParse(json);
  // Алдааны мессежид JSON-ий агуулгыг оруулахгүй
  if (!parsed.success) throw new Error('signing_request.certificate has an unexpected shape');
  return {
    subjectName: parsed.data.subjectName,
    subjectRegisterNo: cipher.decrypt(parsed.data.subjectRegisterNo),
    issuer: parsed.data.issuer,
    serialNumber: parsed.data.serialNumber,
    notBefore: new Date(parsed.data.notBefore),
    notAfter: new Date(parsed.data.notAfter),
  };
}

/** Record-ийн (хэсэгчилсэн) талбаруудыг DB-ийн баганад. Prisma: `undefined` = өөрчлөхгүй, `null` = NULL болгоно */
export function toColumns(fields: Partial<SigningRequestRecord>, cipher: SensitiveFieldCipher): Prisma.SigningRequestUncheckedUpdateManyInput {
  const { signerRegisterEnc, signerPhoneEnc, certificate, ...same } = fields;
  const columns: Prisma.SigningRequestUncheckedUpdateManyInput = { ...same };
  if (signerRegisterEnc !== undefined) columns.signerRegisterEncrypted = signerRegisterEnc;
  if (signerPhoneEnc !== undefined) columns.signerPhoneEncrypted = signerPhoneEnc;
  if (certificate !== undefined) columns.certificate = certificate === null ? Prisma.DbNull : encodeCertificate(certificate, cipher);
  return columns;
}

export function toRecord(row: SigningRequestRow, cipher: SensitiveFieldCipher): SigningRequestRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    applicationId: row.applicationId,
    contractId: row.contractId,
    contractNo: row.contractNo,
    // status/provider/failure_reason-ийн утгыг миграцийн CHECK constraint баталгаажуулдаг
    status: row.status as SigningStatus,
    provider: row.provider as ESignProvider | null,
    providerRef: row.providerRef,
    challengeCode: row.challengeCode,
    deepLink: row.deepLink,
    sessionExpiresAt: row.sessionExpiresAt,
    sourceFileId: row.sourceFileId,
    signedFileId: row.signedFileId,
    signatureFileId: row.signatureFileId,
    originalSha256: row.originalSha256,
    signedSha256: row.signedSha256,
    signerCustomerId: row.signerCustomerId,
    signerName: row.signerName,
    signerRegisterEnc: row.signerRegisterEncrypted,
    signerPhoneEnc: row.signerPhoneEncrypted,
    signerRegisterMasked: row.signerRegisterMasked,
    signerPhoneMasked: row.signerPhoneMasked,
    tokenHash: row.tokenHash,
    linkExpiresAt: row.linkExpiresAt,
    verificationCode: row.verificationCode,
    documentViewedAt: row.documentViewedAt,
    consentAt: row.consentAt,
    attempts: row.attempts,
    certificate: row.certificate === null ? null : decodeCertificate(row.certificate, cipher),
    providerTxnId: row.providerTxnId,
    providerMock: row.providerMock,
    failureReason: row.failureReason as SigningFailureReason | null,
    failureDetail: row.failureDetail,
    correlationId: row.correlationId,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    signedAt: row.signedAt,
  };
}

/** JSON-д хөрвүүлж (Date → ISO, undefined хасагдана) Prisma-ийн Json төрөл болгоно */
export function toJsonObject(value: object): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
}
