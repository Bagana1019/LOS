// BsaSuspicionRepo-ийн Prisma хэрэгжүүлэлт (M12c). Дүн/огноо PII биш; гүйлгээг зөвхөн id-аар лавлана.
import type { Prisma } from './prisma.service';
import type { ReviewAction, ReviewStatus, SuspicionFlag } from '@los/contracts';
import type { BsaSuspicionRecord, BsaSuspicionRepo } from './bsa.repository';
import { BsaNotFoundError } from './bsa.repository';
import { inTx, pageOf, type Ctx } from './prisma-support';

type Row = Prisma.BsaSuspicionGetPayload<Record<string, never>>;

const toRecord = (r: Row): BsaSuspicionRecord => ({
  id: r.id,
  orgId: r.orgId,
  analysisId: r.analysisId,
  flag: r.flag as SuspicionFlag,
  detectKey: r.detectKey,
  transactionIds: r.transactionIds,
  confidence: r.confidence === null ? null : r.confidence.toNumber(),
  status: r.status as ReviewStatus,
  action: (r.action as ReviewAction | null) ?? null,
  newCategoryCode: r.newCategoryCode,
  comment: r.comment,
  resolvedBy: r.resolvedBy,
  resolvedAt: r.resolvedAt,
  createdAt: r.createdAt,
});

export function createSuspicionRepo(ctx: Ctx): BsaSuspicionRepo {
  return {
    async list(analysisId, filter, page) {
      const where: Prisma.BsaSuspicionWhereInput = { analysisId, ...(filter.status ? { status: filter.status } : {}), ...(filter.flag ? { flag: filter.flag } : {}) };
      return pageOf(
        page,
        () => ctx.db.bsaSuspicion.count({ where }),
        (p) => ctx.db.bsaSuspicion.findMany({ where, orderBy: [{ status: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }], ...p }),
        toRecord,
      );
    },

    async getMany(analysisId, ids) {
      const rows = await ctx.db.bsaSuspicion.findMany({ where: { analysisId, id: { in: [...ids] } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      return rows.map(toRecord);
    },

    async counts(analysisId) {
      const rows = await ctx.db.bsaSuspicion.groupBy({ by: ['flag', 'status'], where: { analysisId }, _count: { _all: true } });
      return rows.map((r) => ({ flag: r.flag as SuspicionFlag, status: r.status as ReviewStatus, count: r._count._all }));
    },

    countPending(analysisId) {
      return ctx.db.bsaSuspicion.count({ where: { analysisId, status: 'PENDING' } });
    },

    async sync(analysisId, detected, by) {
      return inTx(ctx, async (db) => {
        const analysis = await db.bsaAnalysis.findUnique({ where: { id: analysisId }, select: { orgId: true } });
        if (!analysis) throw new BsaNotFoundError('analysis', analysisId);
        const existing = await db.bsaSuspicion.findMany({ where: { analysisId }, select: { id: true, detectKey: true, status: true } });
        const have = new Set(existing.map((e) => e.detectKey));
        const want = new Set(detected.map((d) => d.detectKey));
        const at = ctx.now();

        const stale = existing.filter((e) => e.status === 'PENDING' && !want.has(e.detectKey)).map((e) => e.id);
        if (stale.length > 0) await db.bsaSuspicion.deleteMany({ where: { id: { in: stale } } });

        const fresh = detected.filter((d) => !have.has(d.detectKey));
        if (fresh.length > 0) {
          await db.bsaSuspicion.createMany({
            skipDuplicates: true,
            data: fresh.map((d) => ({
              orgId: analysis.orgId, analysisId, flag: d.flag, detectKey: d.detectKey, transactionIds: d.transactionIds, confidence: d.confidence,
              status: d.autoResolved ? 'RESOLVED' : 'PENDING', action: d.autoResolved ? 'EXCLUDE' : null, comment: d.comment ?? null,
              resolvedBy: null, resolvedAt: d.autoResolved ? at : null, createdAt: at, updatedAt: at, createdBy: by ?? null, updatedBy: by ?? null,
            })),
          });
        }
        const pending = await db.bsaSuspicion.count({ where: { analysisId, status: 'PENDING' } });
        return { created: fresh.length, removed: stale.length, pending };
      });
    },

    async resolve(analysisId, ids, patch) {
      const at = patch.at ?? ctx.now();
      const res = await ctx.db.bsaSuspicion.updateMany({
        where: { analysisId, id: { in: [...ids] }, status: 'PENDING' },
        data: {
          status: 'RESOLVED', action: patch.action, newCategoryCode: patch.newCategoryCode ?? null, comment: patch.comment ?? null,
          resolvedBy: patch.by, resolvedAt: at, updatedAt: at, updatedBy: patch.by,
        },
      });
      return res.count;
    },
  };
}
