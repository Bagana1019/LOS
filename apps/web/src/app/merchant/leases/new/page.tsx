import { Suspense } from 'react';
import { NewLeaseForm } from '../../../../features/merchant/leases/NewLeaseForm';

export default function NewLeasePage() {
  return (
    <Suspense fallback={null}>
      <NewLeaseForm />
    </Suspense>
  );
}
