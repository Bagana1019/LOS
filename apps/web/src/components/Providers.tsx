'use client';

import '@ant-design/v5-patch-for-react-19';
import { useState, type ReactNode } from 'react';
import { AntdRegistry } from '@ant-design/nextjs-registry';
import { App as AntApp, ConfigProvider } from 'antd';
import mnMN from 'antd/locale/mn_MN';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '../lib/http';
import { AuthProvider } from '../lib/auth/auth-context';
import { antdTheme } from '../theme/brand';

// 4xx-г дахин оролдохгүй (эрх, баталгаажуулалт); сүлжээ/5xx-г 2 удаа.
const shouldRetry = (count: number, e: unknown) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && count < 2;

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: shouldRetry, staleTime: 30_000 } } }));
  return (
    <AntdRegistry>
      <ConfigProvider locale={mnMN} theme={antdTheme}>
        <AntApp>
          <QueryClientProvider client={client}>
            <AuthProvider>{children}</AuthProvider>
          </QueryClientProvider>
        </AntApp>
      </ConfigProvider>
    </AntdRegistry>
  );
}
