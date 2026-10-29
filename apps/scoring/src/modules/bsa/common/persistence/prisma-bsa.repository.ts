// BsaRepository-ийн PostgreSQL (Prisma) хэрэгжүүлэлт. PII-г зөвхөн энд PiiCipher-ээр шифрлэнэ/тайлна (NFR-3); Prisma-ийн төрөл гадагш гарахгүй.
// Бүтэц: group тутмын хэрэгжүүлэлт prisma-*.ts, нийтлэг туслах prisma-support.ts, оролтын баталгаажуулалт bsa.validation.ts.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { PII_CIPHER, type PiiCipher } from '../infra.ports';
import type { BsaRepository } from './bsa.repository';
import { createAnalysisRepo } from './prisma-analyses';
import { createConfigRepo, createEventRepo, createRetentionRepo } from './prisma-config';
import { createImportJobRepo } from './prisma-import-jobs';
import {
  BSA_REPOSITORY_OPTIONS, PRISMA_BSA_REPOSITORY_DEFAULTS, type Ctx, type Db, type PrismaBsaRepositoryOptions,
} from './prisma-support';
import { createTransactionRepo } from './prisma-transactions';
import { PrismaService, type PrismaClient } from './prisma.service';

/** Контекст (клиент эсвэл транзакцийн клиент)-д холбогдсон repository. Транзакц дотор үүсэхдээ `ctx.root = null` */
class PrismaBsaCore implements BsaRepository {
  readonly analyses: BsaRepository['analyses'];
  readonly importJobs: BsaRepository['importJobs'];
  readonly transactions: BsaRepository['transactions'];
  readonly events: BsaRepository['events'];
  readonly config: BsaRepository['config'];
  readonly retention: BsaRepository['retention'];

  constructor(protected readonly ctx: Ctx) {
    this.analyses = createAnalysisRepo(ctx);
    this.importJobs = createImportJobRepo(ctx);
    this.transactions = createTransactionRepo(ctx);
    this.events = createEventRepo(ctx);
    this.config = createConfigRepo(ctx);
    this.retention = createRetentionRepo(ctx);
  }

  /** Nested дуудлага (ctx.root = null) гадаад транзакцдаа нэгдэнэ. `tx` нь Prisma транзакцийн клиент (outbox бичихэд) */
  runInTransaction<T>(fn: (repo: BsaRepository, tx: unknown) => Promise<T>): Promise<T> {
    const { ctx } = this;
    if (!ctx.root) return fn(this, ctx.db);
    const opts = { timeout: ctx.opts.transactionTimeoutMs, maxWait: ctx.opts.transactionMaxWaitMs };
    return ctx.root.$transaction((tx: Db) => fn(new PrismaBsaCore({ ...ctx, db: tx, root: null }), tx), opts);
  }
}

@Injectable()
export class PrismaBsaRepository extends PrismaBsaCore {
  constructor(
    @Inject(PrismaService) prisma: PrismaClient,
    @Inject(PII_CIPHER) cipher: PiiCipher,
    @Optional() @Inject(BSA_REPOSITORY_OPTIONS) opts?: PrismaBsaRepositoryOptions,
  ) {
    super({ db: prisma, root: prisma, cipher, now: opts?.now ?? (() => new Date()), opts: { ...PRISMA_BSA_REPOSITORY_DEFAULTS, ...stripUndefined(opts) } });
  }
}

const stripUndefined = (o?: PrismaBsaRepositoryOptions): Partial<Ctx['opts']> => {
  const { now: _now, ...rest } = o ?? {};
  return Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
};
