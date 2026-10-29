import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { BasePriceImportRequest, BasePriceInput, BasePriceListQuery, BasePriceView, RequestContext } from '@los/contracts';
import { Clock, DomainError } from '@los/nest-common';
import { dbDate, isRealIsoDate, toIsoDate, todayUb } from '../../common/dates';
import { advisoryLock } from '../../common/locks';
import { canonicalKey, keyMatchesAssetType, stableKey } from './base-price.keys';
import { BasePriceRepository, type BasePriceRow } from './base-price.repository';

export interface BasePriceImportResult {
  created: number;
  byAssetType: Record<string, number>;
}

interface ImportIssue {
  index: number;
  code: 'BASE_PRICE_KEY_MISMATCH' | 'BASE_PRICE_DATE_INVALID' | 'BASE_PRICE_DUPLICATE';
  message: string;
}
const MAX_REPORTED_ISSUES = 50;

const KEY_MISMATCH_MESSAGE = 'Суурь үнийн түлхүүр хөрөнгийн төрөлд тохирохгүй байна';
const DATE_INVALID_MESSAGE = 'Хүчинтэй эхлэх огноо буруу (YYYY-MM-DD, бодит өдөр байх ёстой)';

export function toView(r: BasePriceRow): BasePriceView {
  return {
    id: r.id,
    assetType: r.assetType as BasePriceView['assetType'],
    key: r.keyJson as Record<string, unknown>,
    unitPrice: Number(r.unitPrice),
    validFrom: toIsoDate(r.validFrom),
    version: r.version,
    createdAt: r.createdAt.toISOString(),
    createdBy: r.createdBy,
  };
}

/** FR-14.1, FR-14.5 — base price list with versions. A change is a NEW version of the same key; old versions stay (history). */
@Injectable()
export class BasePriceService {
  private readonly logger = new Logger(BasePriceService.name);

  constructor(
    @Inject(BasePriceRepository) private readonly repo: BasePriceRepository,
    @Inject(Clock) private readonly clock: Clock,
  ) {}

  /** Default: the effective version of every key (highest version whose `valid_from` has been reached). `history`: every version. */
  async list(ctx: RequestContext, query: BasePriceListQuery): Promise<BasePriceView[]> {
    const today = dbDate(todayUb(this.clock.now()));
    const rows = await this.repo.list(ctx.orgId, query.assetType, query.history ? undefined : today);
    const keyed = rows.map((r) => ({ r, k: `${r.assetType}|${stableKey(r.keyJson)}` }));
    const seen = new Set<string>();
    // Rows arrive newest version first, so the first row of a key is its effective version.
    const picked = query.history ? keyed : keyed.filter(({ k }) => !seen.has(k) && seen.add(k));
    const byKeyThenNewest = (a: (typeof keyed)[number], b: (typeof keyed)[number]): number =>
      a.k < b.k ? -1 : a.k > b.k ? 1 : b.r.version - a.r.version;
    return picked.sort(byKeyThenNewest).map(({ r }) => toView(r));
  }

  async create(ctx: RequestContext, input: BasePriceInput): Promise<BasePriceView> {
    this.validate(input);
    const key = canonicalKey(input.key);
    const row = await this.repo.transaction(async (tx) => {
      await advisoryLock(tx, 'base_price', ctx.orgId, input.assetType);
      const version = (await this.repo.maxVersion(tx, ctx.orgId, input.assetType, key)) + 1;
      return this.repo.create(tx, { orgId: ctx.orgId, assetType: input.assetType, key, unitPrice: input.unitPrice, validFrom: dbDate(input.validFrom), version, createdBy: ctx.userId });
    });
    this.logger.log(`base_price_created assetType=${input.assetType} version=${row.version}`);
    return toView(row);
  }

  /** All or nothing: any invalid item rejects the whole batch (422 with the item indexes), nothing is written. */
  async import(ctx: RequestContext, body: BasePriceImportRequest): Promise<BasePriceImportResult> {
    const issues: ImportIssue[] = [];
    const seen = new Map<string, number>();
    const items = body.items.map((item, index) => {
      const problem = this.problemOf(item);
      if (problem) {
        issues.push({ index, ...problem });
        return null;
      }
      const key = canonicalKey(item.key);
      const dup = `${item.assetType}|${stableKey(key)}|${item.validFrom}`;
      const first = seen.get(dup);
      if (first !== undefined) issues.push({ index, code: 'BASE_PRICE_DUPLICATE', message: `Ижил түлхүүр, ижил огнооны үнэ давхардсан (мөр ${first})` });
      else seen.set(dup, index);
      return { item, key };
    });
    if (issues.length > 0) {
      throw new DomainError('BASE_PRICE_IMPORT_INVALID', `Импорт няцаагдлаа: ${issues.length} мөрөнд алдаа байна. Ямар ч мөр хадгалагдаагүй`, HttpStatus.UNPROCESSABLE_ENTITY, {
        issues: issues.slice(0, MAX_REPORTED_ISSUES),
        totalIssues: issues.length,
      });
    }

    const rows = items.flatMap((x) => (x ? [x] : []));
    const assetTypes = [...new Set(rows.map((x) => x.item.assetType))].sort();
    const byAssetType: Record<string, number> = {};
    const created = await this.repo.transaction(
      async (tx) => {
        let total = 0;
        for (const assetType of assetTypes) {
          await advisoryLock(tx, 'base_price', ctx.orgId, assetType); // sorted → no lock-order deadlock between two imports
          const next = new Map((await this.repo.maxVersionsByKey(tx, ctx.orgId, assetType)).map((m) => [stableKey(m.key_json), m.max_version]));
          const data = rows
            .filter((x) => x.item.assetType === assetType)
            .map(({ item, key }) => {
              const id = stableKey(key);
              const version = (next.get(id) ?? 0) + 1;
              next.set(id, version);
              return { orgId: ctx.orgId, assetType, key, unitPrice: item.unitPrice, validFrom: dbDate(item.validFrom), version, createdBy: ctx.userId };
            });
          byAssetType[assetType] = await this.repo.createMany(tx, data);
          total += byAssetType[assetType];
        }
        return total;
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
    this.logger.log(`base_price_imported count=${created}`);
    return { created, byAssetType };
  }

  private problemOf(item: BasePriceInput): Pick<ImportIssue, 'code' | 'message'> | null {
    if (!keyMatchesAssetType(item.assetType, item.key)) return { code: 'BASE_PRICE_KEY_MISMATCH', message: KEY_MISMATCH_MESSAGE };
    if (!isRealIsoDate(item.validFrom)) return { code: 'BASE_PRICE_DATE_INVALID', message: DATE_INVALID_MESSAGE };
    return null;
  }

  private validate(item: BasePriceInput): void {
    const p = this.problemOf(item);
    if (p?.code === 'BASE_PRICE_KEY_MISMATCH') throw new DomainError(p.code, p.message, HttpStatus.UNPROCESSABLE_ENTITY);
    if (p) throw new DomainError('VALIDATION_FAILED', 'Оруулсан өгөгдөл буруу', HttpStatus.BAD_REQUEST, [{ path: 'validFrom', message: p.message }]);
  }
}
