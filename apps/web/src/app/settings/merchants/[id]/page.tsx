import { Suspense } from 'react';
import { MerchantDetail } from '../../../../features/merchant/backoffice/MerchantDetail';

export default async function MerchantDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense fallback={null}>
      <MerchantDetail id={id} />
    </Suspense>
  );
}
