// F11-9: the dashboard funnel counts returns from the append-only history (audit_log STATUS_CHANGED), not from loan_application.returned_at.
// This helper writes the same row `ApplicationStateMachine.apply` writes on every transition, so tests can seed history without running the full flow.
import type { ApplicationStatus } from '@los/contracts';
import { ORG } from '../../test-utils/factories';
import type { PrismaService } from '../../prisma.service';

export interface StatusEventSpec {
  from: ApplicationStatus;
  to: ApplicationStatus;
  /** ISO instant (UTC), e.g. '2026-10-06T14:00:00Z'. */
  at: string;
  orgId?: string;
  /** Override the audit action / entity to prove unrelated audit rows are ignored. */
  action?: string;
  entity?: string;
}

export async function createStatusEvent(prisma: PrismaService, applicationId: string, e: StatusEventSpec) {
  return prisma.auditLog.create({
    data: {
      orgId: e.orgId ?? ORG, entity: e.entity ?? 'LOAN_APPLICATION', entityId: applicationId, action: e.action ?? 'STATUS_CHANGED', applicationId,
      at: new Date(e.at), beforeJson: { status: e.from }, afterJson: { status: e.to, via: 'SYSTEM', reason: null },
    },
  });
}

/** The IN_APPROVAL -> RETURNED transition (the only way an application becomes RETURNED). */
export const createReturnEvent = (prisma: PrismaService, applicationId: string, at: string, o: Pick<StatusEventSpec, 'orgId'> = {}) =>
  createStatusEvent(prisma, applicationId, { from: 'IN_APPROVAL', to: 'RETURNED', at, ...o });
