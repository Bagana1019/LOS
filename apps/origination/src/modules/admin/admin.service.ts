import { Injectable } from '@nestjs/common';
import {
  validateApprovalLevels, type ApprovalLevelDto, type AuditLogPage, type AuditLogQuery, type ContractNumberTemplateBody, type ReplaceApprovalLevelsBody, type RequestContext,
} from '@los/contracts';
import { buildEvent, enqueueOutbox, recordAudit } from '@los/database';
import { DomainError, conflict } from '@los/nest-common';
import { PrismaService } from '../../prisma.service';

const num = (v: { toString(): string } | null | undefined): number | null => (v == null ? null : Number(v.toString()));

/** FR-13 · Админ тохиргоо: батлах түвшин (BR-13), гэрээний дугаарын загвар (BR-11), аудит лог (FR-13.5). Эрх: @Permissions (settings:manage | audit:read). */
@Injectable()
export class AdminService {
  constructor(private readonly db: PrismaService) {}

  // ── батлах түвшин ──
  async listLevels(ctx: RequestContext): Promise<ApprovalLevelDto[]> {
    const rows = await this.db.approvalLevel.findMany({ where: { orgId: ctx.orgId, productId: null }, include: { members: true }, orderBy: { levelNo: 'asc' } });
    return rows.map((l) => ({
      id: l.id, levelNo: l.levelNo, name: l.name, amountFrom: num(l.amountFrom)!, amountTo: num(l.amountTo), quorumType: l.quorumType as ApprovalLevelDto['quorumType'], slaHours: l.slaHours,
      members: l.members.filter((m) => m.userId).map((m) => ({ userId: m.userId! })),
    }));
  }

  /** Нийтлэг түвшнүүдийг бүхэлд нь солино (BR-13). Шийдвэр хүлээж буй (PENDING) батлах хүсэлт байвал 409 — түвшний дугаар зөрөхөөс сэргийлнэ. */
  async replaceLevels(ctx: RequestContext, body: ReplaceApprovalLevelsBody): Promise<ApprovalLevelDto[]> {
    const bad = validateApprovalLevels(body.levels);
    if (bad) throw new DomainError('APPROVAL_LEVELS_INVALID', bad, 422);
    if (body.levels.some((l) => new Set(l.members.map((m) => m.userId)).size !== l.members.length)) {
      throw new DomainError('APPROVAL_LEVELS_INVALID', 'Нэг түвшинд нэг батлагч давхар орж болохгүй', 422);
    }
    await this.db.$transaction(async (tx) => {
      const pending = await tx.approvalRequest.count({ where: { orgId: ctx.orgId, status: 'PENDING' } });
      if (pending > 0) throw conflict('APPROVALS_IN_FLIGHT', `Шийдвэр хүлээж буй ${pending} батлах хүсэлт байна — дууссаны дараа өөрчилнө үү`);
      const before = await tx.approvalLevel.findMany({ where: { orgId: ctx.orgId, productId: null }, include: { members: true }, orderBy: { levelNo: 'asc' } });
      await tx.approvalLevel.deleteMany({ where: { orgId: ctx.orgId, productId: null } }); // member нь onDelete: Cascade
      for (const l of body.levels) {
        await tx.approvalLevel.create({
          data: {
            orgId: ctx.orgId, productId: null, levelNo: l.levelNo, name: l.name, amountFrom: l.amountFrom, amountTo: l.amountTo, quorumType: l.quorumType, slaHours: l.slaHours,
            createdBy: ctx.userId, updatedBy: ctx.userId, members: { create: l.members.map((m) => ({ orgId: ctx.orgId, userId: m.userId, createdBy: ctx.userId, updatedBy: ctx.userId })) },
          },
        });
      }
      await recordAudit(tx, {
        orgId: ctx.orgId, entity: 'APPROVAL_LEVEL', entityId: 'default', action: 'APPROVAL_LEVELS_REPLACED', actorId: ctx.userId, correlationId: ctx.correlationId,
        beforeJson: { levels: before.map((l) => ({ levelNo: l.levelNo, name: l.name, amountFrom: num(l.amountFrom), amountTo: num(l.amountTo), slaHours: l.slaHours, members: l.members.map((m) => m.userId) })) },
        afterJson: { levels: body.levels },
      });
      await enqueueOutbox(tx, buildEvent(ctx, 'SettingsChanged', { key: 'approval.levels', productId: null }));
    });
    return this.listLevels(ctx);
  }

  // ── гэрээний дугаарын загвар ──
  async getTemplate(ctx: RequestContext) {
    const t = await this.db.contractNumberTemplate.findFirst({ where: { orgId: ctx.orgId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    // Тохируулаагүй бол id = null (JSON хоосон body-оос зайлсхийнэ)
    return t ? { id: t.id, pattern: t.pattern, prefix: t.prefix, seqScope: t.seqScope } : { id: null, pattern: '{PREFIX}{BRANCH}{YYMMDD}{SEQ:2}', prefix: 'B', seqScope: 'DAY' };
  }

  /** Эхний загварыг шинэчилнэ (approval нь ийм загварыг уншдаг); байхгүй бол үүсгэнэ. Тоолуур (`counter`) хадгалагдана. */
  async putTemplate(ctx: RequestContext, body: ContractNumberTemplateBody) {
    await this.db.$transaction(async (tx) => {
      const cur = await tx.contractNumberTemplate.findFirst({ where: { orgId: ctx.orgId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      if (cur) await tx.contractNumberTemplate.update({ where: { id: cur.id }, data: { ...body, updatedBy: ctx.userId } });
      else await tx.contractNumberTemplate.create({ data: { orgId: ctx.orgId, ...body, createdBy: ctx.userId, updatedBy: ctx.userId } });
      await recordAudit(tx, { orgId: ctx.orgId, entity: 'CONTRACT_NUMBER_TEMPLATE', entityId: cur?.id ?? 'new', action: 'CONTRACT_TEMPLATE_UPDATED', actorId: ctx.userId, correlationId: ctx.correlationId, beforeJson: cur ? { pattern: cur.pattern, prefix: cur.prefix, seqScope: cur.seqScope } : null, afterJson: body });
      await enqueueOutbox(tx, buildEvent(ctx, 'SettingsChanged', { key: 'contract.number_template', productId: null }));
    });
    return this.getTemplate(ctx);
  }

  // ── аудит лог (FR-13.5) ──
  async audit(ctx: RequestContext, q: AuditLogQuery): Promise<AuditLogPage> {
    const where = {
      orgId: ctx.orgId,
      ...(q.entity ? { entity: q.entity } : {}), ...(q.entityId ? { entityId: q.entityId } : {}), ...(q.actorId ? { actorId: q.actorId } : {}),
      ...(q.action ? { action: q.action } : {}), ...(q.applicationId ? { applicationId: q.applicationId } : {}),
      ...(q.from || q.to ? { at: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } } : {}),
    };
    const [total, rows] = await Promise.all([
      this.db.auditLog.count({ where }),
      this.db.auditLog.findMany({ where, orderBy: [{ at: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return {
      total, page: q.page, pageSize: q.pageSize,
      items: rows.map((r) => ({ id: r.id, entity: r.entity, entityId: r.entityId, action: r.action, actorId: r.actorId, at: r.at.toISOString(), applicationId: r.applicationId, correlationId: r.correlationId, beforeJson: r.beforeJson, afterJson: r.afterJson })),
    };
  }
}
