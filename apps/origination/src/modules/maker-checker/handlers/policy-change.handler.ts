import { Inject, Injectable } from '@nestjs/common';
import { MakerCheckerPolicy, POLICY_ACTION_UPDATE, POLICY_TARGET_TYPE } from '@los/contracts';
import { ChangeConflictError, ChangeHandlerRegistry, type ApplyContext, type ChangeHandler, type SnapshotContext } from '../change-handler';
import { effectivePolicy } from '../maker-checker.domain';
import { err } from '../maker-checker.errors';

const VERSION_DEFAULT = 'default';

/**
 * MC-BR-8: 4 нүдний policy-г өөрчлөх нь өөрөө үргэлж 4 нүдтэй (alwaysFourEyes) — нэг админ ганцаараа хяналтыг унтрааж чадахгүй.
 * Бусад handler-ийн policy-г (enabled / checkerRoles / TTL) өөрчилнө. Эхний бүртгэлийг модуль өөрөө хийнэ.
 */
@Injectable()
export class PolicyChangeHandler implements ChangeHandler<MakerCheckerPolicy> {
  readonly targetType = POLICY_TARGET_TYPE;
  readonly action = POLICY_ACTION_UPDATE;
  readonly payloadSchema = MakerCheckerPolicy;
  readonly makerRoles = ['ADMIN'] as const;
  readonly defaultPolicy = { enabled: true, checkerRoles: ['ADMIN', 'APPROVER'], expiresInHours: 72 } as const;
  readonly alwaysFourEyes = true;

  constructor(@Inject(ChangeHandlerRegistry) private readonly registry: ChangeHandlerRegistry) { this.registry.register(this); }

  canonicalTargetId(p: MakerCheckerPolicy) { return `${p.targetType}:${p.action}`; }

  validate({ payload }: { payload: MakerCheckerPolicy }) {
    const target = this.registry.get(payload.targetType, payload.action);
    if (!target) throw err('HANDLER_NOT_FOUND', { targetType: payload.targetType, action: payload.action });
    if (target.alwaysFourEyes && !payload.enabled) throw err('POLICY_LOCKED', { targetType: payload.targetType, action: payload.action });
  }

  async snapshot({ repo, orgId, targetId }: SnapshotContext) {
    const [targetType, action] = this.split(targetId);
    const target = this.registry.get(targetType, action);
    if (!target) return null;
    const row = await repo.getPolicy(orgId, targetType, action);
    const p = effectivePolicy(target, row);
    return { before: { targetType, action, enabled: p.enabled, checkerRoles: p.checkerRoles, expiresInHours: p.expiresInHours }, baseVersion: row ? row.updatedAt.toISOString() : VERSION_DEFAULT };
  }

  async apply({ repo, request, payload }: ApplyContext<MakerCheckerPolicy>) {
    const current = await repo.getPolicy(request.orgId, payload.targetType, payload.action);
    const version = current ? current.updatedAt.toISOString() : VERSION_DEFAULT;
    if (request.baseVersion !== null && request.baseVersion !== version) throw new ChangeConflictError('policy was changed by someone else after this request was submitted');
    await repo.upsertPolicy({
      orgId: request.orgId, targetType: payload.targetType, action: payload.action,
      enabled: payload.enabled, checkerRoles: payload.checkerRoles, expiresInHours: payload.expiresInHours, updatedBy: request.makerId,
    });
  }

  private split(targetId: string): [string, string] {
    const i = targetId.indexOf(':');
    return i < 0 ? [targetId, ''] : [targetId.slice(0, i), targetId.slice(i + 1)];
  }
}
