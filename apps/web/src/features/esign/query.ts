import { QueryClient } from '@tanstack/react-query';
import { EsignApiError } from './api';

const MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 4_000;

/** Зөвхөн түр алдаа (сүлжээ, 5xx)-г дахин оролдоно. 404/410/429/буруу хариуг давтахгүй. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  return failureCount < MAX_RETRIES && error instanceof EsignApiError && (error.kind === 'NETWORK' || error.kind === 'SERVER');
}

export function retryDelay(attempt: number): number {
  return Math.min(1_000 * 2 ** attempt, MAX_RETRY_DELAY_MS);
}

/** Хуудас бүр өөрийн QueryClient-тэй (layout.tsx-д provider байхгүй). */
export function createEsignQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetry, retryDelay, refetchOnWindowFocus: true, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

/** Mutation/query-ийн ямар ч алдааг EsignApiError болгоно (жишээ нь локал zod шалгалт) */
export function toApiError(err: unknown): EsignApiError {
  return err instanceof EsignApiError ? err : new EsignApiError('INVALID_REQUEST');
}

export const sessionKey = (token: string) => ['esign', 'session', token] as const;
