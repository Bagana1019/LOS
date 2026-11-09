// Q-124 · Батлах урсгалд нөлөөлдөг тохиргоо (FOUR_EYES_SETTING_KEYS: салбарын код, батлах SLA) 4 нүдээр өөрчлөгдөнө.
import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '.prisma/client-origination';
import { FOUR_EYES_SETTING_KEYS, SETTING_ACTION_UPDATE, SETTING_TARGET_TYPE, isFourEyesSettingKey, type FourEyesSettingKey } from '@los/contracts';
import { z } from 'zod';
import { ChangeConflictError, ChangeHandlerRegistry, ChangeValidationError, type ApplyContext, type ChangeHandler, type SnapshotContext } from '../maker-checker/change-handler';
import { applySetting, checkSetting } from './settings.service';

const Payload = z.object({ key: z.enum(FOUR_EYES_SETTING_KEYS), value: z.unknown().refine((v) => v !== undefined, 'value is required') });
type Payload = z.infer<typeof Payload>;
const DEFAULT = 'default';

@Injectable()
export class SettingChangeHandler implements ChangeHandler<Payload> {
  readonly targetType = SETTING_TARGET_TYPE;
  readonly action = SETTING_ACTION_UPDATE;
  readonly payloadSchema = Payload as never as z.ZodType<Payload, z.ZodTypeDef, unknown>;
  readonly makerRoles = ['ADMIN'] as const;
  readonly defaultPolicy = { enabled: true, checkerRoles: ['ADMIN', 'APPROVER'], expiresInHours: 72 } as const;

  constructor(@Inject(ChangeHandlerRegistry) registry: ChangeHandlerRegistry) { registry.register(this); }

  canonicalTargetId(p: Payload) { return p.key; }

  validate({ payload }: { payload: Payload }) {
    try { checkSetting(payload.key, payload.value); } catch (e) { throw new ChangeValidationError(e instanceof Error ? e.message : 'invalid setting value'); }
  }

  async snapshot({ db, orgId, targetId }: SnapshotContext) {
    if (!isFourEyesSettingKey(targetId)) return null;
    const row = await (db as Prisma.TransactionClient).setting.findUnique({ where: { orgId_key: { orgId, key: targetId } } });
    return { before: { key: targetId, value: row ? row.valueJson : null, isDefault: !row }, baseVersion: row ? row.updatedAt.toISOString() : DEFAULT };
  }

  async apply({ db, request, payload, checker }: ApplyContext<Payload>) {
    const tx = db as Prisma.TransactionClient;
    const key: FourEyesSettingKey = payload.key;
    const row = await tx.setting.findUnique({ where: { orgId_key: { orgId: request.orgId, key } } });
    const version = row ? row.updatedAt.toISOString() : DEFAULT;
    if (request.baseVersion !== null && request.baseVersion !== version) throw new ChangeConflictError('setting was changed after this request was submitted');
    let parsed: unknown;
    try { parsed = checkSetting(key, payload.value); } catch (e) { throw new ChangeValidationError(e instanceof Error ? e.message : 'invalid setting value'); }
    const actorId = checker?.userId ?? request.makerId;
    await applySetting(tx, { orgId: request.orgId, actorId, correlationId: request.correlationId }, key, parsed, { changeRequestId: request.id, makerId: request.makerId, checkerId: checker?.userId ?? null });
  }
}
