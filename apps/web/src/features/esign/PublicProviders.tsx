'use client';

import { useState, type ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { ConfigProvider } from 'antd';
import mnMN from 'antd/locale/mn_MN';
import { createEsignQueryClient } from './query';

// Гар утсанд зориулсан том үсэг, том товч. layout.tsx-д provider байхгүй тул хуудас бүр өөрийн QueryClient-тэй.
const THEME = { token: { fontSize: 16, controlHeightLG: 52, borderRadius: 10 } } as const;

export function PublicProviders({ children }: { children: ReactNode }) {
  const [client] = useState(createEsignQueryClient);
  return (
    <QueryClientProvider client={client}>
      <ConfigProvider locale={mnMN} theme={THEME}>
        {children}
      </ConfigProvider>
    </QueryClientProvider>
  );
}
