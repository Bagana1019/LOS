import { QueryClient } from '@tanstack/react-query';
import { SigningApiError } from './api';

/** Ажилтны самбар өөрийн QueryClient-тэй (wizard-д provider байхгүй байж болно). Түр алдааг л давтана. */
export function createPanelQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (count, error) => count < 2 && error instanceof SigningApiError && (error.kind === 'NETWORK' || error.kind === 'SERVER'),
        refetchOnWindowFocus: true,
        staleTime: 0,
      },
      mutations: { retry: false },
    },
  });
}

export const panelKey = (applicationId: string) => ['contract-signing', applicationId] as const;

export function toSigningApiError(err: unknown): SigningApiError {
  return err instanceof SigningApiError ? err : new SigningApiError('INVALID_REQUEST');
}
