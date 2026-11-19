// CLAUDE.md §3.3 → DWH star schema (§4). Every payload is validated against the @los/contracts zod schema of its type;
// versions other than SUPPORTED_VERSION are skipped (logged by the caller), never thrown (§3.2.5).
import { ApplicationApproved, ApplicationReturned, ApplicationStatusChanged, ApplicationSubmitted, DisbursementApproved, ScoringCompleted, StatementImported } from '@los/contracts';
import type { z } from 'zod';

const SCHEMAS = { ApplicationSubmitted, ApplicationStatusChanged, ApplicationApproved, ApplicationReturned, DisbursementApproved, StatementImported, ScoringCompleted } as const;
export type DwhEventType = keyof typeof SCHEMAS;
export type DwhEvent = z.infer<(typeof SCHEMAS)[DwhEventType]>;
export const SUPPORTED_VERSION = 1;

/** One consumer group per fact (CLAUDE.md §3.1: group = `<service>-<module>`); a poison message in one fact never stalls another. */
export const DWH_SUBSCRIPTIONS: readonly { group: string; types: readonly DwhEventType[] }[] = [
  { group: 'dwh-sync-application', types: ['ApplicationSubmitted', 'ApplicationStatusChanged', 'ApplicationApproved', 'ApplicationReturned'] },
  { group: 'dwh-sync-scoring', types: ['ScoringCompleted'] },
  { group: 'dwh-sync-disbursement', types: ['DisbursementApproved'] },
  { group: 'dwh-sync-bsa', types: ['StatementImported'] },
];

export type SkipReason = 'INVALID' | 'UNHANDLED_TYPE' | 'UNSUPPORTED_VERSION';
export type Decoded = { ok: true; event: DwhEvent } | { ok: false; reason: SkipReason };

const isHandled = (t: unknown): t is DwhEventType => typeof t === 'string' && Object.hasOwn(SCHEMAS, t);

export function decodeDwhEvent(raw: unknown): Decoded {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, reason: 'INVALID' };
  const { type, version } = raw as { type?: unknown; version?: unknown };
  if (!isHandled(type)) return { ok: false, reason: 'UNHANDLED_TYPE' };
  if (version !== SUPPORTED_VERSION) return { ok: false, reason: 'UNSUPPORTED_VERSION' };
  const parsed = SCHEMAS[type].safeParse(raw);
  return parsed.success ? { ok: true, event: parsed.data } : { ok: false, reason: 'INVALID' };
}
