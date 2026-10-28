import { z } from 'zod';
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
export const DomainEvent = z.discriminatedUnion('type', [ApplicationSubmitted, ApplicationApproved, ApplicationReturned, ApplicationStatusChanged, DisbursementApproved, KycCompleted, StatementImported, ScoringCompleted, ValuationCompleted, DocumentUploaded]);
export type DomainEvent = z.infer<typeof DomainEvent>;
export const EVENT_STREAM = 'los:events';
