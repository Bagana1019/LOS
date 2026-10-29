import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { MerchantProviders } from '../../../features/merchant/providers';

export const metadata: Metadata = { title: 'POS лизинг · LOS Radix' };

export default function PosLeasesLayout({ children }: { children: ReactNode }) {
  return <MerchantProviders>{children}</MerchantProviders>;
}
