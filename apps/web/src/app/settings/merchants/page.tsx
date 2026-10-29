import { Suspense } from 'react';
import { MerchantList } from '../../../features/merchant/backoffice/MerchantList';

export default function MerchantsPage() {
  return (
    <Suspense fallback={null}>
      <MerchantList />
    </Suspense>
  );
}
