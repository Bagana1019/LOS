// bsa_transaction-ийн Prisma хэрэгжүүлэлт. Утга, харьцсан данс/нэр шифрлэгдэнэ → тэдгээрээр SQL-д хайхгүй (text шүүлт програмд).
import {
  BsaInvalidError, BsaNotFoundError, MANUAL_OVERRIDE_CONFIDENCE, type BsaTransactionCounts, type BsaTransactionRepo, type BsaTransactionSort,
} from './bsa.repository';
import { matchesText, textNeedle } from './bsa.query';
import {
  asArray, classificationUpdateSchema, compareStrings, newTxnSchema, resolvePage, toDbDate, txnFilterSchema, validate,
} from './bsa.validation';
import { chunks, enc, inTx, pageOf, toTxn, type Ctx } from './prisma-support';
import { Prisma } from './prisma.service';

/** bsa.query.ts-ийн txnComparator-той ЯГ ИЖИЛ эрэмбэ: txn_time хоосон нь DATE_ASC-д түрүүлж, DATE_DESC-д сүүлд */
function orderBy(sort: BsaTransactionSort = 'DATE_ASC'): Prisma.BsaTransactionOrderByWithRelationInput[] {
  const dateAsc: Prisma.BsaTransactionOrderByWithRelationInput[] = [{ txnDate: 'asc' }, { txnTime: { sort: 'asc', nulls: 'first' } }, { seq: 'asc' }, { id: 'asc' }];
  switch (sort) {
    case 'DATE_DESC':
      return [{ txnDate: 'desc' }, { txnTime: { sort: 'desc', nulls: 'last' } }, { seq: 'desc' }, { id: 'desc' }];
    case 'AMOUNT_ASC':
      return [{ amount: 'asc' }, ...dateAsc];
    case 'AMOUNT_DESC':
      return [{ amount: 'desc' }, ...dateAsc];
    default:
      return dateAsc;
  }
}

export function createTransactionRepo(ctx: Ctx): BsaTransactionRepo {
  return {
    // Нэг транзакцид: бүх chunk эсвэл юу ч биш. createMany + skipDuplicates = INSERT … ON CONFLICT DO NOTHING (багц доторх давхардлыг ч алгасна)
    async bulkInsert(importJobId, rows, createdBy) {
      const parsed = rows.map((r, i) => validate(newTxnSchema, r, `rows.${i}`));
      return inTx(ctx, async (db) => {
        const job = await db.bsaImportJob.findUnique({ where: { id: importJobId }, select: { analysisId: true, orgId: true, branchId: true } });
        if (!job) throw new BsaNotFoundError('import_job', importJobId);
        const at = ctx.now();
        let inserted = 0;
        for (const part of chunks(parsed, ctx.opts.insertChunkSize)) {
          const res = await db.bsaTransaction.createMany({
            skipDuplicates: true,
            data: part.map((r) => ({
              analysisId: job.analysisId, importJobId, orgId: job.orgId, branchId: job.branchId, seq: r.seq, txnDate: toDbDate(r.txnDate), txnTime: r.txnTime,
              direction: r.direction, amount: r.amount, balanceAfter: r.balanceAfter, descriptionEncrypted: ctx.cipher.encrypt(r.description),
              counterpartyAccountEncrypted: enc(ctx, r.counterpartyAccount), counterpartyNameEncrypted: enc(ctx, r.counterpartyName), channel: r.channel,
              categoryCode: r.categoryCode, categoryGroup: r.categoryGroup, confidence: r.confidence, isOwnTransfer: r.isOwnTransfer, statementKey: r.statementKey,
              dedupeKey: r.dedupeKey, createdAt: at, updatedAt: at, createdBy: createdBy ?? null, updatedBy: createdBy ?? null,
            })),
          });
          inserted += res.count;
        }
        return { inserted, skipped: parsed.length - inserted };
      });
    },

    async list(filter, page) {
      const f = validate(txnFilterSchema, filter, 'filter');
      const channels = asArray(f.channel);
      const where: Prisma.BsaTransactionWhereInput = {
        analysisId: f.analysisId,
        ...(f.importJobId ? { importJobId: f.importJobId } : {}),
        ...(f.dateFrom || f.dateTo ? { txnDate: { ...(f.dateFrom ? { gte: toDbDate(f.dateFrom) } : {}), ...(f.dateTo ? { lte: toDbDate(f.dateTo) } : {}) } } : {}),
        ...(f.direction ? { direction: f.direction } : {}),
        ...(f.categoryCodes ? { categoryCode: { in: f.categoryCodes } } : {}),
        ...(channels ? { channel: { in: channels } } : {}),
        ...(f.ownTransfer !== undefined ? { isOwnTransfer: f.ownTransfer } : {}),
        ...(f.manualOverride !== undefined ? { manualOverride: f.manualOverride } : {}),
        ...(f.amountMin !== undefined || f.amountMax !== undefined
          ? { amount: { ...(f.amountMin !== undefined ? { gte: f.amountMin } : {}), ...(f.amountMax !== undefined ? { lte: f.amountMax } : {}) } }
          : {}),
      };
      const order = orderBy(f.sort);
      const needle = textNeedle(f.text);
      if (needle === null) {
        return pageOf(page, () => ctx.db.bsaTransaction.count({ where }), (p) => ctx.db.bsaTransaction.findMany({ where, orderBy: order, ...p }), (r) => toTxn(ctx, r));
      }
      // Шифрлэгдсэн талбарт SQL-ээр хайх боломжгүй: бусад шүүлтэнд таарсан (нэг шинжилгээний) мөрүүдийг тайлж програмд шүүнэ
      const { limit, offset } = resolvePage(page);
      const hits = (await ctx.db.bsaTransaction.findMany({ where, orderBy: order })).map((r) => toTxn(ctx, r)).filter((t) => matchesText(t, needle));
      return { items: hits.slice(offset, offset + limit), total: hits.length, limit, offset };
    },

    async loadAll(analysisId) {
      const rows = await ctx.db.bsaTransaction.findMany({ where: { analysisId }, orderBy: orderBy('DATE_ASC') });
      return rows.map((r) => toTxn(ctx, r));
    },

    // Нэг UPDATE … FROM unnest(…): 5k мөрийг нэг дуудлагаар (мөр тутамд UPDATE биш). Гар засвартай мөрийг оролдохгүй
    async updateClassifications(analysisId, updates, updatedBy) {
      const byId = new Map(updates.map((u, i) => [u.id, validate(classificationUpdateSchema, u, `updates.${i}`)]));
      const list = [...byId.values()];
      return inTx(ctx, async (db) => {
        let updated = 0;
        const at = ctx.now();
        for (const part of chunks(list, 5000)) {
          updated += await db.$executeRaw`
            UPDATE "scoring"."bsa_transaction" AS t
            SET category_code = v.category_code, category_group = v.category_group, confidence = v.confidence, channel = v.channel,
                is_own_transfer = v.is_own_transfer, updated_at = ${at}, updated_by = ${updatedBy ?? null}
            FROM unnest(
              ${part.map((u) => u.id)}::text[], ${part.map((u) => u.categoryCode)}::text[], ${part.map((u) => u.categoryGroup)}::text[],
              ${part.map((u) => u.confidence)}::numeric[], ${part.map((u) => u.channel)}::text[], ${part.map((u) => u.isOwnTransfer)}::boolean[]
            ) AS v(id, category_code, category_group, confidence, channel, is_own_transfer)
            WHERE t.id = v.id AND t.analysis_id = ${analysisId} AND NOT t.manual_override`;
        }
        return { updated, skipped: list.length - updated };
      });
    },

    async setManualCategory(analysisId, ids, categoryCode, by) {
      return inTx(ctx, async (db) => {
        const analysis = await db.bsaAnalysis.findUnique({ where: { id: analysisId }, select: { orgId: true } });
        if (!analysis) throw new BsaNotFoundError('analysis', analysisId);
        const cat = await db.bsaCategory.findUnique({ where: { orgId_code: { orgId: analysis.orgId, code: categoryCode } } });
        if (!cat || !cat.isActive) throw new BsaInvalidError('categoryCode', 'unknown_category');
        const where: Prisma.BsaTransactionWhereInput = { analysisId, id: { in: [...ids] } };
        if ((await db.bsaTransaction.count({ where: { ...where, direction: { not: cat.direction } } })) > 0) throw new BsaInvalidError('categoryCode', 'direction_mismatch');
        const res = await db.bsaTransaction.updateMany({
          where,
          data: {
            categoryCode, categoryGroup: cat.groupCode, confidence: MANUAL_OVERRIDE_CONFIDENCE, isOwnTransfer: false, manualOverride: true, overrideBy: by,
            updatedAt: ctx.now(), updatedBy: by,
          },
        });
        return res.count;
      });
    },

    async deleteByJob(importJobId) {
      return (await ctx.db.bsaTransaction.deleteMany({ where: { importJobId } })).count;
    },

    async counts(analysisId): Promise<BsaTransactionCounts> {
      const [totals, byCategory, byJob] = await Promise.all([
        ctx.db.$queryRaw<Array<Record<'total' | 'income' | 'own' | 'manual' | 'unclassified', number>>>`
          SELECT count(*)::int AS total, (count(*) FILTER (WHERE direction = 'INCOME'))::int AS income,
                 (count(*) FILTER (WHERE is_own_transfer))::int AS own, (count(*) FILTER (WHERE manual_override))::int AS manual,
                 (count(*) FILTER (WHERE category_code IS NULL))::int AS unclassified
          FROM "scoring"."bsa_transaction" WHERE analysis_id = ${analysisId}`,
        ctx.db.bsaTransaction.groupBy({ by: ['categoryCode', 'direction'], where: { analysisId, categoryCode: { not: null } }, _count: { _all: true } }),
        ctx.db.bsaTransaction.groupBy({ by: ['importJobId'], where: { analysisId }, _count: { _all: true } }),
      ]);
      const t = totals[0];
      return {
        total: t.total, income: t.income, expense: t.total - t.income, ownTransfers: t.own, manualOverrides: t.manual, unclassified: t.unclassified,
        byCategory: byCategory
          .map((g) => ({ categoryCode: g.categoryCode as string, direction: g.direction as 'INCOME' | 'EXPENSE', count: g._count._all }))
          .sort((a, b) => compareStrings(a.categoryCode, b.categoryCode) || compareStrings(a.direction, b.direction)),
        byImportJob: byJob.map((g) => ({ importJobId: g.importJobId, count: g._count._all })).sort((a, b) => compareStrings(a.importJobId, b.importJobId)),
      };
    },
  };
}
