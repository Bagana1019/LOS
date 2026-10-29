// Гарын үсэг зурагдсан PDF-д QR + гарын үсгийн штамп зурах port. Гүйцэтгэл: pdf/pdf-lib-stamper.ts
import type { ESignProvider } from '@los/contracts';
import type { SignerCertificate } from '../../../integrations/esign/esign-provider.port';

export interface StampInput {
  pdf: Buffer;
  contractNo: string;
  signerName: string;
  /** Далдалсан регистр, жишээ `УА****5678` */
  signerRegisterMasked: string;
  provider: ESignProvider;
  providerDisplayName: string;
  certificate: SignerCertificate;
  signedAt: Date;
  originalSha256: string;
  /** Provider-ийн CMS гарын үсэг — PDF-д `signature.p7s` хавсралт болгон шингээнэ */
  signatureCms: Buffer;
  verificationCode: string;
  /** QR-д кодлох бүтэн URL (`<ESIGN_PUBLIC_BASE_URL>/verify/<code>`) */
  verifyUrl: string;
  /** true бол хуудас бүрт "ТЕСТ — ХҮЧИНГҮЙ" ус тэмдэг */
  mock: boolean;
}
export interface PdfStamper { stamp(input: StampInput): Promise<Buffer> }
export class InvalidPdfError extends Error { constructor(message = 'source is not a valid PDF') { super(message); this.name = 'InvalidPdfError'; } }
export const PDF_STAMPER = Symbol('PDF_STAMPER');
