import { z } from 'zod';
import { ESignProvider, SigningFailureReason } from './enums';
// Event каталог — CLAUDE.md §4. Нэр: <Aggregate><PastTenseVerb>, version заавал.
const base = z.object({
  eventId: z.string().uuid(), occurredAt: z.string().datetime(), version: z.literal(1),
  orgId: z.string(), actorId: z.string().nullable(), correlationId: z.string(),
});
export const ApplicationSubmitted = base.extend({ type: z.literal('ApplicationSubmitted'), applicationId: z.string(), amount: z.number(), productId: z.string() });
export const ApplicationApproved = base.extend({ type: z.literal('ApplicationApproved'), applicationId: z.string(), contractNo: z.string() });
export const ApplicationReturned = base.extend({ type: z.literal('ApplicationReturned'), applicationId: z.string(), levelNo: z.number(), comment: z.string() });
export const ApplicationStatusChanged = base.extend({ type: z.literal('ApplicationStatusChanged'), applicationId: z.string(), from: z.string(), to: z.string() });
export const DisbursementApproved = base.extend({ type: z.literal('DisbursementApproved'), applicationId: z.string(), amount: z.number(), coreLoanId: z.string().nullable() });
export const KycCompleted = base.extend({ type: z.literal('KycCompleted'), applicationId: z.string(), customerId: z.string(), blacklisted: z.boolean() });
export const StatementImported = base.extend({ type: z.literal('StatementImported'), analysisId: z.string(), applicationId: z.string(), rows: z.number(), status: z.enum(['COMPLETED','FAILED']) });
export const ScoringCompleted = base.extend({ type: z.literal('ScoringCompleted'), applicationId: z.string(), selectedMethod: z.string(), soscoScore: z.number().nullable(), dtiPercent: z.number().nullable() });
export const ValuationCompleted = base.extend({ type: z.literal('ValuationCompleted'), collateralId: z.string(), applicationId: z.string(), marketValue: z.number(), collateralValue: z.number() });
export const DocumentUploaded = base.extend({ type: z.literal('DocumentUploaded'), documentId: z.string(), applicationId: z.string().nullable(), kind: z.string() });
// CLAUDE.md §3.2.8: нийтлэг тохиргоо өөрчлөгдөхөд бусад сервис projection-аа шинэчилнэ
export const SettingsChanged = base.extend({ type: z.literal('SettingsChanged'), key: z.string(), productId: z.string().nullable() });
// FR-11.4 Цахим гарын үсэг (dms гаргана → origination, dwh). correlationId нь origination-ы эхлүүлсэн хүсэлтийнхтэй ижил.
export const ContractSigningRequested = base.extend({ type: z.literal('ContractSigningRequested'), signingRequestId: z.string(), applicationId: z.string(), contractId: z.string(), contractNo: z.string(), linkExpiresAt: z.string().datetime() });
export const ContractSigned = base.extend({ type: z.literal('ContractSigned'), signingRequestId: z.string(), applicationId: z.string(), contractId: z.string(), contractNo: z.string(), provider: z.enum(ESignProvider), signedFileId: z.string(), signatureFileId: z.string(), originalSha256: z.string(), signedSha256: z.string(), signedAt: z.string().datetime(), verificationCode: z.string() });
export const ContractSigningFailed = base.extend({ type: z.literal('ContractSigningFailed'), signingRequestId: z.string(), applicationId: z.string(), contractId: z.string(), contractNo: z.string(), reason: z.enum(SigningFailureReason) });
export const DomainEvent = z.discriminatedUnion('type', [ApplicationSubmitted, ApplicationApproved, ApplicationReturned, ApplicationStatusChanged, DisbursementApproved, KycCompleted, StatementImported, ScoringCompleted, ValuationCompleted, DocumentUploaded, SettingsChanged,
  ContractSigningRequested, ContractSigned, ContractSigningFailed]);
export type DomainEvent = z.infer<typeof DomainEvent>;
export const EVENT_STREAM = 'los:events';
