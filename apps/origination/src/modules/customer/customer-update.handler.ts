// Эзэмшигчийн шийдвэр 2026-11-18 (хувилбар A): эзэмшигч бус салбар харилцагчийг шууд засахгүй — засварын хүсэлт илгээж,
// эзэмшигч салбарын захирал 4 нүдээр батална (docs/05-maker-checker.md §8). PII нь change_request-д шифрлэгдэж хадгалагдана.
import { Inject, Injectable } from '@nestjs/common';
import { z, type ZodIssue } from 'zod';
import { CUSTOMER_ACTION_UPDATE, CUSTOMER_TARGET_TYPE, CustomerEditPayload, type RequestContext } from '@los/contracts';
import { notFound } from '@los/nest-common';
import type { Prisma } from '.prisma/client-origination';
import type { Actor } from '../maker-checker/actor';
import { ChangeConflictError, ChangeHandlerRegistry, ChangeValidationError, type ApplyContext, type ChangeHandler, type SnapshotContext } from '../maker-checker/change-handler';
import type { ChangeRequestTx } from '../maker-checker/change-request.store';
import { err } from '../maker-checker/maker-checker.errors';
import { encryptedJsonCodec } from '../maker-checker/pii-codec';
import { CustomerService } from './customer.service';

/** Өөрчлөгдөх талбарын нэрс (PII-гүй) — inbox-ийн хураангуй ба `before`-ийн хүрээ */
export const touchedFields = (p: CustomerEditPayload): string[] =>
  [...new Set([...Object.keys(p.changes).filter((k) => (p.changes as Record<string, unknown>)[k] !== undefined), ...p.cleared])].sort();

const Uuid = z.string().uuid();
/** `@los/contracts`-ийн zod нь өөр instance байж болно (instanceof ZodError найдваргүй) — бүтцээр нь танина */
const zodIssues = (e: unknown): ZodIssue[] | null =>
  e instanceof Error && e.name === 'ZodError' && Array.isArray((e as { issues?: unknown }).issues) ? (e as unknown as { issues: ZodIssue[] }).issues : null;
const tx = (db: unknown) => db as Prisma.TransactionClient;

@Injectable()
export class CustomerUpdateChangeHandler implements ChangeHandler<CustomerEditPayload> {
  readonly targetType = CUSTOMER_TARGET_TYPE;
  readonly action = CUSTOMER_ACTION_UPDATE;
  readonly payloadSchema = CustomerEditPayload;
  /** `customer:write`-тэй цорын ганц дүр */
  readonly makerRoles = ['OFFICER'] as const;
  /** Эзэмшигч салбар л шийднэ: ADMIN/COMPLIANCE/APPROVER-т харилцагч засах эрх байхгүй, салбарт хамаарахгүй тул checker биш */
  readonly defaultPolicy = { enabled: true, checkerRoles: ['BRANCH_MANAGER'], expiresInHours: 72 } as const;
  /** Идэвхгүй болговол DIRECT горимд эзэмшигч салбарын дүрмийг тойрно — хориглоно */
  readonly alwaysFourEyes = true;
  /** payload `{changes, cleared}` ба before (талбар → одоогийн утга) хоёуланд — хураангуй нь зөвхөн талбарын нэрс */
  readonly codec = encryptedJsonCodec((v) => {
    const p = CustomerEditPayload.safeParse(v);
    return { fields: p.success ? touchedFields(p.data) : Object.keys((v ?? {}) as object).sort() };
  });

  constructor(
    @Inject(ChangeHandlerRegistry) registry: ChangeHandlerRegistry,
    @Inject(CustomerService) private readonly customers: CustomerService,
  ) {
    registry.register(this);
  }

  async validate({ payload, actor, repo, targetId }: { payload: CustomerEditPayload; actor: Actor; repo: ChangeRequestTx; targetId: string }) {
    if (!actor.branchId) throw err('FORBIDDEN', undefined, 'Салбаргүй хэрэглэгч харилцагчийн засварын хүсэлт илгээх боломжгүй');
    if (!Uuid.safeParse(targetId).success) throw notFound('Харилцагч', targetId);
    const row = await this.customers.findInTx(tx(repo.db), actor.orgId, targetId);
    if (!row) throw notFound('Харилцагч', targetId);
    if (row.branchId === null || row.branchId === actor.branchId) {
      throw new ChangeValidationError('Энэ харилцагчийг та шууд засах боломжтой — засварын хүсэлт шаардлагагүй', { directEdit: { method: 'PUT', path: `/api/origination/customers/${targetId}` } });
    }
    if (touchedFields(payload).length === 0) throw new ChangeValidationError('Өөрчлөх талбар алга');
    try {
      this.customers.previewMerge(row, payload.changes, payload.cleared); // PUT-тэй ижил FR-2.3 шалгалт, илгээх үед
    } catch (e) {
      const issues = zodIssues(e);
      if (issues) throw new ChangeValidationError('Засварын дараах харилцагчийн мэдээлэл бүрэн биш', issues.map((i) => ({ path: i.path, message: i.message })));
      throw e;
    }
  }

  async snapshot({ db, orgId, targetId, payload }: SnapshotContext) {
    const row = await this.customers.findInTx(tx(db), orgId, targetId);
    if (!row) return null;
    const fields = payload ? touchedFields(payload as CustomerEditPayload) : [];
    return { before: this.customers.currentFields(row, fields), baseVersion: row.updatedAt.toISOString(), scopeBranchId: row.branchId };
  }

  async apply({ db, request, payload, checker }: ApplyContext<CustomerEditPayload>) {
    const row = await this.customers.lockForUpdate(tx(db), request.orgId, request.targetId);
    if (!row) throw new ChangeConflictError('customer no longer exists');
    // Эзэмшигч салбар солигдсон бол хуучин салбарын захирал батлах эрхгүй болно → хүсэлт 72 цаг гацахаас сэргийлж хуучирсан гэж хаана
    if (row.branchId !== request.branchId) throw new ChangeConflictError('customer owning branch changed since the edit request was submitted');
    // Policy өргөжсөн ч эзэмшигч салбарын захирал л хэрэгжүүлнэ (шийдвэр A); tx буцаагдаж хүсэлт PENDING хэвээр
    if (!checker || !checker.roles.includes('BRANCH_MANAGER') || row.branchId === null || checker.branchId !== row.branchId) throw err('CHECKER_BRANCH_FORBIDDEN');
    // Хуучирсан бол хэрэгжүүлэхгүй: эзэмшигчийн сүүлийн засварыг дарахгүй (MC-BR-7)
    if (request.baseVersion !== null && row.updatedAt.toISOString() !== request.baseVersion) throw new ChangeConflictError('customer changed since the edit request was submitted');
    const ctx: RequestContext = { userId: checker.userId, roles: checker.roles, branchId: checker.branchId, orgId: request.orgId, customerId: null, correlationId: checker.correlationId };
    try {
      await this.customers.applyLockedUpdate(tx(db), ctx, row, payload.changes, payload.cleared);
    } catch (e) {
      if (zodIssues(e)) throw new ChangeConflictError('edit is no longer valid for the current customer data');
      throw e;
    }
  }
}
