// Q-132: Хар жагсаалтад "Хар" түвшнээр оруулах/ Саарал → Хар болгох нь 4 нүдээр (Maker-Checker, docs/05-maker-checker.md).
// Payload-д зөвхөн entryId (change_request өөрчлөгдөхгүй, PII-гүй байх ёстой). Хэрэгжүүлэлт: checker батлахад нэг tx-д мөр + outbox event + аудит.
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { enqueueOutbox } from '@los/database';
import type { AmlSubjectType } from '@los/contracts';
import { ChangeConflictError, ChangeHandlerRegistry, ChangeValidationError, type ApplyContext, type ChangeHandler, type SnapshotContext } from '../maker-checker/change-handler';

export const BLACKLIST_CHANGE_TARGET = 'BLACKLIST_ENTRY';
export const BLACKLIST_CHANGE_ACTION = 'ACTIVATE_BLACK';
const Payload = z.object({ entryId: z.string().uuid() });
type Payload = z.infer<typeof Payload>;

interface Row {
  id: string; orgId: string; registerNoHash: string; customerType: string; name: string; listType: string; severity: string;
  reasonCode: string; isActive: boolean; pendingSeverity: string | null; updatedAt: Date;
}
/** Handler-ийн ашигладаг tx-ийн хэлбэр (бодит Prisma.TransactionClient үүнд бүтцээрээ таарна). */
export interface EscalationTx {
  blacklist: {
    findFirst(args: { where: object }): Promise<Row | null>;
    updateMany(args: { where: object; data: object }): Promise<{ count: number }>;
  };
  outbox: { create(args: { data: { id: string; type: string; payload: object } }): Promise<unknown> };
  auditLog: { create(args: { data: object }): Promise<unknown> };
}

@Injectable()
export class BlacklistEscalationHandler implements ChangeHandler<Payload> {
  readonly targetType = BLACKLIST_CHANGE_TARGET;
  readonly action = BLACKLIST_CHANGE_ACTION;
  readonly payloadSchema = Payload;
  readonly makerRoles = ['ADMIN', 'COMPLIANCE'] as const;
  readonly defaultPolicy = { enabled: true, checkerRoles: ['ADMIN', 'COMPLIANCE'], expiresInHours: 72 } as const;

  constructor(@Inject(ChangeHandlerRegistry) registry: ChangeHandlerRegistry) { registry.register(this); }

  canonicalTargetId(p: Payload) { return p.entryId; }

  async snapshot({ db, orgId, targetId }: SnapshotContext) {
    const row = await (db as EscalationTx).blacklist.findFirst({ where: { id: targetId, orgId } });
    if (!row) return null;
    // PII-гүй: регистр, нэр орохгүй
    return { before: { entryId: row.id, severity: row.severity, pendingSeverity: row.pendingSeverity, isActive: row.isActive, listType: row.listType, reasonCode: row.reasonCode } };
  }

  async apply({ db, request, payload, checker }: ApplyContext<Payload>) {
    const tx = db as EscalationTx;
    const row = await tx.blacklist.findFirst({ where: { id: payload.entryId, orgId: request.orgId } });
    if (!row) throw new ChangeValidationError('blacklist entry not found');
    // Maker-ийн илгээснээс хойш хүсэлт цуцлагдсан/өөрчлөгдсөн (жишээ нь Саарал болгосон) бол хуучирсан
    if (row.pendingSeverity !== 'BLACK') throw new ChangeConflictError('blacklist entry is no longer awaiting Black approval');
    const prevAt = row.updatedAt;
    const at = new Date(Math.max(Date.now(), prevAt.getTime() + 1)); // changedAt хатуу өснө (kyc projection)
    const actorId = checker?.userId ?? request.makerId;
    const { count } = await tx.blacklist.updateMany({
      where: { id: row.id, orgId: row.orgId, updatedAt: prevAt },
      data: { severity: 'BLACK', isActive: true, pendingSeverity: null, validUntil: null, deactivationReason: null, updatedAt: at, updatedBy: actorId, registeredBy: request.makerId, registeredAt: at },
    });
    if (count !== 1) throw new ChangeConflictError('blacklist entry was modified concurrently');
    await enqueueOutbox(tx as never, {
      type: 'BlacklistEntryChanged', eventId: randomUUID(), occurredAt: at.toISOString(), version: 1, orgId: row.orgId, actorId,
      correlationId: request.correlationId, entryId: row.id, registerNoHash: row.registerNoHash, customerType: row.customerType as AmlSubjectType,
      name: row.name, listType: row.listType, severity: 'BLACK', reasonCode: row.reasonCode, isActive: true, changedAt: at.toISOString(),
    });
    await tx.auditLog.create({
      data: {
        orgId: row.orgId, entity: 'blacklist', entityId: row.id, action: 'ESCALATE_APPLIED', actorId, correlationId: request.correlationId,
        beforeJson: { severity: row.severity, pendingSeverity: 'BLACK', isActive: row.isActive }, afterJson: { severity: 'BLACK', pendingSeverity: null, isActive: true, changeRequestId: request.id },
      },
    });
  }
}
