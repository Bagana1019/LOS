'use client';
import { useState, type ReactNode } from 'react';
import { App, ConfigProvider } from 'antd';
import mnMN from 'antd/locale/mn_MN';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '../errors';

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        // Client errors (403, 404, ...) will not fix themselves: do not retry them.
        retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
      },
    },
  });
}

/** The page owns its QueryClient (the root layout has no providers) plus antd locale and message context. */
export function AppProviders({ children }: { children: ReactNode }) {
  const [client] = useState(makeQueryClient);
  return (
    <QueryClientProvider client={client}>
      <ConfigProvider locale={mnMN}>
        <App>{children}</App>
      </ConfigProvider>
    </QueryClientProvider>
  );
}
