// FR-11.4 Provider-ийн буцаасан гарын үсгийг ШАЛГАХ цэвэр логик (finalization алхам 2). Үр дүнд PII орохгүй: зөвхөн шалтгааны код.
import type { ProviderSignature } from '../../../integrations/esign/esign-provider.port';
import { timingSafeEqualHex } from './digest';
import { registersMatch } from './identity';

/** Provider ба бидний цагийн зөрөө, сүлжээний саатлыг тооцох зөвшөөрөгдөх хэлбэлзэл */
export const CLOCK_SKEW_MS = 2 * 60 * 1000;

export type SignatureVerdict =
  | { ok: true }
  | { ok: false; reason: 'IDENTITY_MISMATCH' | 'INTEGRITY_ERROR'; detail: string };

export interface SignatureCheckInput {
  /** Хүсэлт үүсэх үед тооцсон, provider-д илгээсэн баримтын SHA-256 */
  originalSha256: string;
  /** Хүсэлтэд бүртгэсэн (шифрийг тайлсан) регистр */
  expectedRegisterNo: string;
  /** Зээлдэгч зөвшөөрөл өгсөн мөч; гарын үсэг түүнээс өмнө байж болохгүй */
  consentAt: Date;
  now: Date;
  signature: Pick<ProviderSignature, 'signedDigestHex' | 'digestAlgorithm' | 'signedAt' | 'signatureCms' | 'certificate'>;
}

const fail = (reason: 'IDENTITY_MISMATCH' | 'INTEGRITY_ERROR', detail: string): SignatureVerdict => ({ ok: false, reason, detail });
const isValidDate = (value: Date): boolean => value instanceof Date && !Number.isNaN(value.getTime());

/**
 * Дараалал: (1) digest → (2) гэрчилгээний регистр (IDENTITY_MISMATCH) → (3) гэрчилгээ гарын үсэг зурсан мөчид хүчинтэй эсэх →
 * (4) signedAt үнэмшилтэй эсэх (зөвшөөрлөөс өмнө биш, ирээдүйд биш). Бусад бүх зөрчил INTEGRITY_ERROR.
 */
export function verifyProviderSignature(input: SignatureCheckInput): SignatureVerdict {
  const { signature, now } = input;
  if (signature.digestAlgorithm !== 'SHA-256') return fail('INTEGRITY_ERROR', 'UNSUPPORTED_DIGEST_ALGORITHM');
  if (signature.signatureCms.length === 0) return fail('INTEGRITY_ERROR', 'EMPTY_SIGNATURE');
  if (!timingSafeEqualHex(signature.signedDigestHex, input.originalSha256)) return fail('INTEGRITY_ERROR', 'DIGEST_MISMATCH');
  if (!registersMatch(signature.certificate.subjectRegisterNo, input.expectedRegisterNo)) return fail('IDENTITY_MISMATCH', 'CERTIFICATE_REGISTER_MISMATCH');

  const { notBefore, notAfter } = signature.certificate;
  if (![signature.signedAt, notBefore, notAfter].every(isValidDate)) return fail('INTEGRITY_ERROR', 'INVALID_DATE');
  const signedMs = signature.signedAt.getTime();
  if (signedMs < notBefore.getTime() || signedMs > notAfter.getTime()) return fail('INTEGRITY_ERROR', 'CERTIFICATE_NOT_VALID_AT_SIGNING');
  if (signedMs < input.consentAt.getTime() - CLOCK_SKEW_MS) return fail('INTEGRITY_ERROR', 'SIGNED_BEFORE_CONSENT');
  if (signedMs > now.getTime() + CLOCK_SKEW_MS) return fail('INTEGRITY_ERROR', 'SIGNED_IN_FUTURE');
  return { ok: true };
}
