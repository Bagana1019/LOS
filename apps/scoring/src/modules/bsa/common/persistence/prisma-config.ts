// Өөрчлөлтийн түүх (bsa_analysis_event), ангилал/дүрмийн сан (bsa_category, bsa_rule), retention (BSA-BR-8) — Prisma хэрэгжүүлэлт.
import {
  BsaDuplicateError, BsaInvalidError, BsaNotFoundError, type BsaConfigRepo, type BsaEventRepo, type BsaRetentionRepo,
} from './bsa.repository';
import { compareStrings, newEventSchema, newRuleSchema, validate } from './bsa.validation';
import { inTx, isPrismaCode, jsonOrDbNull, pageOf, toCategory, toEvent, toRule, type Ctx } from './prisma-support';

export function createEventRepo(ctx: Ctx): BsaEventRepo {
  return {
    async append(input) {
      const v = validate(newEventSchema, input, 'event');
      const analysis = await ctx.db.bsaAnalysis.findUnique({ where: { id: v.analysisId }, select: { orgId: true, branchId: true } });
      if (!analysis) throw new BsaNotFoundError('analysis', v.analysisId);
      const at = ctx.now();
      const row = await ctx.db.bsaAnalysisEvent.create({
        data: {
          analysisId: v.analysisId, orgId: analysis.orgId, branchId: analysis.branchId, at: v.at ?? at, actorId: v.actorId, action: v.action,
          detailJson: jsonOrDbNull(v.detail), createdAt: at, updatedAt: at, createdBy: v.actorId, updatedBy: v.actorId,
        },
      });
      return toEvent(row);
    },
    async list(analysisId, page) {
      const where = { analysisId };
      return pageOf(
        page,
        () => ctx.db.bsaAnalysisEvent.count({ where }),
        (p) => ctx.db.bsaAnalysisEvent.findMany({ where, orderBy: [{ at: 'desc' }, { id: 'desc' }], ...p }),
        toEvent,
      );
    },
  };
}

export function createConfigRepo(ctx: Ctx): BsaConfigRepo {
  return {
    async listCategories(orgId) {
      const rows = await ctx.db.bsaCategory.findMany({ where: { orgId } });
      return rows.map(toCategory).sort((a, b) => compareStrings(a.code, b.code));
    },
    async listRules(orgId) {
      const rows = await ctx.db.bsaRule.findMany({ where: { orgId, isActive: true }, orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }] });
      return rows.map(toRule);
    },
    async createRule(orgId, rule, createdBy) {
      const v = validate(newRuleSchema, rule, 'rule');
      return inTx(ctx, async (db) => {
        const cat = await db.bsaCategory.findUnique({ where: { orgId_code: { orgId, code: v.categoryCode } } });
        if (!cat || cat.direction !== v.direction) throw new BsaInvalidError('categoryCode', cat ? 'direction_mismatch' : 'unknown_category');
        const at = ctx.now();
        try {
          const row = await db.bsaRule.create({
            data: { orgId, ...v, createdAt: at, updatedAt: at, createdBy: createdBy ?? null, updatedBy: createdBy ?? null },
          });
          return toRule(row);
        } catch (e) {
          if (isPrismaCode(e, 'P2002')) throw new BsaDuplicateError('RULE');
          throw e;
        }
      });
    },
    async setRuleActive(orgId, ruleId, isActive, updatedBy) {
      const res = await ctx.db.bsaRule.updateMany({ where: { id: ruleId, orgId }, data: { isActive, updatedAt: ctx.now(), updatedBy: updatedBy ?? null } });
      if (res.count === 0) throw new BsaNotFoundError('rule', ruleId);
    },
  };
}

export function createRetentionRepo(ctx: Ctx): BsaRetentionRepo {
  return {
    async findExpired(cutoff, limit, orgId) {
      if (!Number.isInteger(limit) || limit < 1) throw new BsaInvalidError('limit', 'invalid_type');
      const rows = await ctx.db.bsaAnalysis.findMany({
        where: { createdAt: { lt: cutoff }, ...(orgId ? { orgId } : {}) },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit,
        select: { id: true, orgId: true, applicationId: true, createdAt: true },
      });
      return rows;
    },
    // FK-ийн ON DELETE CASCADE нь ажил/гүйлгээ/түүхийг хамт устгана; тоог устгахаас өмнө авна
    async purge(analysisId) {
      return inTx(ctx, async (db) => {
        const analysis = await db.bsaAnalysis.findUnique({ where: { id: analysisId }, select: { id: true } });
        if (!analysis) throw new BsaNotFoundError('analysis', analysisId);
        const [jobs, transactions, events] = await Promise.all([
          db.bsaImportJob.findMany({ where: { analysisId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { fileId: true } }),
          db.bsaTransaction.count({ where: { analysisId } }),
          db.bsaAnalysisEvent.count({ where: { analysisId } }),
        ]);
        await db.bsaAnalysis.delete({ where: { id: analysisId } });
        return { analysisId, objectKeys: jobs.map((j) => j.fileId), counts: { importJobs: jobs.length, transactions, events } };
      });
    },
  };
}
