import type { DashboardSummary, ReportDefinitionView, ReportResult } from '@los/contracts';
import { apiDownload, apiFetch, qs } from '../../lib/api';
import type { QueryParams } from './reports.utils';

// Gateway-н замаар origination руу: `/reports…` (global prefix `api` нь API суурь URL-д орсон).
// ADMIN, OFFICER, BRANCH_MANAGER, APPROVER (CUSTOMER → 403). Хүрээг (NFR-3) сервер хэрэгжүүлнэ.
const enc = encodeURIComponent;

/** 9 тайлангийн тодорхойлолт (багана, шүүлт, dataSource, defaultSort). */
export const fetchReportDefinitions = (): Promise<ReportDefinitionView[]> => apiFetch<ReportDefinitionView[]>('/reports');

/** JSON хуудас. Алдаа: 404 REPORT_NOT_FOUND · 400 INVALID_FILTER|INVALID_SORT|INVALID_DATE_RANGE|VALIDATION_FAILED · 403 BRANCH_REQUIRED · 503/501 (deposit-balances, Core). */
export const fetchReport = (key: string, query: QueryParams): Promise<ReportResult> => apiFetch<ReportResult>(`/reports/${enc(key)}${qs(query)}`);

/** KPI dashboard (`DashboardQuery`: currency, branchId, asOf). */
export const fetchDashboard = (query: Record<string, string>): Promise<DashboardSummary> => apiFetch<DashboardSummary>(`/reports/dashboard/summary${qs(query)}`);

/** Excel (.xlsx). Хуудаслалтгүй (`ReportExportQuery`); 422 EXPORT_TOO_LARGE. Амжилттай бүр сервер талд `report_run` аудитад бичигдэнэ. */
export const downloadReport = (key: string, query: QueryParams, fallbackName: string): Promise<void> =>
  apiDownload(`/reports/${enc(key)}/export${qs(query)}`, fallbackName);
