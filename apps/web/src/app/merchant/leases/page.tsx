import { Suspense } from 'react';
import { LeaseList } from '../../../features/merchant/leases/LeaseList';

export default function MerchantLeasesPage() {
  return (
    <Suspense fallback={null}>
      <LeaseList />
    </Suspense>
  );
}
