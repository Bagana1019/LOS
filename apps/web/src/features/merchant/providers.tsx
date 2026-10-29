'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider } from 'antd';
import mnMN from 'antd/locale/mn_MN';
import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { t } from '../../lib/i18n';
import { shouldRetry } from './errors';
import './react19-compat';
import './merchant.css';
import { merchantTheme } from './theme';

const noopSubscribe = () => () => undefined;
/** Hydration-ы дараа true. Энэ портал нэвтэрсний дараах SPA тул antd-ийг зөвхөн клиент талд зурна (SSR-ийн style flash/mismatch байхгүй). */
const useMounted = () => useSyncExternalStore(noopSubscribe, () => true, () => false);

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 15_000, gcTime: 5 * 60_000, retry: shouldRetry, refetchOnWindowFocus: true },
      mutations: { retry: false },
    },
  });
}

/** Мерчант портал + back-office мерчант хуудсуудын нийтлэг provider: TanStack Query, antd ConfigProvider (mn_MN), App (message/modal context). */
export function MerchantProviders({ children }: { children: ReactNode }) {
  const [client] = useState(makeQueryClient);
  const mounted = useMounted();
  return (
    <div className="mp-root">
      {mounted ? (
        <QueryClientProvider client={client}>
          <ConfigProvider locale={mnMN} theme={merchantTheme}>
            <AntApp component={false}>{children}</AntApp>
          </ConfigProvider>
        </QueryClientProvider>
      ) : (
        <div className="mp-boot" role="status" aria-live="polite">{t('merchant.loading')}</div>
      )}
    </div>
  );
}
