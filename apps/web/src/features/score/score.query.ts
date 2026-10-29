import { keepPreviousData, queryOptions } from '@tanstack/react-query';
import type { ScoreTerms } from '@los/contracts';
import * as api from './score.api';
import { termsKey } from './score.utils';

// Query түлхүүр: ['score', applicationId, 'overview'] · ['score', applicationId, 'preview', <terms>].
// Preview-ийн түлхүүр нь slider-ийн утгыг агуулдаг тул "latest wins" автоматаар: observer зөвхөн одоогийн түлхүүрийн үр дүнг үзүүлнэ,
// өмнөх утгын хоцорсон хариу харагдахгүй (мөн өмнөх хүсэлтийн AbortSignal цуцлагдана).
export const scoreRootKey = (applicationId: string) => ['score', applicationId] as const;
export const overviewKey = (applicationId: string) => [...scoreRootKey(applicationId), 'overview'] as const;
export const previewRootKey = (applicationId: string) => [...scoreRootKey(applicationId), 'preview'] as const;
export const previewKey = (applicationId: string, terms: ScoreTerms | null) => [...previewRootKey(applicationId), termsKey(terms)] as const;

/** 4xx (эрх, олдсонгүй, дүрмийн зөрчил) дахин оролдсоноор засагдахгүй. Сүлжээ/серверийн алдааг л нэг удаа дахин оролдоно. */
export const retryTransient = (failureCount: number, error: unknown): boolean => {
  const status = (error as { status?: unknown } | null)?.status;
  return failureCount < 1 && !(typeof status === 'number' && status < 500);
};

export const overviewQueryOptions = (applicationId: string) =>
  queryOptions({
    queryKey: overviewKey(applicationId),
    queryFn: ({ signal }) => api.fetchScoreOverview(applicationId, signal),
    retry: retryTransient,
    // Орлого/барьцаа/нөхцөл өөр алхамд өөрчлөгдөж болох тул алхам нээх бүрд шинэчилнэ (кэш зөвхөн хүлээлтэд)
    staleTime: 0,
  });

export type PreviewFetcher = typeof api.previewScore;

/** `terms` null эсвэл `enabled=false` бол хүсэлт явуулахгүй. Өмнөх утгын үр дүнг (placeholder) шинэ үр дүн ирэх хүртэл хадгална. */
export const previewQueryOptions = (applicationId: string, terms: ScoreTerms | null, enabled: boolean, fetcher: PreviewFetcher = api.previewScore) =>
  queryOptions({
    queryKey: previewKey(applicationId, terms),
    queryFn: ({ signal }) => fetcher(applicationId, api.previewBody(terms as ScoreTerms), signal),
    enabled: enabled && terms !== null,
    placeholderData: keepPreviousData,
    staleTime: 0,
    gcTime: 60_000,
    retry: retryTransient,
  });
