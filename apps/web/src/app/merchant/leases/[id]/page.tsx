import { Suspense } from 'react';
import { LeaseDetail } from '../../../../features/merchant/leases/LeaseDetail';

export default async function MerchantLeaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense fallback={null}>
      <LeaseDetail id={id} />
    </Suspense>
  );
}
