// Q-124 · Батлах түвшин/босгын өөрчлөлт 4 нүдээр (Maker-Checker, docs/05-maker-checker.md §8). Maker (ADMIN) саналаа илгээнэ,
// өөр хэрэглэгч (ADMIN/APPROVER) батлахад л нэг tx-д хэрэгжинэ: түвшин солих + аудит + SettingsChanged outbox.
import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '.prisma/client-origination';
import {
  APPROVAL_LEVELS_ACTION_REPLACE, APPROVAL_LEVELS_TARGET_ID, APPROVAL_LEVELS_TARGET_TYPE, ReplaceApprovalLevelsBody, validateApprovalLevels, type RequestContext,
} from '@los/contracts';
import { buildEvent, enqueueOutbox, recordAudit } from '@los/database';
import type { PrismaService } from '../../prisma.service';
import type { ChangeRequestTx } from '../maker-checker/change-request.store';
import { ChangeConflictError, ChangeHandlerRegistry, ChangeValidationError, type ApplyContext, type ChangeHandler, type SnapshotContext } from '../maker-checker/change-handler';

const num = (v: { toString(): string } | null | undefined): number | null => (v == null ? null : Number(v.toString()));

/** Бүтцийн шалгалт (BR-13): босго шатлал + нэг түвшинд батлагч давхцахгүй. Алдааны мессеж буцаана, зөв бол null. */
export function levelsProblem(body: ReplaceApprovalLevelsBody): string | null {
  const bad = validateApprovalLevels(body.levels);
  if (bad) return bad;
  if (body.levels.some((l) => new Set(l.members.map((m) => m.userId)).size !== l.members.length)) return 'Нэг түвшинд нэг батлагч давхар орж болохгүй';
  return null;
}

/** Нийтлэг (productId = null) түвшнүүдийн одоогийн төлөв — diff-ийн `before` ба хуучралтын хувилбар (MC-BR-7) */
export async function readLevels(tx: Prisma.TransactionClient | PrismaService, orgId: string) {
  const rows = await tx.approvalLevel.findMany({ where: { orgId, productId: null }, include: { members: true }, orderBy: { levelNo: 'asc' } });
  return rows.map((l) => ({
    levelNo: l.levelNo, name: l.name, amountFrom: num(l.amountFrom)!, amountTo: num(l.amountTo), quorumType: l.quorumType, slaHours: l.slaHours,
    members: l.members.filter((m) => m.userId).map((m) => ({ userId: m.userId! })).sort((a, b) => a.userId.localeCompare(b.userId)),
  }));
}
const versionOf = (levels: unknown) => createHash('sha256').update(JSON.stringify(levels)).digest('hex').slice(0, 32);

@Injectable()
export class ApprovalLevelsChangeHandler implements ChangeHandler<ReplaceApprovalLevelsBody> {
  readonly targetType = APPROVAL_LEVELS_TARGET_TYPE;
  readonly action = APPROVAL_LEVELS_ACTION_REPLACE;
  readonly payloadSchema = ReplaceApprovalLevelsBody;
  readonly makerRoles = ['ADMIN'] as const;
  readonly defaultPolicy = { enabled: true, checkerRoles: ['ADMIN', 'APPROVER'], expiresInHours: 72 } as const;

  constructor(@Inject(ChangeHandlerRegistry) registry: ChangeHandlerRegistry) { registry.register(this); }

  canonicalTargetId() { return APPROVAL_LEVELS_TARGET_ID; }

  async validate({ payload, actor, repo }: { payload: ReplaceApprovalLevelsBody; actor: { orgId: string }; repo: ChangeRequestTx }) {
    const bad = levelsProblem(payload);
    if (bad) throw new ChangeValidationError(bad);
    // tx-ээр уншина (ижил connection) — pool-ийн хоёр дахь connection авбал ачаалалтай үед түгжигдэнэ
    const pending = await (repo.db as Prisma.TransactionClient).approvalRequest.count({ where: { orgId: actor.orgId, status: 'PENDING' } });
    if (pending > 0) throw new ChangeValidationError(`Шийдвэр хүлээж буй ${pending} батлах хүсэлт байна — дууссаны дараа өөрчилнө үү`);
  }

  async snapshot({ db, orgId }: SnapshotContext) {
    const levels = await readLevels(db as Prisma.TransactionClient, orgId);
    return { before: { levels }, baseVersion: versionOf(levels) };
  }

  async apply({ db, request, payload, checker }: ApplyContext<ReplaceApprovalLevelsBody>) {
    const tx = db as Prisma.TransactionClient;
    const orgId = request.orgId;
    const before = await readLevels(tx, orgId);
    if (request.baseVersion !== null && request.baseVersion !== versionOf(before)) throw new ChangeConflictError('approval levels were changed after this request was submitted');
    const bad = levelsProblem(payload);
    if (bad) throw new ChangeValidationError(bad);
    // Шийдвэр хүлээж буй батлах хүсэлт байхад түвшний дугаар зөрнө (BR-13) → хуучирсан гэж үзнэ
    const pending = await tx.approvalRequest.count({ where: { orgId, status: 'PENDING' } });
    if (pending > 0) throw new ChangeConflictError(`${pending} approval request(s) are in flight`);
    const actorId = checker?.userId ?? request.makerId;
    await tx.approvalLevel.deleteMany({ where: { orgId, productId: null } }); // member нь onDelete: Cascade
    for (const l of payload.levels) {
      await tx.approvalLevel.create({
        data: {
          orgId, productId: null, levelNo: l.levelNo, name: l.name, amountFrom: l.amountFrom, amountTo: l.amountTo, quorumType: l.quorumType, slaHours: l.slaHours,
          createdBy: request.makerId, updatedBy: actorId, members: { create: l.members.map((m) => ({ orgId, userId: m.userId, createdBy: request.makerId, updatedBy: actorId })) },
        },
      });
    }
    await recordAudit(tx, {
      orgId, entity: 'APPROVAL_LEVEL', entityId: 'default', action: 'APPROVAL_LEVELS_REPLACED', actorId, correlationId: request.correlationId,
      beforeJson: { levels: before },
      afterJson: { levels: payload.levels, changeRequestId: request.id, makerId: request.makerId, checkerId: checker?.userId ?? null },
    });
    const ctx: Pick<RequestContext, 'orgId' | 'userId' | 'correlationId'> = { orgId, userId: actorId, correlationId: request.correlationId };
    await enqueueOutbox(tx, buildEvent(ctx, 'SettingsChanged', { key: 'approval.levels', productId: null }));
  }
}
