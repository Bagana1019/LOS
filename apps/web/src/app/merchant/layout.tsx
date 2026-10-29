import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { MerchantProviders } from '../../features/merchant/providers';
import { MerchantShell } from '../../features/merchant/shell';

export const metadata: Metadata = { title: 'Мерчант портал · LOS Radix' };

// Мерчантын тусдаа shell (docs/05 §12): лизингийн байгууллагын цэс харагдахгүй.
export default function MerchantLayout({ children }: { children: ReactNode }) {
  return (
    <MerchantProviders>
      <MerchantShell>{children}</MerchantShell>
    </MerchantProviders>
  );
}
