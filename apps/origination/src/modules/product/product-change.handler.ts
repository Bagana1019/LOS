// Бүтээгдэхүүний админ · 4 нүд (Q-124 хэв маяг). Maker (ADMIN) санал илгээнэ; өөр ADMIN/APPROVER батлахад л нэг tx-д
// бүтээгдэхүүн үүсэх/өөрчлөгдөх/идэвхгүй болох + аудит (before/after) + SettingsChanged outbox. Устгахгүй — зөвхөн идэвхгүй болгоно.
import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '.prisma/client-origination';
import {
  PRODUCT_ACTION_CREATE, PRODUCT_ACTION_SET_ACTIVE, PRODUCT_ACTION_UPDATE, PRODUCT_TARGET_TYPE,
  ProductCreatePayload, ProductSetActivePayload, ProductUpdatePayload, type RequestContext,
} from '@los/contracts';
import { buildEvent, enqueueOutbox, recordAudit } from '@los/database';
import type { z } from 'zod';
import type { ChangeRequestTx } from '../maker-checker/change-request.store';
import { ChangeConflictError, ChangeHandlerRegistry, ChangeValidationError, type ApplyContext, type ChangeHandler, type SnapshotContext } from '../maker-checker/change-handler';
import { auditShape, editableColumns, toAdminDto } from './product-view';

type Create = z.infer<typeof ProductCreatePayload>;
type Update = z.infer<typeof ProductUpdatePayload>;
type SetActive = z.infer<typeof ProductSetActivePayload>;

const POLICY = { enabled: true, checkerRoles: ['ADMIN', 'APPROVER'], expiresInHours: 72 } as const;
const json = (v: unknown) => (v === null || v === undefined ? Prisma.DbNull : (v as Prisma.InputJsonValue));
const versionOf = (updatedAt: Date) => updatedAt.toISOString();
const dbOf = (db: unknown) => db as Prisma.TransactionClient;

async function load(tx: Prisma.TransactionClient, orgId: string, id: string) {
  return tx.product.findFirst({ where: { id, orgId } });
}
async function afterNotice(tx: Prisma.TransactionClient, request: ApplyContext<unknown>['request'], actorId: string, productId: string) {
  const ctx: Pick<RequestContext, 'orgId' | 'userId' | 'correlationId'> = { orgId: request.orgId, userId: actorId, correlationId: request.correlationId };
  await enqueueOutbox(tx, buildEvent(ctx, 'SettingsChanged', { key: 'product', productId }));
}
async function auditChange(tx: Prisma.TransactionClient, request: ApplyContext<unknown>['request'], checker: ApplyContext<unknown>['checker'], action: string, productId: string, before: unknown, after: unknown) {
  const actorId = checker?.userId ?? request.makerId;
  await recordAudit(tx, {
    orgId: request.orgId, entity: 'PRODUCT', entityId: productId, action, actorId, correlationId: request.correlationId,
    beforeJson: (before ?? null) as never, afterJson: { ...(after as object), changeRequestId: request.id, makerId: request.makerId, checkerId: checker?.userId ?? null } as never,
  });
}

@Injectable()
export class ProductCreateHandler implements ChangeHandler<Create> {
  readonly targetType = PRODUCT_TARGET_TYPE;
  readonly action = PRODUCT_ACTION_CREATE;
  readonly payloadSchema = ProductCreatePayload as never as z.ZodType<Create, z.ZodTypeDef, unknown>;
  readonly makerRoles = ['ADMIN'] as const;
  readonly defaultPolicy = POLICY;
  constructor(@Inject(ChangeHandlerRegistry) registry: ChangeHandlerRegistry) { registry.register(this); }

  canonicalTargetId(p: Create) { return p.product.code; }

  async validate({ payload, actor, repo }: { payload: Create; actor: { orgId: string }; repo: ChangeRequestTx }) {
    const dup = await (repo.db as Prisma.TransactionClient).product.findFirst({ where: { orgId: actor.orgId, code: payload.product.code }, select: { id: true } });
    if (dup) throw new ChangeValidationError(`"${payload.product.code}" кодтой бүтээгдэхүүн аль хэдийн байна`);
  }

  async snapshot() { return { before: null, baseVersion: 'new' }; }

  async apply({ db, request, payload, checker }: ApplyContext<Create>) {
    const tx = dbOf(db);
    const p = payload.product;
    if (await tx.product.findFirst({ where: { orgId: request.orgId, code: p.code }, select: { id: true } })) throw new ChangeConflictError(`product ${p.code} already exists`);
    const actorId = checker?.userId ?? request.makerId;
    const row = await tx.product.create({
      data: {
        orgId: request.orgId, code: p.code, productType: p.productType, currency: p.currency, ...editableColumns(p),
        documentChecklistJson: json(p.documentChecklist), collateralChecklistJson: json(p.collateralChecklist), haircutJson: json(p.haircut),
        isActive: true, createdBy: request.makerId, updatedBy: actorId,
      },
    });
    await auditChange(tx, request, checker, 'PRODUCT_CREATED', row.id, null, auditShape(toAdminDto(row, 0)));
    await afterNotice(tx, request, actorId, row.id);
  }
}

@Injectable()
export class ProductUpdateHandler implements ChangeHandler<Update> {
  readonly targetType = PRODUCT_TARGET_TYPE;
  readonly action = PRODUCT_ACTION_UPDATE;
  readonly payloadSchema = ProductUpdatePayload as never as z.ZodType<Update, z.ZodTypeDef, unknown>;
  readonly makerRoles = ['ADMIN'] as const;
  readonly defaultPolicy = POLICY;
  constructor(@Inject(ChangeHandlerRegistry) registry: ChangeHandlerRegistry) { registry.register(this); }

  canonicalTargetId(p: Update) { return p.id; }

  async validate({ payload, actor, repo }: { payload: Update; actor: { orgId: string }; repo: ChangeRequestTx }) {
    if (!(await load(repo.db as Prisma.TransactionClient, actor.orgId, payload.id))) throw new ChangeValidationError('Бүтээгдэхүүн олдсонгүй');
  }

  async snapshot({ db, orgId, targetId }: SnapshotContext) {
    const row = await load(dbOf(db), orgId, targetId);
    return row ? { before: auditShape(toAdminDto(row, 0)), baseVersion: versionOf(row.updatedAt) } : null;
  }

  async apply({ db, request, payload, checker }: ApplyContext<Update>) {
    const tx = dbOf(db);
    const cur = await load(tx, request.orgId, payload.id);
    if (!cur) throw new ChangeConflictError('product no longer exists');
    if (request.baseVersion !== null && request.baseVersion !== versionOf(cur.updatedAt)) throw new ChangeConflictError('product was changed after this request was submitted');
    const p = payload.product;
    const actorId = checker?.userId ?? request.makerId;
    const row = await tx.product.update({
      where: { id: cur.id },
      data: { ...editableColumns(p), documentChecklistJson: json(p.documentChecklist), collateralChecklistJson: json(p.collateralChecklist), haircutJson: json(p.haircut), updatedBy: actorId },
    });
    await auditChange(tx, request, checker, 'PRODUCT_UPDATED', row.id, auditShape(toAdminDto(cur, 0)), auditShape(toAdminDto(row, 0)));
    await afterNotice(tx, request, actorId, row.id);
  }
}

@Injectable()
export class ProductSetActiveHandler implements ChangeHandler<SetActive> {
  readonly targetType = PRODUCT_TARGET_TYPE;
  readonly action = PRODUCT_ACTION_SET_ACTIVE;
  readonly payloadSchema = ProductSetActivePayload as never as z.ZodType<SetActive, z.ZodTypeDef, unknown>;
  readonly makerRoles = ['ADMIN'] as const;
  readonly defaultPolicy = POLICY;
  constructor(@Inject(ChangeHandlerRegistry) registry: ChangeHandlerRegistry) { registry.register(this); }

  canonicalTargetId(p: SetActive) { return p.id; }

  async validate({ payload, actor, repo }: { payload: SetActive; actor: { orgId: string }; repo: ChangeRequestTx }) {
    const row = await load(repo.db as Prisma.TransactionClient, actor.orgId, payload.id);
    if (!row) throw new ChangeValidationError('Бүтээгдэхүүн олдсонгүй');
    if (row.isActive === payload.isActive) throw new ChangeValidationError(payload.isActive ? 'Бүтээгдэхүүн аль хэдийн идэвхтэй байна' : 'Бүтээгдэхүүн аль хэдийн идэвхгүй байна');
    if (!payload.isActive) {
      const active = await (repo.db as Prisma.TransactionClient).product.count({ where: { orgId: actor.orgId, isActive: true } });
      if (active <= 1) throw new ChangeValidationError('Сүүлчийн идэвхтэй бүтээгдэхүүнийг идэвхгүй болгох боломжгүй');
    }
  }

  async snapshot({ db, orgId, targetId }: SnapshotContext) {
    const row = await load(dbOf(db), orgId, targetId);
    return row ? { before: { isActive: row.isActive }, baseVersion: versionOf(row.updatedAt) } : null;
  }

  async apply({ db, request, payload, checker }: ApplyContext<SetActive>) {
    const tx = dbOf(db);
    const cur = await load(tx, request.orgId, payload.id);
    if (!cur) throw new ChangeConflictError('product no longer exists');
    if (request.baseVersion !== null && request.baseVersion !== versionOf(cur.updatedAt)) throw new ChangeConflictError('product was changed after this request was submitted');
    const actorId = checker?.userId ?? request.makerId;
    await tx.product.update({ where: { id: cur.id }, data: { isActive: payload.isActive, updatedBy: actorId } });
    await auditChange(tx, request, checker, payload.isActive ? 'PRODUCT_ACTIVATED' : 'PRODUCT_DEACTIVATED', cur.id, { isActive: cur.isActive, code: cur.code }, { isActive: payload.isActive, code: cur.code });
    await afterNotice(tx, request, actorId, cur.id);
  }
}
