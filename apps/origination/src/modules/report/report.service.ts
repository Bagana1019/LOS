import { BadRequestException, GatewayTimeoutException, HttpException, HttpStatus, Inject, Injectable, NotFoundException, NotImplementedException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { ReportDefinitionView, ReportResult, type ReportExportQuery, type ReportQuery } from '@los/contracts';
import { maskRegisterNo } from '@los/database';
import { Clock } from '@los/nest-common';
import { IntegrationNotConfiguredError } from '../../shared/integration-mode';
import { Prisma } from '.prisma/client-origination';
import { PrismaService } from '../../prisma.service';
import type { RequestContext } from '@los/contracts';
import { OrgSettings } from '../../shared/org-settings';
import { CoreDepositNotImplementedError } from '../../integrations/core-deposit/core-deposit.errors';
import type { CoreDepositPort } from '../../integrations/core-deposit/core-deposit.port';
import { CORE_DEPOSIT_PORT } from '../../integrations/core-deposit/core-deposit.provider';
import { Semaphore, SemaphoreFullError } from './concurrency';
import { buildReportWorkbook } from './excel.exporter';
import { EXPORT_STATEMENT_TIMEOUT_MS, isStatementTimeout } from './report-db';
import { labelOf } from './report-labels';
import { ReportRegistry } from './report-registry';
import { effectiveScope, resolveReportScope, type ReportScope } from './report-scope';
import type { ReportDefinition, ReportInput, ReportRunResult, ResolvedFilters } from './report-types';
import { todayUB } from '../../shared/clock';

const DEFAULT_MAX_EXPORT_ROWS = 50_000;
/**
 * Нэгэн зэрэг боловсруулах экспортын тоо (процесс тутамд) ба хүлээх дараалал. Экспорт бүр мөрүүдийг санах ойд барьж, Prisma pool-ын холболт эзэлдэг тул
 * олон хүн зэрэг дарахад процесс санах ой/pool-оо барагдуулахгүй. Дараалал дүүрвэл 429 `EXPORT_BUSY`.
 */
export const EXPORT_CONCURRENCY = 2;
export const EXPORT_MAX_QUEUE = 4;
/** Монгол регистр: 2 үсэг + 8 цифр. */
const REGISTER_LIKE = /^\p{L}{2}\d{8}$/u;
type QueryLike = Partial<Omit<ReportQuery, 'page' | 'pageSize'>> & { page?: number; pageSize?: number };
type Paging = { page: number; pageSize: number; maxRows?: number; statementTimeoutMs?: number };
type Prepared = { def: ReportDefinition; input: ReportInput };

export interface ExportedReport { buffer: Buffer; filename: string; rowCount: number }

const bad = (code: string, message: string) => new BadRequestException({ code, message });

@Injectable()
export class ReportService {
  private readonly exportSlots = new Semaphore(EXPORT_CONCURRENCY, EXPORT_MAX_QUEUE);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly settings: OrgSettings,
    private readonly registry: ReportRegistry,
    @Inject(CORE_DEPOSIT_PORT) private readonly deposit: CoreDepositPort,
  ) {}

  /** GET reports — 9 тайлангийн тодорхойлолт. `productId` шүүлтэд бүтээгдэхүүний каталогийг сонголт болгоно. */
  async list(ctx: RequestContext): Promise<ReportDefinitionView[]> {
    const products = await this.prisma.product.findMany({ where: { orgId: ctx.orgId }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
    const options = products.map((p) => ({ value: p.id, label: p.name }));
    return this.registry.all().map((def) => ReportDefinitionView.parse({
      key: def.key, title: def.title, description: def.description, columns: def.columns,
      filters: def.filters.map((f) => (f.key === 'productId' && options.length ? { ...f, type: 'select', options } : f)),
      dataSource: def.dataSource({ deposit: this.deposit }),
      defaultSort: def.defaultSort,
    }));
  }

  /** GET reports/:key — JSON хуудас. Excel-тэй ижил `run`. */
  async run(ctx: RequestContext, key: string, query: ReportQuery): Promise<ReportResult> {
    const { def, input } = this.prepare(ctx, key, query, { page: query.page, pageSize: query.pageSize });
    const res = await this.execute(def, input);
    return ReportResult.parse({
      key: def.key, title: def.title, columns: def.columns, rows: res.rows, total: res.total, page: input.page, pageSize: input.pageSize,
      sortBy: input.sortBy, sortDir: input.sortDir, ...(res.totals ? { totals: res.totals } : {}), ...(res.mixedCurrency ? { mixedCurrency: true } : {}),
      dataSource: def.dataSource({ deposit: this.deposit }), asOf: input.filters.asOf, generatedAt: this.clock.now().toISOString(),
    });
  }

  /**
   * GET reports/:key/export — .xlsx. Мөрийн тоо `report.max_export_rows`-оос хэтэрвэл 422 (мөр уншихаас ӨМНӨ, нийт тоогоор шалгана).
   * NFR-4/5: экспорт нь хувийн мэдээлэл гаргах үйлдэл тул `report_run` аудит амжилтгүй бол файл өгөхгүй.
   * Ачаалал: нэгэн зэрэг EXPORT_CONCURRENCY экспорт (бусад нь дараалалд, дараалал дүүрвэл 429), Excel streaming writer-ээр бичигдэнэ.
   * `core-mock` (зохиомол) өгөгдөлтэй тайлан production-д экспортлогдохгүй; бусад орчинд файлд "ЗОХИОМОЛ (MOCK)" гэж тэмдэглэгдэнэ.
   */
  async export(ctx: RequestContext, key: string, query: ReportExportQuery): Promise<ExportedReport> {
    const max = await this.maxExportRows(ctx.orgId);
    const prepared = this.prepare(ctx, key, query, { page: 1, pageSize: max + 1, maxRows: max, statementTimeoutMs: EXPORT_STATEMENT_TIMEOUT_MS });
    const dataSource = prepared.def.dataSource({ deposit: this.deposit });
    if (dataSource === 'core-mock' && process.env.NODE_ENV === 'production') {
      // 501: web `apiDownload` нь алдааны биеийг уншдаггүй, статусаас кодыг сэргээдэг (501 = INTEGRATION_NOT_IMPLEMENTED)
      throw new NotImplementedException({ code: 'INTEGRATION_NOT_IMPLEMENTED', message: 'Энэ тайлангийн өгөгдөл Core-оос биш (mock) тул production орчинд экспортлох боломжгүй. Core интеграци (INTEGRATION_MODE=real) хэрэгжсэний дараа боломжтой болно' });
    }
    try {
      return await this.exportSlots.run(() => this.buildExport(ctx, prepared, max, dataSource));
    } catch (e) {
      if (e instanceof SemaphoreFullError) throw new HttpException({ code: 'EXPORT_BUSY', message: 'Одоогоор олон экспорт боловсруулагдаж байна. Түр хүлээгээд дахин оролдоно уу' }, HttpStatus.TOO_MANY_REQUESTS);
      throw e;
    }
  }

  private async buildExport(ctx: RequestContext, { def, input }: Prepared, max: number, dataSource: ReportDefinitionView['dataSource']): Promise<ExportedReport> {
    const res = await this.execute(def, input);
    if (res.total > max) {
      throw new UnprocessableEntityException({ code: 'EXPORT_TOO_LARGE', message: `Экспортлох мөрийн тоо (${res.total}) зөвшөөрөгдсөн дээд хэмжээ (${max})-ээс хэтэрсэн тул шүүлтээ нарийсгана уу` });
    }
    const generatedAt = this.clock.now().toISOString();
    const buffer = await buildReportWorkbook(def.columns, res.rows, res.totals, {
      title: def.title, asOf: input.filters.asOf, generatedAt, filterLines: await this.filterLines(ctx, def, input.filters), mixedCurrency: !!res.mixedCurrency, dataSource,
    });
    const f = input.filters;
    await this.prisma.reportRun.create({
      data: {
        orgId: ctx.orgId, reportKey: def.key, format: 'XLSX', rowCount: res.rows.length, runBy: ctx.userId,
        paramsJson: {
          query: { ...f, search: f.search ? maskRegisterNo(f.search) : null, sortBy: input.sortBy, sortDir: input.sortDir },
          scope: { branchId: input.scope.branchId, officerId: input.scope.officerId },
          dataSource, // 'core-mock' = Excel зохиомол өгөгдөлтэй (аудитаар хойно ялгах)
          registerMasked: true, // Excel-д регистр нуугдмал (maskRegisterNo), бусад талбар бүтнээрээ (decisions)
        } as Prisma.InputJsonValue,
      },
    });
    return { buffer, filename: `LOS_${def.key}_${f.asOf.replace(/-/g, '')}.xlsx`, rowCount: res.rows.length };
  }

  // ── дотоод ──

  private async maxExportRows(orgId: string): Promise<number> {
    const v = Number(await this.settings.get(orgId, 'report.max_export_rows'));
    return Number.isInteger(v) && v > 0 ? v : DEFAULT_MAX_EXPORT_ROWS;
  }

  /** Хүрээ (NFR-3), шүүлт, эрэмбийг баталгаажуулж `ReportInput` болгоно. Тайланд хамаагүй шүүлтийг үл тооно. */
  private prepare(ctx: RequestContext, key: string, q: QueryLike, paging: Paging): Prepared {
    const def = this.registry.get(key);
    if (!def) throw new NotFoundException({ code: 'REPORT_NOT_FOUND', message: 'Тайлан олдсонгүй' });
    const scope: ReportScope = resolveReportScope(ctx);
    const declared = new Map(def.filters.map((f) => [f.key, f]));

    const select = (name: 'status' | 'provider' | 'assetType'): string | null => {
      const v = q[name];
      const filter = declared.get(name);
      if (!v || !filter) return null;
      if (!filter.options?.some((o) => o.value === v)) throw bad('INVALID_FILTER', `"${filter.label}" шүүлтийн утга буруу: ${v}`);
      return v;
    };
    const dateFrom = declared.has('dateFrom') ? q.dateFrom ?? null : null;
    const dateTo = declared.has('dateTo') ? q.dateTo ?? null : null;
    if (dateFrom && dateTo && dateFrom > dateTo) throw bad('INVALID_DATE_RANGE', 'Эхлэх огноо дуусах огнооноос хойно байж болохгүй');

    const eff = effectiveScope(scope, q);
    const filters: ResolvedFilters = {
      asOf: q.asOf ?? todayUB(this.clock), dateFrom, dateTo, branchId: eff.branchId, officerId: eff.officerId,
      productId: declared.has('productId') ? q.productId || null : null,
      currency: declared.has('currency') && q.currency ? q.currency.toUpperCase() : null,
      status: select('status'), provider: select('provider'), assetType: select('assetType'),
      search: declared.has('search') && q.search?.trim() ? q.search.trim() : null,
    };

    let sortBy = def.defaultSort.sortBy;
    let sortDir: 'asc' | 'desc' = def.defaultSort.sortDir;
    if (q.sortBy) {
      if (!def.columns.some((c) => c.key === q.sortBy && c.sortable)) throw bad('INVALID_SORT', `"${q.sortBy}" баганаар эрэмбэлэх боломжгүй`);
      sortBy = q.sortBy;
      sortDir = q.sortDir ?? 'asc';
    }
    return { def, input: { scope, filters, sortBy, sortDir, ...paging } };
  }

  /** Core интеграцийн тохиргоо/хэрэгжилтийн алдааг ойлгомжтой HTTP хариу болгоно. */
  private async execute(def: ReportDefinition, input: ReportInput): Promise<ReportRunResult> {
    try {
      return await def.run({ prisma: this.prisma, deposit: this.deposit }, input);
    } catch (e) {
      if (e instanceof IntegrationNotConfiguredError) throw new ServiceUnavailableException({ code: 'INTEGRATION_NOT_CONFIGURED', message: 'Core интеграци тохируулагдаагүй тул энэ тайланг гаргах боломжгүй байна' });
      if (e instanceof CoreDepositNotImplementedError) throw new NotImplementedException({ code: 'INTEGRATION_NOT_IMPLEMENTED', message: e.message });
      if (isStatementTimeout(e)) throw new GatewayTimeoutException({ code: 'REPORT_TIMEOUT', message: 'Тайлан бэлтгэхэд хэт удаан байна. Шүүлтээ нарийсгаад дахин оролдоно уу' });
      throw e;
    }
  }

  /** Excel-ийн "Шүүлт" мөр: тайланд хамаарах, утгатай шүүлтүүд. */
  private async filterLines(ctx: RequestContext, def: ReportDefinition, f: ResolvedFilters): Promise<string[]> {
    const products = def.filters.some((x) => x.key === 'productId') && f.productId
      ? await this.prisma.product.findMany({ where: { orgId: ctx.orgId, id: f.productId }, select: { id: true, name: true } })
      : [];
    const lines: string[] = [];
    for (const filter of def.filters) {
      if (filter.key === 'asOf') continue; // тусдаа мөрөнд
      const value = (f as unknown as Record<string, string | null>)[filter.key];
      if (!value) continue;
      // Регистр хэлбэртэй хайлтыг Excel-ийн толгойд ч нуулна (NFR-5)
      const shown = filter.key === 'productId' ? products.find((p) => p.id === value)?.name ?? value
        : filter.key === 'search' && REGISTER_LIKE.test(value) ? maskRegisterNo(value) : labelOf(filter.options, value);
      lines.push(`${filter.label} = ${shown}`);
    }
    return lines;
  }
}
