import type { ReportColumn, ReportFilterDef, ReportKey, ReportRow } from '@los/contracts';
import type { CoreDepositPort } from '../../integrations/core-deposit/core-deposit.port';
import type { PrismaService } from '../../prisma.service';
import type { ReportScope } from './report-scope';

/** Тайлан бүрийн шүүлтийн бүрэн, баталгаажсан хэлбэр (хүрээ нийлүүлсэн). */
export interface ResolvedFilters {
  asOf: string;
  dateFrom: string | null;
  dateTo: string | null;
  branchId: string | null;
  officerId: string | null;
  productId: string | null;
  currency: string | null;
  status: string | null;
  provider: string | null;
  assetType: string | null;
  search: string | null;
}

export interface ReportInput {
  scope: ReportScope;
  filters: ResolvedFilters;
  sortBy: string;
  sortDir: 'asc' | 'desc';
  page: number;
  pageSize: number;
  /**
   * Экспортын хамгаалалт: шүүлттэй нийт мөр `maxRows`-оос их бол мөр УНШИХГҮЙ (нийт тоог л буцаана) — татгалзах нь хямд байх ёстой.
   * Тохируулаагүй бол энгийн хуудаслалт.
   */
  maxRows?: number;
  /** DB-ийн `statement_timeout` (мс). Тохируулаагүй бол REPORT_STATEMENT_TIMEOUT_MS. */
  statementTimeoutMs?: number;
}

export interface ReportRunResult {
  rows: ReportRow[];
  /** Шүүлттэй нийт мөр (хуудсаар биш). */
  total: number;
  /** Нийлбэр (money/number баганууд, бүх шүүлттэй мөрөөр). Олон валюттай бол өгөхгүй. */
  totals?: Record<string, number>;
  mixedCurrency?: boolean;
}

export interface ReportDeps {
  prisma: PrismaService;
  deposit: CoreDepositPort;
}

export interface ReportDefinition {
  key: ReportKey;
  title: string;
  description: string;
  columns: ReportColumn[];
  filters: ReportFilterDef[];
  defaultSort: { sortBy: string; sortDir: 'asc' | 'desc' };
  /** Excel-ийн нийлбэр мөр, ReportResult.totals-д орох баганууд. */
  totalKeys: string[];
  dataSource(deps: Pick<ReportDeps, 'deposit'>): 'origination' | 'core-mock' | 'core';
  run(deps: ReportDeps, input: ReportInput): Promise<ReportRunResult>;
}
