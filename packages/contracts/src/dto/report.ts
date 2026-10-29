import { z } from 'zod';
import { AgingBucket, ReportKey } from '../enums';

// FR-13.3: 9 зээлийн тайлан (+ Excel), docs/01 §2.1. Dashboard = тайлангийн нэгтгэл (KPI).

/** YYYY-MM-DD бөгөөд бодит календарийн өдөр (2026-02-31 гэх мэтийг няцаана). */
const isRealDate = (s: string): boolean => {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD форматтай байх ёстой').refine(isRealDate, 'Огноо буруу байна');

export const ReportColumnType = z.enum(['string', 'number', 'money', 'date', 'percent', 'status']);
// Баганы утгын гэрээ:
//  · money   — number (2 орон), валют нь мөрийн `currency` баганад;
//  · percent — харьцаа (0.25 = 25%), UI/Excel нь ×100 хийж харуулна;
//  · date    — 'YYYY-MM-DD' (Asia/Ulaanbaatar өдөр);
//  · status  — код (жишээ 'EXPIRING'); `options` байвал шошгыг тэндээс авна.
export const ReportColumn = z.object({
  key: z.string(),
  label: z.string(),
  type: ReportColumnType,
  width: z.number().optional(),
  sortable: z.boolean().optional(), // sortBy-д ашиглаж болох эсэх (whitelist)
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(), // status баганы код → шошго
});
export type ReportColumn = z.infer<typeof ReportColumn>;

export const ReportFilterDef = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(['text', 'date', 'select', 'number']),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
});
export type ReportFilterDef = z.infer<typeof ReportFilterDef>;

/** Тайлангийн өгөгдлийн эх сурвалж. 'core-mock' = Core-д холбогдоогүй, ЗОХИОМОЛ өгөгдөл (deposit-balances). */
export const ReportDataSource = z.enum(['origination', 'core-mock', 'core']);
export type ReportDataSource = z.infer<typeof ReportDataSource>;

export const ReportDefinitionView = z.object({
  key: z.enum(ReportKey),
  title: z.string(),
  description: z.string(),
  columns: z.array(ReportColumn),
  filters: z.array(ReportFilterDef),
  dataSource: ReportDataSource, // deposit-balances → Core (mock горимд 'core-mock', real горимд 'core')
  defaultSort: z.object({ sortBy: z.string(), sortDir: z.enum(['asc', 'desc']) }).optional(),
});
export type ReportDefinitionView = z.infer<typeof ReportDefinitionView>;

// FR-1.3: 10/20/50/100 хуудаслалт, багана эрэмбэлэх
export const ReportQuery = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().refine((n) => [10, 20, 50, 100].includes(n), { message: 'pageSize 10/20/50/100' }).default(20),
  sortBy: z.string().max(60).optional(),
  sortDir: z.enum(['asc', 'desc']).default('asc'),
  asOf: ymd.optional(), // хугацаа хэтрэлт/үлдэгдэл тооцох өдөр (Asia/Ulaanbaatar)
  dateFrom: ymd.optional(),
  dateTo: ymd.optional(),
  branchId: z.string().max(100).optional(),
  officerId: z.string().max(100).optional(),
  productId: z.string().max(100).optional(),
  currency: z.string().length(3).optional(),
  status: z.string().max(40).optional(), // утга нь тайлан бүрт өөр: filters[].options-ийг хар
  provider: z.string().max(40).optional(), // interest-payments: QPAY | SOCIALPAY | BANK_TRANSFER
  assetType: z.string().max(40).optional(), // collateral-assets: AssetType
  search: z.string().max(100).optional(), // регистр / гэрээний дугаар / нэр
});
export type ReportQuery = z.infer<typeof ReportQuery>;

/** Excel экспорт: хуудаслалтгүй (бүх шүүлттэй мөр). */
export const ReportExportQuery = ReportQuery.omit({ page: true, pageSize: true });
export type ReportExportQuery = z.infer<typeof ReportExportQuery>;

export const ReportRow = z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]));
export type ReportRow = z.infer<typeof ReportRow>;

export const ReportResult = z.object({
  key: z.enum(ReportKey),
  title: z.string(),
  columns: z.array(ReportColumn),
  rows: z.array(ReportRow),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  sortBy: z.string().optional(), // хэрэглэсэн эрэмбэ (анхдагч байсан ч)
  sortDir: z.enum(['asc', 'desc']).optional(),
  totals: z.record(z.number()).optional(), // money/number баганы нийлбэр (бүх шүүлттэй мөрөөр, хуудсаар биш)
  mixedCurrency: z.boolean().optional(), // true бол шүүлттэй мөрүүд олон валюттай тул totals өгөөгүй (валют холихгүй)
  dataSource: ReportDataSource.optional(), // 'core-mock' бол өгөгдөл ЗОХИОМОЛ (Core-оос биш) — UI заавал анхааруулна
  asOf: z.string(),
  generatedAt: z.string().datetime(),
});
export type ReportResult = z.infer<typeof ReportResult>;

const money = z.number();
export const DashboardQuery = z.object({
  currency: z.string().length(3).default('MNT'), // ханш байхгүй тул валют холихгүй (FR-5.4 = S)
  branchId: z.string().max(100).optional(),
  asOf: ymd.optional(),
});
export type DashboardQuery = z.infer<typeof DashboardQuery>;

export const DashboardSummary = z.object({
  asOf: z.string(),
  currency: z.string(),
  scope: z.object({ branchId: z.string().nullable(), officerId: z.string().nullable() }),
  applications: z.object({
    byStatus: z.array(z.object({ status: z.string(), count: z.number().int(), amount: money })),
    submittedThisMonth: z.number().int(),
    approvedThisMonth: z.number().int(),
    returnedThisMonth: z.number().int(),
    approvalRate: z.number().nullable(), // approved ÷ (approved + returned), энэ сар
    avgDecisionHours: z.number().nullable(), // submitted_at → approved_at/returned_at (сүүлийн 90 хоног)
  }),
  disbursements: z.object({
    thisMonthAmount: money,
    lastMonthAmount: money,
    thisMonthCount: z.number().int(),
    yearToDateAmount: money,
    monthly: z.array(z.object({ month: z.string(), amount: money, count: z.number().int() })), // сүүлийн 12 сар, хоосон сар 0-ээр
  }),
  portfolio: z.object({
    activeLoanCount: z.number().int(),
    outstandingPrincipal: money,
    overdueAmount: money,
    overdueLoanCount: z.number().int(),
    parRatio: z.number().nullable(), // PAR>0 = хугацаа хэтэрсэн зээлийн үлдэгдэл ÷ нийт үлдэгдэл
    aging: z.array(z.object({ bucket: z.enum(AgingBucket), loanCount: z.number().int(), principal: money })),
  }),
  collections: z.object({
    dueThisMonth: money,
    collectedThisMonth: money,
    collectionRate: z.number().nullable(),
    dueNext7Days: money,
  }),
  topProducts: z.array(z.object({ productId: z.string().nullable(), productName: z.string(), count: z.number().int(), amount: money })),
  generatedAt: z.string().datetime(),
});
export type DashboardSummary = z.infer<typeof DashboardSummary>;
