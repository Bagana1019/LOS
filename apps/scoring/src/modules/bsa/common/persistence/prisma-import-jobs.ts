// bsa_import_job-ийн Prisma хэрэгжүүлэлт. Файлын нэр, данс, IBAN, эзэмшигчийн нэр шифрлэгдэнэ.
import { BsaDuplicateError, BsaInvalidError, BsaNotFoundError, type BsaImportJobRepo, type ImportJobStatus } from './bsa.repository';
import { asArray, jobFilterSchema, jobPatchSchema, newJobSchema, toDbDate, validate } from './bsa.validation';
import { enc, inTx, isPrismaCode, jsonOrDbNull, pageOf, scopeWhere, toJob, type Ctx } from './prisma-support';
import type { Prisma } from './prisma.service';

const NEWEST = [{ createdAt: 'desc' }, { id: 'desc' }] as const;

export function createImportJobRepo(ctx: Ctx): BsaImportJobRepo {
  const whereOf = (raw: unknown): Prisma.BsaImportJobWhereInput => {
    const f = validate(jobFilterSchema, raw, 'filter');
    const statuses = asArray(f.status);
    return {
      ...(f.orgId ? { orgId: f.orgId } : {}),
      ...(f.branchId ? { branchId: f.branchId } : {}),
      ...(f.analysisId ? { analysisId: f.analysisId } : {}),
      ...(statuses ? { status: { in: statuses } } : {}),
      ...(f.bankCode ? { bankCode: f.bankCode } : {}),
    };
  };

  return {
    async create(input) {
      const v = validate(newJobSchema, input, 'job');
      return inTx(ctx, async (db) => {
        const analysis = await db.bsaAnalysis.findUnique({ where: { id: v.analysisId }, select: { orgId: true, branchId: true } });
        if (!analysis) throw new BsaNotFoundError('analysis', v.analysisId);
        // Урьдчилан шалгана: транзакц дотор unique violation гарвал транзакц бүхэлдээ таслагдана
        const dup = await db.bsaImportJob.findUnique({ where: { analysisId_sha256: { analysisId: v.analysisId, sha256: v.sha256 } }, select: { id: true } });
        if (dup) throw new BsaDuplicateError('IMPORT_FILE', dup.id);
        const at = ctx.now();
        try {
          const row = await db.bsaImportJob.create({
            data: {
              orgId: analysis.orgId, branchId: analysis.branchId, analysisId: v.analysisId, fileId: v.fileId, fileNameEncrypted: ctx.cipher.encrypt(v.fileName),
              mimeType: v.mimeType, sizeBytes: v.sizeBytes, sha256: v.sha256, bankCode: v.bankCode, format: v.format, errorsJson: [], warningsJson: [],
              createdAt: at, updatedAt: at, createdBy: v.createdBy, updatedBy: v.createdBy,
            },
          });
          return toJob(ctx, row);
        } catch (e) {
          if (isPrismaCode(e, 'P2002')) throw new BsaDuplicateError('IMPORT_FILE');
          throw e;
        }
      });
    },

    async getById(id, scope) {
      const row = await ctx.db.bsaImportJob.findFirst({ where: { id, ...scopeWhere(scope) } });
      return row ? toJob(ctx, row) : null;
    },

    async findBySha256(analysisId, sha256) {
      const row = await ctx.db.bsaImportJob.findUnique({ where: { analysisId_sha256: { analysisId, sha256: sha256.toLowerCase() } } });
      return row ? toJob(ctx, row) : null;
    },

    async list(filter, page) {
      const where = whereOf(filter);
      return pageOf(page, () => ctx.db.bsaImportJob.count({ where }), (p) => ctx.db.bsaImportJob.findMany({ where, orderBy: [...NEWEST], ...p }), (r) => toJob(ctx, r));
    },

    async countByStatus(filter) {
      const groups = await ctx.db.bsaImportJob.groupBy({ by: ['status'], where: whereOf(filter), _count: { _all: true } });
      const out: Record<ImportJobStatus, number> = { PENDING: 0, PROCESSING: 0, COMPLETED: 0, FAILED: 0 };
      for (const g of groups) out[g.status as ImportJobStatus] = g._count._all;
      return out;
    },

    async update(id, patch, updatedBy) {
      const p = validate(jobPatchSchema, patch, 'patch');
      const data: Prisma.BsaImportJobUpdateInput = { updatedAt: ctx.now(), updatedBy: updatedBy ?? null };
      if (p.status !== undefined) data.status = p.status;
      if (p.bankCode !== undefined) data.bankCode = p.bankCode;
      if (p.format !== undefined) data.format = p.format;
      if (p.accountNo !== undefined) data.accountNoEncrypted = enc(ctx, p.accountNo);
      if (p.iban !== undefined) data.ibanEncrypted = enc(ctx, p.iban);
      if (p.holderName !== undefined) data.holderNameEncrypted = enc(ctx, p.holderName);
      if (p.periodFrom !== undefined) data.periodFrom = p.periodFrom && toDbDate(p.periodFrom);
      if (p.periodTo !== undefined) data.periodTo = p.periodTo && toDbDate(p.periodTo);
      if (p.rowsTotal !== undefined) data.rowsTotal = p.rowsTotal;
      if (p.rowsDone !== undefined) data.rowsDone = p.rowsDone;
      if (p.errors !== undefined) data.errorsJson = jsonOrDbNull(p.errors);
      if (p.warnings !== undefined) data.warningsJson = jsonOrDbNull(p.warnings);
      if (p.parserOk !== undefined) data.parserOk = p.parserOk;
      if (p.verifierOk !== undefined) data.verifierOk = p.verifierOk;
      if (p.qrVerified !== undefined) data.qrVerified = p.qrVerified;
      if (p.attempts !== undefined) data.attempts = p.attempts;
      if (p.startedAt !== undefined) data.startedAt = p.startedAt;
      if (p.finishedAt !== undefined) data.finishedAt = p.finishedAt;
      try {
        return toJob(ctx, await ctx.db.bsaImportJob.update({ where: { id }, data }));
      } catch (e) {
        if (isPrismaCode(e, 'P2025')) throw new BsaNotFoundError('import_job', id);
        throw e;
      }
    },

    // rows_done = rows_done + delta нэг UPDATE-д (read-modify-write биш) → зэрэгцээ дуудлага алдагдахгүй
    async incrementRowsDone(id, delta) {
      if (!Number.isInteger(delta) || delta < 0) throw new BsaInvalidError('delta', 'invalid_type');
      try {
        return toJob(ctx, await ctx.db.bsaImportJob.update({ where: { id }, data: { rowsDone: { increment: delta }, updatedAt: ctx.now() } }));
      } catch (e) {
        if (isPrismaCode(e, 'P2025')) throw new BsaNotFoundError('import_job', id);
        throw e;
      }
    },
  };
}
