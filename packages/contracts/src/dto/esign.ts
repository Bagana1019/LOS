import { z } from 'zod';
import { ESignProvider, SigningFailureReason, SigningStatus } from '../enums';
// Цахим гарын үсгийн REST DTO — FR-11.4. origination → dms (sync, CLAUDE.md §3.2) болон зээлдэгчийн (public) линкийн урсгал.
// Регистр, утас нь зөвхөн origination → dms дотоод дуудлагад л дамжина; dms шифрлэж хадгална, лог/public хариунд ЗӨВХӨН далдалсан хэлбэрээр гарна (CLAUDE.md §6.5).

/** Зээлдэгчид харуулах зөвшөөрлийн текстийн хувилбар. Текстийг өөрчлөх бүртээ нэмж, dms хувилбарыг аудитад бичнэ (нотлох баримт). */
export const ESIGN_CONSENT_VERSION = 'v1';

export const SigningSigner = z.object({
  customerId: z.string().min(1),
  fullName: z.string().trim().min(1).max(200),
  registerNo: z.string().trim().min(8).max(16),
  phone: z.string().trim().regex(/^\+?[0-9]{8,15}$/),
});
export type SigningSigner = z.infer<typeof SigningSigner>;

/** origination → dms `POST /esign/requests`. Байгууллага нь биед биш `X-Org-Id` толгойноос (RequestContext) */
export const CreateSigningRequest = z.object({
  applicationId: z.string().min(1),
  contractId: z.string().min(1),
  contractNo: z.string().min(1),
  /** dms `file` дахь үүсгэсэн (гарын үсэггүй) гэрээний PDF */
  sourceFileId: z.string().min(1),
  signer: SigningSigner,
  /** Зээлдэгчийн сонголтыг шахахгүй — заасан бол зөвхөн энэ provider-ийг санал болгоно */
  preferredProvider: z.enum(ESignProvider).optional(),
  /** Линкийн хүчинтэй хугацаа (цаг). Заагаагүй бол ESIGN_LINK_TTL_HOURS */
  ttlHours: z.number().int().min(1).max(168).optional(),
  /** Идэвхтэй хүсэлт байвал цуцлаад шинийг үүсгэх; үгүй бол 409 */
  supersedeActive: z.boolean().optional(),
});
export type CreateSigningRequest = z.infer<typeof CreateSigningRequest>;

/** Ажилтны (дотоод) харагдац. `signingUrl` зөвхөн create/resend хариунд — токен DB-д хадгалагдахгүй тул дахин сэргээх боломжгүй. */
export const SigningRequestView = z.object({
  id: z.string(),
  orgId: z.string(),
  applicationId: z.string(),
  contractId: z.string(),
  contractNo: z.string(),
  status: z.enum(SigningStatus),
  provider: z.enum(ESignProvider).nullable(),
  /** Сонгосон provider mock бол true — ТЕСТ тэмдэглэгээ харуулахад */
  providerMock: z.boolean(),
  signerCustomerId: z.string(),
  signerNameMasked: z.string(),
  signerPhoneMasked: z.string(),
  linkExpiresAt: z.string().datetime(),
  signedAt: z.string().datetime().nullable(),
  signedFileId: z.string().nullable(),
  signatureFileId: z.string().nullable(),
  verificationCode: z.string().nullable(),
  failureReason: z.enum(SigningFailureReason).nullable(),
  createdAt: z.string().datetime(),
  signingUrl: z.string().url().optional(),
});
export type SigningRequestView = z.infer<typeof SigningRequestView>;

export const ProviderOption = z.object({ code: z.enum(ESignProvider), displayName: z.string(), mock: z.boolean() });
export type ProviderOption = z.infer<typeof ProviderOption>;

/** Зээлдэгчийн утсан дээрх (public, токеноор) харагдац */
export const PublicSigningSession = z.object({
  status: z.enum(SigningStatus),
  contractNo: z.string(),
  signerNameMasked: z.string(),
  linkExpiresAt: z.string().datetime(),
  providers: z.array(ProviderOption),
  provider: z.enum(ESignProvider).nullable(),
  /** Зээлдэгч апп дээрээ харуулсан кодтой тулгах 4 оронтой код */
  challengeCode: z.string().nullable(),
  /** Утсан дээр provider апп-ыг нээх deep link */
  deepLink: z.string().nullable(),
  sessionExpiresAt: z.string().datetime().nullable(),
  documentViewed: z.boolean(),
  failureReason: z.enum(SigningFailureReason).nullable(),
  signedAt: z.string().datetime().nullable(),
  verificationCode: z.string().nullable(),
  /** Гарын үсэг зурагдсаны дараа, `signedCopyExpiresAt`-аас өмнө л true — `GET /public/esign/:token/signed-document` */
  signedDocumentAvailable: z.boolean(),
  /** Зээлдэгч өөрийн хувийг линкээр татаж болох сүүлийн хугацаа (SIGNED үед). Линкийн хугацаа дууссан ч энэ хүртэл татаж болно. */
  signedCopyExpiresAt: z.string().datetime().nullable(),
  /** Одоогийн зөвшөөрлийн текстийн хувилбар — UI үүнийг харуулж, `StartPublicSigning.consentVersion`-д буцаана */
  consentVersion: z.string(),
  /** Сонгосон provider mock бол true */
  providerMock: z.boolean(),
});
export type PublicSigningSession = z.infer<typeof PublicSigningSession>;

/** `POST /public/esign/:token/start` — гэрээг үзсэний дараа, зөвшөөрөл өгч provider сонгоно */
export const StartPublicSigning = z.object({ provider: z.enum(ESignProvider), consent: z.literal(true), consentVersion: z.string().min(1).max(32) });
export type StartPublicSigning = z.infer<typeof StartPublicSigning>;

/** QR кодын цэг — `GET /public/esign/verify/:code`. Гэрээний агуулга, регистр, утас БАЙХГҮЙ. */
export const SigningVerification = z.object({
  valid: z.boolean(),
  contractNo: z.string(),
  signerNameMasked: z.string(),
  provider: z.enum(ESignProvider),
  signedAt: z.string().datetime(),
  originalSha256: z.string(),
  signedSha256: z.string(),
  certificateIssuer: z.string(),
  certificateSerial: z.string(),
  mock: z.boolean(),
});
export type SigningVerification = z.infer<typeof SigningVerification>;
