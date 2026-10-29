import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { MerchantProviders } from '../../../features/merchant/providers';

export const metadata: Metadata = { title: 'Мерчант · Тохиргоо · LOS Radix' };

// Зөвхөн provider нэмнэ; лизингийн байгууллагын навигацийн shell өөр thread-ийн хариуцлага.
export default function MerchantSettingsLayout({ children }: { children: ReactNode }) {
  return <MerchantProviders>{children}</MerchantProviders>;
}
