import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import * as api from './reports.api';
import { retryTransient, type QueryParams } from './reports.utils';

// Query түлхүүр: ['reports', 'definitions'] · ['reports', 'run', key, query] · ['reports', 'dashboard', query].
export const reportKeys = {
  all: ['reports'] as const,
  definitions: ['reports', 'definitions'] as const,
  run: (key: string, query: QueryParams | null) => ['reports', 'run', key, query] as const,
  dashboard: (query: Record<string, string>) => ['reports', 'dashboard', query] as const,
};

/** Тодорхойлолт ховор өөрчлөгддөг (бүтээгдэхүүний каталог л) тул 5 минут кэшлэнэ. */
export function useReportDefinitions() {
  return useQuery({ queryKey: reportKeys.definitions, queryFn: api.fetchReportDefinitions, staleTime: 5 * 60_000, retry: retryTransient });
}

/** Шүүлт/хуудас солигдоход өмнөх хүснэгтийг хадгалж (frame-ийг үсрүүлэхгүй) шинэ өгөгдлийг татна. `query` null бол татахгүй. */
export function useReport(key: string, query: QueryParams | null) {
  return useQuery({
    queryKey: reportKeys.run(key, query),
    queryFn: () => api.fetchReport(key, query as QueryParams),
    enabled: query !== null,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    retry: retryTransient,
  });
}

export function useDashboard(query: Record<string, string>) {
  return useQuery({
    queryKey: reportKeys.dashboard(query),
    queryFn: () => api.fetchDashboard(query),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: retryTransient,
  });
}

/** Excel татах. Хөтөч дээр файл хадгалуулна; үр дүн нь void. */
export function useExportReport(key: string) {
  return useMutation({ mutationFn: (v: { query: QueryParams; fileName: string }) => api.downloadReport(key, v.query, v.fileName) });
}
