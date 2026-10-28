// bsa_analysis-ийн Prisma хэрэгжүүлэлт. PII (харилцагчийн хураангуй, өөрийн данс) PiiCipher-ээр шифрлэгдэнэ (prisma-support.ts).
import { BsaDuplicateError, BsaNotFoundError, type BsaAnalysisRecord, type BsaAnalysisRepo } from './bsa.repository';
import {
  analysisFilterSchema, analysisPatchSchema, asArray, compareStrings, mergeAccounts, newAnalysisSchema, normalizeRegisterNo, toDbDate, validate,
} from './bsa.validation';
import { decJson, encJson, inTx, isPrismaCode, jsonOrDbNull, pageOf, scopeWhere, toAnalysis, type Ctx, type Db } from './prisma-support';
import type { Prisma } from './prisma.service';

const NEWEST = [{ createdAt: 'desc' }, { version: 'desc' }, { id: 'desc' }] as const;

export function createAnalysisRepo(ctx: Ctx): BsaAnalysisRepo {
  const registerHash = (registerNo: string | null | undefined): string | null => (registerNo ? ctx.cipher.hash(normalizeRegisterNo(registerNo)) : null);
  const snapshotCipher = (v: unknown): string | null => (v === null ? null : encJson(ctx, v));
  const accountsCipher = (a: readonly string[]): string | null => (a.length === 0 ? null : encJson(ctx, a));

  return {
    // INT-7: (org, application, customer) тутмын хувилбарыг advisory lock-оор дарааллуулж олгоно — зэрэгцээ create unique violation өгөхгүй
    async create(input) {
      const v = validate(newAnalysisSchema, input, 'analysis');
      const lockKey = JSON.stringify([v.orgId, v.applicationId, v.customerId]);
      try {
        return await inTx(ctx, async (db) => {
          await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
          const { _max } = await db.bsaAnalysis.aggregate({
            where: { orgId: v.orgId, applicationId: v.applicationId, customerId: v.customerId },
            _max: { version: true },
          });
          const at = ctx.now();
          const row = await db.bsaAnalysis.create({
            data: {
              orgId: v.orgId, branchId: v.branchId, applicationId: v.applicationId, customerId: v.customerId, borrowerId: v.borrowerId,
              status: 'DRAFT', version: (_max.version ?? 0) + 1,
              periodFrom: v.periodFrom && toDbDate(v.periodFrom), periodTo: v.periodTo && toDbDate(v.periodTo), periodMonths: v.periodMonths,
              proposedMonthlyPayment: v.proposedMonthlyPayment, costOfGoodsRate: v.costOfGoodsRate,
              customerSnapshotEncrypted: snapshotCipher(v.customer), registerNoHash: registerHash(v.customer?.registerNo),
              ownAccountsEncrypted: accountsCipher(v.ownAccounts),
              createdAt: at, updatedAt: at, createdBy: v.createdBy, updatedBy: v.createdBy,
            },
          });
          return toAnalysis(ctx, row);
        });
      } catch (e) {
        if (isPrismaCode(e, 'P2002')) throw new BsaDuplicateError('ANALYSIS_VERSION');
        throw e;
      }
    },

    async getById(id, scope) {
      const row = await ctx.db.bsaAnalysis.findFirst({ where: { id, ...scopeWhere(scope) } });
      return row ? toAnalysis(ctx, row) : null;
    },

    async findLatest(orgId, applicationId, customerId) {
      const row = await ctx.db.bsaAnalysis.findFirst({ where: { orgId, applicationId, customerId }, orderBy: { version: 'desc' } });
      return row ? toAnalysis(ctx, row) : null;
    },

    async listLatestByApplication(orgId, applicationId) {
      const rows = await ctx.db.bsaAnalysis.findMany({ where: { orgId, applicationId }, orderBy: [{ version: 'desc' }] });
      const latest = new Map<string, (typeof rows)[number]>();
      for (const r of rows) if (!latest.has(r.customerId)) latest.set(r.customerId, r);
      return [...latest.values()].sort((a, b) => compareStrings(a.customerId, b.customerId)).map((r) => toAnalysis(ctx, r));
    },

    async list(filter, page) {
      const f = validate(analysisFilterSchema, filter, 'filter');
      const statuses = asArray(f.status);
      const where: Prisma.BsaAnalysisWhereInput = {
        orgId: f.orgId,
        ...(f.branchId ? { branchId: f.branchId } : {}),
        ...(statuses ? { status: { in: statuses } } : {}),
        ...(f.applicationId ? { applicationId: f.applicationId } : {}),
        ...(f.customerId ? { customerId: f.customerId } : {}),
        ...(f.registerNo ? { registerNoHash: registerHash(f.registerNo) } : {}),
        ...(f.createdBy ? { createdBy: f.createdBy } : {}),
        ...(f.createdFrom || f.createdTo ? { createdAt: { ...(f.createdFrom ? { gte: f.createdFrom } : {}), ...(f.createdTo ? { lt: f.createdTo } : {}) } } : {}),
      };
      return pageOf(page, () => ctx.db.bsaAnalysis.count({ where }), (p) => ctx.db.bsaAnalysis.findMany({ where, orderBy: [...NEWEST], ...p }), (r) => toAnalysis(ctx, r));
    },

    async update(id, patch, updatedBy) {
      const p = validate(analysisPatchSchema, patch, 'patch');
      const data: Prisma.BsaAnalysisUpdateInput = { updatedAt: ctx.now(), updatedBy: updatedBy ?? null };
      if (p.branchId !== undefined) data.branchId = p.branchId;
      if (p.borrowerId !== undefined) data.borrowerId = p.borrowerId;
      if (p.status !== undefined) data.status = p.status;
      if (p.periodFrom !== undefined) data.periodFrom = p.periodFrom && toDbDate(p.periodFrom);
      if (p.periodTo !== undefined) data.periodTo = p.periodTo && toDbDate(p.periodTo);
      if (p.periodMonths !== undefined) data.periodMonths = p.periodMonths;
      if (p.proposedMonthlyPayment !== undefined) data.proposedMonthlyPayment = p.proposedMonthlyPayment;
      if (p.costOfGoodsRate !== undefined) data.costOfGoodsRate = p.costOfGoodsRate;
      if (p.summary !== undefined) data.summaryJson = jsonOrDbNull(p.summary);
      if (p.customer !== undefined) {
        data.customerSnapshotEncrypted = snapshotCipher(p.customer);
        data.registerNoHash = registerHash(p.customer?.registerNo);
      }
      if (p.ownAccounts !== undefined) data.ownAccountsEncrypted = accountsCipher(p.ownAccounts);
      if (p.analyzedAt !== undefined) data.analyzedAt = p.analyzedAt;
      if (p.pushedToLosAt !== undefined) data.pushedToLosAt = p.pushedToLosAt;
      // branch_id хүүхэд хүснэгтэд давхар хадгалагддаг (салбарын хязгаар) → салбар солигдвол хамт шинэчилнэ
      const movesBranch = p.branchId !== undefined;
      const write = async (db: Db): Promise<BsaAnalysisRecord> => {
        const row = await db.bsaAnalysis.update({ where: { id }, data });
        if (movesBranch) {
          const children = { where: { analysisId: id }, data: { branchId: p.branchId } };
          await db.bsaImportJob.updateMany(children);
          await db.bsaTransaction.updateMany(children);
          await db.bsaAnalysisEvent.updateMany(children);
        }
        return toAnalysis(ctx, row);
      };
      try {
        return await (movesBranch ? inTx(ctx, write) : write(ctx.db));
      } catch (e) {
        if (isPrismaCode(e, 'P2025')) throw new BsaNotFoundError('analysis', id);
        throw e;
      }
    },

    // Мөрийг түгжиж (FOR UPDATE) уншаад нэгтгэнэ — зэрэгцээ хоёр импорт бие биенийхээ данг дарахгүй
    async addOwnAccounts(id, accounts, updatedBy) {
      return inTx(ctx, async (db) => {
        const rows = await db.$queryRaw<Array<{ own_accounts_encrypted: string | null }>>`
          SELECT own_accounts_encrypted FROM "scoring"."bsa_analysis" WHERE id = ${id} FOR UPDATE`;
        if (rows.length === 0) throw new BsaNotFoundError('analysis', id);
        const current = decJson<string[]>(ctx, rows[0].own_accounts_encrypted) ?? [];
        const merged = mergeAccounts(current, accounts);
        if (merged.length === current.length) return current;
        await db.bsaAnalysis.update({ where: { id }, data: { ownAccountsEncrypted: encJson(ctx, merged), updatedAt: ctx.now(), updatedBy: updatedBy ?? null } });
        return merged;
      });
    },
  };
}
